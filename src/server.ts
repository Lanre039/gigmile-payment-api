import express, { Request, Response } from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import config from './config';
import paymentRoutes from './routes/paymentRoutes';
import { errorHandler } from './middleware/errorHandler';
import { pool } from './db/pool';

const app = express();

app.use(helmet());
app.use(express.json({ limit: '10kb' }));
app.use(pinoHttp());

app.get('/health', async (_req: Request, res: Response) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy' });
  }
});

app.use('/api/v1', paymentRoutes);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ status: 'error', message: 'Not found' });
});

app.use(errorHandler);

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`payment-api listening on port ${config.port}`);
});

export default app;
