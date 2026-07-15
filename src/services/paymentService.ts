import { withTransaction } from '../db/pool';
import { PaymentPayload } from '../validators/paymentSchema';
import { ApplyPaymentResult, DuplicatePaymentRecord } from '../types';

interface InsertRow {
  transaction_reference: string;
}

interface UpdateRow {
  id: number;
  balance_before: string;
  balance_after: string;
  status: string;
}

/**
 * Apply a single payment notification to a customer's asset-deployment
 * balance.
 *
 * Guarantees:
 *  - Exactly-once application per transaction_reference, even if this
 *    function is called multiple times for the same payload (bank/queue
 *    retries). Enforced by the DB unique constraint, not app-level checks.
 *  - No lost updates when two payments for the same customer arrive at
 *    the same time. Enforced by `SELECT ... FOR UPDATE` locking the
 *    asset_deployments row for the duration of the DB transaction, so
 *    concurrent requests are serialized by Postgres itself rather than
 *    by any in-memory lock (which would not work once there is more
 *    than one API/worker process).
 */
export async function applyPayment(payload: PaymentPayload): Promise<ApplyPaymentResult> {
  const {
    customer_id: customerCode,
    payment_status: paymentStatus,
    transaction_amount: amount,
    transaction_date: transactionDate,
    transaction_reference: reference,
  } = payload;

  return withTransaction(async (client): Promise<ApplyPaymentResult> => {
    // 1. Idempotent insert. If this reference has been seen before, the
    //    INSERT is a no-op (rowCount 0) and we short-circuit - the
    //    payment is NOT re-applied.
    const insertResult = await client.query<InsertRow>(
      `INSERT INTO payment_transactions
         (transaction_reference, customer_code, payment_status,
          transaction_amount, transaction_date, processing_status)
       VALUES ($1, $2, $3, $4, $5, 'PENDING')
       ON CONFLICT (transaction_reference) DO NOTHING
       RETURNING transaction_reference`,
      [reference, customerCode, paymentStatus, amount, transactionDate]
    );

    if (insertResult.rowCount === 0) {
      const existing = await client.query<DuplicatePaymentRecord>(
        `SELECT transaction_reference, processing_status, balance_before,
                balance_after, overpayment_amount
         FROM payment_transactions
         WHERE transaction_reference = $1`,
        [reference]
      );
      return { outcome: 'DUPLICATE', record: existing.rows[0] };
    }

    // 2. Only a completed transfer moves money against the balance.
    //    Anything else (PENDING, FAILED, REVERSED, ...) is recorded for
    //    audit but intentionally not applied.
    if (paymentStatus.toUpperCase() !== 'COMPLETE') {
      await client.query(
        `UPDATE payment_transactions
         SET processing_status = 'IGNORED', processed_at = now()
         WHERE transaction_reference = $1`,
        [reference]
      );
      return {
        outcome: 'IGNORED',
        reason: `payment_status "${paymentStatus}" is not applied to balance`,
      };
    }

    // 3. Lock the customer's active deployment row and update it in the
    //    same statement. old_balance is captured from the locked row
    //    *before* the arithmetic, so overpayment can be computed
    //    correctly even though outstanding_balance itself is clamped at 0.
    const updateResult = await client.query<UpdateRow>(
      `WITH locked AS (
         SELECT ad.id, ad.outstanding_balance AS old_balance
         FROM asset_deployments ad
         JOIN customers c ON c.id = ad.customer_id
         WHERE c.customer_code = $2 AND ad.status = 'ACTIVE'
         FOR UPDATE OF ad
       )
       UPDATE asset_deployments ad
       SET outstanding_balance = GREATEST(locked.old_balance - $1, 0),
           amount_paid = ad.amount_paid + $1,
           status = CASE WHEN locked.old_balance - $1 <= 0 THEN 'COMPLETED' ELSE ad.status END,
           completed_at = CASE WHEN locked.old_balance - $1 <= 0 THEN now() ELSE ad.completed_at END,
           updated_at = now()
       FROM locked
       WHERE ad.id = locked.id
       RETURNING ad.id, locked.old_balance AS balance_before,
                 ad.outstanding_balance AS balance_after, ad.status`,
      [amount, customerCode]
    );

    if (updateResult.rowCount === 0) {
      // Unknown customer_id, or their asset is already fully repaid.
      // Held for manual reconciliation instead of being silently dropped.
      await client.query(
        `UPDATE payment_transactions
         SET processing_status = 'UNAPPLIED', processed_at = now(),
             error_reason = 'no ACTIVE asset_deployment found for customer_code'
         WHERE transaction_reference = $1`,
        [reference]
      );
      return {
        outcome: 'UNAPPLIED',
        reason: 'no active asset deployment found for this customer',
      };
    }

    const row = updateResult.rows[0];
    const balanceBefore = Number(row.balance_before);
    const balanceAfter = Number(row.balance_after);
    const overpayment = Math.max(amount - balanceBefore, 0);

    await client.query(
      `UPDATE payment_transactions
       SET processing_status = 'APPLIED', asset_deployment_id = $2,
           balance_before = $3, balance_after = $4,
           overpayment_amount = $5, processed_at = now()
       WHERE transaction_reference = $1`,
      [reference, row.id, balanceBefore, balanceAfter, overpayment]
    );

    return {
      outcome: 'APPLIED',
      asset_deployment_id: row.id,
      balance_before: balanceBefore,
      balance_after: balanceAfter,
      deployment_status: row.status,
      overpayment_amount: overpayment,
    };
  });
}
