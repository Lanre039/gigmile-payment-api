import { Request, Response, NextFunction } from 'express';

/** Minimal shape of a node-postgres error we care about here. */
interface PgError extends Error {
  code?: string;
}

function isPgError(err: unknown): err is PgError {
  return err instanceof Error && 'code' in err;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  req.log?.error({ err }, 'unhandled error');

  // Postgres unique_violation as a defence-in-depth safety net (the
  // ON CONFLICT DO NOTHING in paymentService already handles the
  // expected idempotency case at the application level).
  if (isPgError(err) && err.code === '23505') {
    res.status(409).json({
      status: 'error',
      message: 'Duplicate transaction_reference',
    });
    return;
  }

  res.status(500).json({
    status: 'error',
    message: 'Internal server error',
  });
}
