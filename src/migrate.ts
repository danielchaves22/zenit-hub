import { createPool, readDatabaseConfig } from './database.js';
import { migrate } from './migrations.js';

let pool;
try {
  pool = createPool(readDatabaseConfig());
  await migrate(pool);
  console.log('hub.database.migrated');
} catch {
  console.error('hub.database.migration.failed: confira DATABASE_URL, permissões e versão do banco.');
  process.exitCode = 1;
} finally { await pool?.end(); }
