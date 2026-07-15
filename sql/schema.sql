-- =====================================================================
-- Schema: Mobility Asset Financing - Payment Application
-- Engine : PostgreSQL 14+
-- =====================================================================

CREATE TABLE IF NOT EXISTS customers (
    id              BIGSERIAL PRIMARY KEY,
    customer_code   VARCHAR(20) UNIQUE NOT NULL,      -- e.g. GIGXXXXX
    full_name       VARCHAR(255),
    phone           VARCHAR(20),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per asset handed to an entrepreneur.
CREATE TABLE IF NOT EXISTS asset_deployments (
    id                      BIGSERIAL PRIMARY KEY,
    customer_id             BIGINT NOT NULL REFERENCES customers(id),
    asset_value             NUMERIC(14,2) NOT NULL,          -- e.g. 1,000,000.00
    term_weeks              INT NOT NULL,                    -- e.g. 50
    weekly_expected_amount  NUMERIC(14,2) NOT NULL,          -- asset_value / term_weeks
    outstanding_balance     NUMERIC(14,2) NOT NULL,
    amount_paid             NUMERIC(14,2) NOT NULL DEFAULT 0,
    status                  VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
                            CHECK (status IN ('ACTIVE','COMPLETED','DEFAULTED')),
    virtual_account_number  VARCHAR(20) UNIQUE NOT NULL,
    deployed_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at            TIMESTAMPTZ,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only one ACTIVE deployment per customer at a time (assumption).
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_deployment_per_customer
    ON asset_deployments (customer_id)
    WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_asset_customer ON asset_deployments(customer_id);

-- ---------------------------------------------------------------------
-- Payment ledger. Insert-only. transaction_reference is the idempotency
-- key: banks / payment gateways commonly retry webhook delivery, so the
-- unique constraint + ON CONFLICT DO NOTHING is what guarantees a
-- payment is applied exactly once no matter how many times it's posted.
--
-- Hash-partitioned on transaction_reference (rather than range on date):
-- this lets transaction_reference be a true, global UNIQUE/PRIMARY KEY
-- regardless of what transaction_date a retry happens to carry, while
-- still spreading 100k+ inserts/minute evenly across partitions so no
-- single partition/index becomes a hotspot.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_transactions (
    transaction_reference   VARCHAR(64) NOT NULL,
    customer_code           VARCHAR(20) NOT NULL,
    asset_deployment_id     BIGINT REFERENCES asset_deployments(id),
    payment_status          VARCHAR(20) NOT NULL,           -- status as received from the bank
    transaction_amount      NUMERIC(14,2) NOT NULL,
    transaction_date        TIMESTAMPTZ NOT NULL,
    processing_status       VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                            CHECK (processing_status IN
                                ('PENDING','APPLIED','IGNORED','UNAPPLIED','FAILED')),
    balance_before          NUMERIC(14,2),
    balance_after           NUMERIC(14,2),
    overpayment_amount      NUMERIC(14,2) NOT NULL DEFAULT 0,
    received_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at            TIMESTAMPTZ,
    error_reason            TEXT,
    PRIMARY KEY (transaction_reference)
) PARTITION BY HASH (transaction_reference);

CREATE INDEX IF NOT EXISTS idx_payment_customer_code ON payment_transactions(customer_code);

-- 8 partitions is a starting point; re-partition (or move to a bigger
-- modulus) as ledger volume grows.
DO $$
BEGIN
    FOR i IN 0..7 LOOP
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS payment_transactions_p%1$s
                PARTITION OF payment_transactions
                FOR VALUES WITH (MODULUS 8, REMAINDER %1$s)',
            i
        );
    END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- Seed data matching the sample payload in the brief.
-- ---------------------------------------------------------------------
INSERT INTO customers (customer_code, full_name, phone)
VALUES ('GIGXXXXX', 'Sample Rider', '+2348000000000')
ON CONFLICT (customer_code) DO NOTHING;

INSERT INTO asset_deployments
    (customer_id, asset_value, term_weeks, weekly_expected_amount,
     outstanding_balance, amount_paid, virtual_account_number)
SELECT id, 1000000.00, 50, 1000000.00/50, 1000000.00, 0, 'VA00000001'
FROM customers WHERE customer_code = 'GIGXXXXX'
ON CONFLICT DO NOTHING;
