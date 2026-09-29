import { Pool, type PoolClient, type PoolConfig } from 'pg';

export function readDatabaseConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  let url: URL;
  try {
    url = new URL(env.DATABASE_URL || '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) throw new Error();
  } catch { throw new Error('Configure DATABASE_URL com a conexão PostgreSQL da base zenit_hub.'); }
  const max = Number(env.HUB_DATABASE_POOL_MAX || 5);
  if (!Number.isInteger(max) || max < 2 || max > 10) throw new Error('HUB_DATABASE_POOL_MAX deve estar entre 2 e 10.');
  return { connectionString: url.toString(), max, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000,
    statement_timeout: 10_000, application_name: 'zenit-hub', keepAlive: true };
}

export function createPool(config: PoolConfig) {
  const pool = new Pool(config);
  pool.on('error', () => console.error('hub.database.connection.failed'));
  return pool;
}

export async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}
