/** A record already persisted from a previous, successful call for the same reference. */
export interface DuplicatePaymentRecord {
  transaction_reference: string;
  processing_status: string;
  balance_before: number | null;
  balance_after: number | null;
  overpayment_amount: number;
}

/** Discriminated union so callers must handle every outcome explicitly. */
export type ApplyPaymentResult =
  | { outcome: 'DUPLICATE'; record: DuplicatePaymentRecord }
  | { outcome: 'IGNORED'; reason: string }
  | { outcome: 'UNAPPLIED'; reason: string }
  | {
      outcome: 'APPLIED';
      asset_deployment_id: number;
      balance_before: number;
      balance_after: number;
      deployment_status: string;
      overpayment_amount: number;
    };
