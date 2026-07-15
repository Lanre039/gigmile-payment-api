# Asset Payment API (TypeScript)

REST API that receives customer payment notifications (bank transfers into
a virtual account) and applies them to a mobility entrepreneur's
outstanding asset balance.

TypeScript throughout: `src/**/*.ts`, compiled with `tsc` for production
(`npm run build && npm start`) or run directly in development with `tsx`
(`npm run dev`). Domain types live in `src/types/index.ts` and
`src/validators/paymentSchema.ts` (the payload type is inferred straight
from the Zod schema via `z.infer`, so validation rules and the TS type can
never drift apart).

## Approach, briefly

**Data model.** Three tables: `customers`, `asset_deployments` (one row per
asset given out — value, term in weeks, running `outstanding_balance` /
`amount_paid`, status), and `payment_transactions` (an insert-only ledger
of every notification received, whether or not it was actually applied).
Keeping the ledger separate from the balance means every payment is
auditable and the balance itself is always a fast, single-row read.

**Idempotency first.** At 100k notifications/minute, retries are a
certainty — payment gateways retry on timeout, load balancers retry on
5xx, and a queue-based consumer can redeliver a message. `transaction_reference`
is treated as the idempotency key: it's the table's `PRIMARY KEY`, and the
insert uses `INSERT ... ON CONFLICT (transaction_reference) DO NOTHING`.
If the insert reports zero rows affected, the payment has already been
processed and the request returns the existing outcome rather than
re-applying it. This guarantee lives in the database, not in application
memory, so it holds even with many API/worker instances running at once.

**No read-then-write races.** The balance update is a single SQL statement
(a CTE with `SELECT ... FOR UPDATE` feeding an `UPDATE`) rather than "read
balance in app code, subtract, write back." Postgres locks the customer's
`asset_deployments` row for the life of the transaction, so two payments
landing for the same customer at the same instant are serialized by the
database itself — no lost updates, and no need for optimistic-lock
retry loops in application code.

**Only `COMPLETE` payments move the balance.** Other statuses are still
recorded (for audit/reconciliation) but marked `IGNORED`. Payments for an
unknown customer or an already-fully-repaid asset are marked `UNAPPLIED`
rather than silently dropped or crashing the request, so nothing requires
a human to dig through logs to find lost money.

**Two ingestion paths, same underlying service:**
| Endpoint | Behaviour | When to use |
|---|---|---|
| `POST /api/v1/payments` | Validates and applies the payment synchronously; response includes the new balance. | Simple, fully consistent, good up to a few thousand payments/sec with a tuned Postgres + PgBouncer. |
| `POST /api/v1/payments/webhook` | Validates the payload shape, pushes it onto a Redis-backed queue (BullMQ), returns `202` immediately. A separate worker pool (`src/queue/worker.ts`, run via `npm run worker`) drains the queue and calls the exact same `applyPayment()` service. | Recommended at sustained ~100k/minute (~1,700/sec) so the API tier absorbs bursts instead of back-pressuring the bank's webhook caller, and DB write concurrency can be tuned independently via worker count/concurrency. |

Both paths funnel into one `paymentService.applyPayment()`, so correctness
logic (idempotency, locking, status rules) is defined exactly once.

## Factors that shaped the design

- **100,000 notifications/minute (~1,667/sec sustained, likely bursty)**
  is the dominant constraint. It ruled out anything requiring an
  in-process lock or an app-level "check then update" balance pattern —
  those don't survive running more than one instance. It's also why the
  ledger table is hash-partitioned on `transaction_reference`: at this
  volume a single unpartitioned table's indexes become a bottleneck
  (index bloat, vacuum pressure), and partitioning by hash spreads writes
  evenly (unlike range-by-date, which would concentrate all of "now" in
  one hot partition).
- **A connection pooler (PgBouncer, transaction-pooling mode) is assumed
  in front of Postgres** — see `docker-compose.yml`. Postgres itself
  supports on the order of a few hundred real connections; at 1,700+
  requests/sec from many stateless API/worker instances, PgBouncer
  multiplexes short transactions onto a much smaller number of real
  backend connections.
- **Amounts as `NUMERIC(14,2)`.** Fine for this exercise; for a
  production financial ledger I'd store amounts as integer kobo
  (`BIGINT`) to eliminate any possibility of floating-point/decimal
  rounding drift entirely — flagged here rather than silently done, since
  it's a schema-level decision that's expensive to change later.
  `transaction_amount` arrives as a **string** in the payload; it's
  parsed and validated as a positive finite number before use.
  `transaction_date` is parsed as a naive local timestamp — worth
  confirming the timezone the bank/gateway sends (assumed WAT/UTC+1
  here) before going live.
  `transaction_date` is stored in the table used purely for
  partitioning/audit ordering; it does **not** participate in the
  idempotency key, since a retried webhook should be treated as a
  duplicate even if its timestamp differs slightly from the original.
- **Overpayments / final installment.** A payment that would push
  `outstanding_balance` below zero is clamped at zero and the asset is
  marked `COMPLETED`; the excess is recorded as `overpayment_amount` on
  the transaction row rather than discarded, since someone will need to
  decide what to do with it (refund, credit next asset, etc.) — that
  policy is a business decision this API surfaces rather than assumes.

## API

### `POST /api/v1/payments` (and `/payments/webhook`)

```json
{
  "customer_id": "GIGXXXXX",
  "payment_status": "COMPLETE",
  "transaction_amount": "10000",
  "transaction_date": "2025-11-07 14:54:16",
  "transaction_reference": "VPAY25110713542114478761522000"
}
```

Synchronous response (`200`):
```json
{
  "status": "ok",
  "result": {
    "outcome": "APPLIED",
    "asset_deployment_id": 1,
    "balance_before": 1000000,
    "balance_after": 990000,
    "deployment_status": "ACTIVE",
    "overpayment_amount": 0
  }
}
```

`outcome` is one of `APPLIED`, `DUPLICATE`, `IGNORED`, `UNAPPLIED`.
Async variant responds `202 { "status": "accepted" }` immediately; the
result above is what the worker computes when it processes the job.

### `GET /health`
Basic liveness/readiness check (pings Postgres).

## Running it

```bash
cp .env.example .env
docker compose up -d          # Postgres + Redis (+ optional PgBouncer)
npm install
npm run migrate               # applies sql/schema.sql
npm run typecheck             # tsc --noEmit
npm run build && npm start    # compiles to dist/ and runs it, API on :3000
# or, for local development without a build step:
npm run dev                   # tsx watch src/server.ts

npm run worker                # optional: only needed for the /webhook path
```

```bash
curl -X POST http://localhost:3000/api/v1/payments \
  -H "Content-Type: application/json" \
  -d '{
    "customer_id": "GIGXXXXX",
    "payment_status": "COMPLETE",
    "transaction_amount": "10000",
    "transaction_date": "2025-11-07 14:54:16",
    "transaction_reference": "VPAY25110713542114478761522000"
  }'
```

## Testing note

This sandbox has no network access, so a full `npm install` against the
real `express`/`pg`/`bullmq`/`ioredis` `@types` packages, or a live
Postgres instance, could not be run here. What *was* verified directly:
- **Full `tsc --noEmit` type-check of every file in `src/` and `tests/`**,
  run against the real `@types/node` and the real `zod` package (both were
  locally available), plus hand-written type-declaration stubs matching
  the exact API surface this project calls on `express`, `pg`, `helmet`,
  `pino-http`, `bullmq`, and `ioredis` — this caught, for example, that
  Express's error-handling middleware needs an explicit signature and
  that `req.log` (attached by `pino-http`) needed a module augmentation
  (see `src/types/express.d.ts`). It compiled clean (exit code 0).
- `tests/paymentSchema.test.ts` run with `tsx --test` against the real
  `zod` package — 4/4 passing, including the exact sample payload from
  the brief plus rejection of a non-positive amount, an unparsable date,
  and a missing reference.
- The SQL and the locking/idempotency logic in `paymentService.ts` were
  manually reviewed line-by-line against standard PostgreSQL 14+ syntax
  (`INSERT ... ON CONFLICT`, `WITH ... FOR UPDATE ... UPDATE ... FROM`,
  `PARTITION BY HASH`).

The hand-written stub types are **not** shipped in this package — real
`@types/express` and `@types/pg` (listed in `devDependencies`) will be
more complete than my stubs once `npm install` actually runs against the
registry, so `npm run typecheck` is worth re-running as the first step
with real infra.

## Scaling beyond this exercise

- Horizontal scaling: API and worker processes are stateless — scale
  by adding instances behind a load balancer / increasing worker
  concurrency, matched to observed Postgres write throughput.
- Read replicas for any reporting/analytics off `payment_transactions`
  so those queries never compete with the write path.
- Metrics on queue depth (BullMQ) and `UNAPPLIED`/`FAILED` counts, since
  those are the signals that something needs human reconciliation.
