/**
 * Standalone worker process. Run as many of these as needed
 * (`npm run worker`), scaled independently from the API tier, to match
 * consumption rate to Postgres's actual write capacity.
 */
import { Worker, Job } from 'bullmq';
import config from '../config';
import { PAYMENTS_QUEUE_NAME } from './queue';
import { applyPayment } from '../services/paymentService';
import { PaymentPayload } from '../validators/paymentSchema';
import { ApplyPaymentResult } from '../types';

const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '25', 10);

// Provide connection options instead of an ioredis instance to avoid
// type conflicts when multiple versions of ioredis are present.
const redisConnectionOptions = {
  url: config.redisUrl,
  maxRetriesPerRequest: null,
};

const worker = new Worker<PaymentPayload, ApplyPaymentResult>(
  PAYMENTS_QUEUE_NAME,
  async (job: Job<PaymentPayload>) => {
    const result = await applyPayment(job.data);
    return result;
  },
  { connection: redisConnectionOptions, concurrency: CONCURRENCY }
);

worker.on('completed', (job: Job<PaymentPayload>, result: ApplyPaymentResult) => {
  // eslint-disable-next-line no-console
  console.log(`[worker] ${job.data.transaction_reference} -> ${result.outcome}`);
});

worker.on('failed', (job: Job<PaymentPayload> | undefined, err: Error) => {
  // eslint-disable-next-line no-console
  console.error(`[worker] job ${job?.id} failed: ${err.message}`);
});

export default worker;
