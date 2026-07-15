import { Queue } from 'bullmq';
import config from '../config';
import { PaymentPayload } from '../validators/paymentSchema';

// Use plain connection options to avoid cross-package ioredis type conflicts
const connection = { url: config.redisUrl, maxRetriesPerRequest: null };

export const PAYMENTS_QUEUE_NAME = 'payments';

export const paymentsQueue = new Queue<PaymentPayload>(PAYMENTS_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 10000,
    removeOnFail: false, // keep failures around for the dead-letter/reconciliation view
  },
});

/**
 * Enqueue a validated payment payload for asynchronous processing.
 * jobId is set to the transaction_reference so BullMQ itself de-dupes
 * identical jobs still sitting in the queue (belt-and-braces on top of
 * the DB-level idempotency guarantee in paymentService).
 */
export async function enqueuePayment(payload: PaymentPayload): Promise<void> {
  await paymentsQueue.add('apply-payment', payload, {
    jobId: payload.transaction_reference,
  });
}
