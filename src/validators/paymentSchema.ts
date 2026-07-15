import { z } from 'zod';

// Matches the payload shape from the brief:
// {
//   "customer_id": "GIGXXXXX",
//   "payment_status": "COMPLETE",
//   "transaction_amount": "10000",
//   "transaction_date": "2025-11-07 14:54:16",
//   "transaction_reference": "VPAY25110713542114478761522000"
// }
export const paymentPayloadSchema = z.object({
  customer_id: z.string().trim().min(3).max(20),
  payment_status: z.string().trim().min(1).max(20),
  transaction_amount: z
    .union([z.string(), z.number()])
    .transform((v) => Number(v))
    .refine((v) => Number.isFinite(v) && v > 0, {
      message: 'transaction_amount must be a positive number',
    }),
  transaction_date: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), {
      message: 'transaction_date must be a parseable date string',
    }),
  transaction_reference: z.string().trim().min(8).max(64),
});

/** Payload shape after validation/coercion (transaction_amount is a number here). */
export type PaymentPayload = z.infer<typeof paymentPayloadSchema>;

export function validatePaymentPayload(body: unknown) {
  return paymentPayloadSchema.safeParse(body);
}
