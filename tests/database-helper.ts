import { randomUUID } from 'node:crypto';
import { createPool } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { Store } from '../src/store.js';

export async function createTestStore(key: string) {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) throw new Error('Configure TEST_DATABASE_URL em .env.test com PostgreSQL local e uma base terminada em _test.');
  const url = new URL(raw);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test')) {
    throw new Error('Testes só podem usar PostgreSQL local em uma base terminada em _test.');
  }
  const schema = `hub_test_${randomUUID().replaceAll('-', '')}`;
  const admin = createPool({ connectionString: raw, max: 1, connectionTimeoutMillis: 5000 });
  const config = { connectionString: raw, max: 3, connectionTimeoutMillis: 5000,
    statement_timeout: 5000, options: `-c search_path=${schema}` };
  const store = new Store(createPool(config), key);
  const close = store.close.bind(store);
  store.close = async () => {
    try { await close(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await admin.end(); }
  };
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await migrate(store.db); await store.ready();
    return Object.assign(store, { testPoolConfig: config });
  } catch (error) { await store.close(); throw error; }
}
