import 'dotenv/config';

export interface AppConfig {
  port: number;
  databaseUrl: string;
  pgPoolMax: number;
  pgIdleTimeoutMs: number;
  redisUrl: string;
  enableQueueWorker: boolean;
}

const config: AppConfig = {
  port: parseInt(process.env.PORT || '3000', 10),
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/payments',
  pgPoolMax: parseInt(process.env.PG_POOL_MAX || '20', 10),
  pgIdleTimeoutMs: parseInt(process.env.PG_POOL_IDLE_TIMEOUT_MS || '30000', 10),
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  enableQueueWorker: process.env.ENABLE_QUEUE_WORKER === 'true',
};

export default config;
