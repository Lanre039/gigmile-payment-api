import { Pool, PoolClient } from 'pg';
import config from '../config';

// A single shared pool per process. In production this points at
// PgBouncer (transaction pooling mode) rather than Postgres directly,
// so thousands of short-lived logical connections from many API/worker
// instances can be multiplexed onto a small number of real Postgres
// backends. See docker-compose.yml / README.
export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.pgPoolMax,
  idleTimeoutMillis: config.pgIdleTimeoutMs,
});

pool.on('error', (err: Error) => {
  // Errors on idle clients shouldn't crash the process.
  // eslint-disable-next-line no-console
  console.error('Unexpected Postgres pool error', err);
});

/**
 * Run a callback inside a single client transaction.
 * Guarantees COMMIT on success and ROLLBACK on any thrown error.
 */
export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
