import { Request, Response, NextFunction } from 'express';
import { validatePaymentPayload } from '../validators/paymentSchema';
import { applyPayment } from '../services/paymentService';
import { enqueuePayment } from '../queue/queue';

/**
 * POST /api/v1/payments
 * Synchronous path: validates, applies the payment to the DB within
 * this request, and returns the resulting balance. Suitable as long as
 * (instances x throughput-per-instance) can cover incoming volume; see
 * README for the async/queued alternative for burst absorption.
 */
export async function receivePaymentSync(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const parsed = validatePaymentPayload(req.body);
    if (!parsed.success) {
      res.status(400).json({
        status: 'error',
        message: 'Invalid payment payload',
        errors: parsed.error.flatten(),
      });
      return;
    }

    const result = await applyPayment(parsed.data);
    res.status(200).json({ status: 'ok', result });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/payments/webhook
 * Async path: validates the payload shape only, pushes it onto a queue,
 * and returns 202 immediately. A separate worker pool (src/queue/worker.ts)
 * drains the queue and calls the exact same applyPayment() service.
 * Recommended entry point at sustained volumes around 100k
 * notifications/minute, since it lets the API tier absorb bursts without
 * back-pressuring the bank/gateway's webhook caller.
 */
export async function receivePaymentAsync(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const parsed = validatePaymentPayload(req.body);
    if (!parsed.success) {
      res.status(400).json({
        status: 'error',
        message: 'Invalid payment payload',
        errors: parsed.error.flatten(),
      });
      return;
    }

    await enqueuePayment(parsed.data);
    res.status(202).json({ status: 'accepted' });
  } catch (err) {
    next(err);
  }
}
