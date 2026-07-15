import 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      // Attached by pino-http; kept loose here since we only ever call
      // req.log?.error(...) and don't depend on the rest of its shape.
      log?: {
        error: (obj: unknown, msg?: string) => void;
        [key: string]: unknown;
      };
    }
  }
}
