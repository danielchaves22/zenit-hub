import { readConfig } from './config.js';
import { Store } from './store.js';
import { OAuth } from './oauth.js';
import { Cash } from './connectors/cash.js';
import { Day } from './connectors/day.js';
import { Calendar } from './connectors/calendar.js';
import { WhatsApp } from './whatsapp.js';
import { Assistant } from './assistant.js';
import { Worker } from './worker.js';
import { createApp } from './app.js';
import { createPool } from './database.js';

const config = readConfig();
const store = new Store(createPool(config.database), config.key, () => {
  console.error('hub.worker.lock.lost');
  // Stop immediately: another process may acquire the lock after connection loss.
  process.exit(1);
});
try { await store.ready(); }
catch {
  console.error('hub.database.not.ready: confira DATABASE_URL e execute npm run db:migrate.');
  await store.close(); process.exit(1);
}
const oauth = new OAuth(config, store);
const whatsapp = new WhatsApp(config);
const assistant = new Assistant(config, store, oauth, new Cash(config.cash), new Day(oauth), new Calendar(oauth));
const worker = new Worker(store, assistant, whatsapp);
const server = createApp(config, store, oauth, whatsapp).listen(config.port, config.host, () => console.log(`Zenit Hub escutando em ${config.host}:${config.port}.`));
const interval = setInterval(() => void worker.tick().catch(() => console.error('hub.worker.failed')), 500);
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  clearInterval(interval);
  const deadline = setTimeout(() => process.exit(1), 290_000);
  try {
    const results = await Promise.allSettled([new Promise<void>(resolve => server.close(() => resolve())), worker.stop()]);
    if (results.some(result => result.status === 'rejected')) {
      console.error('hub.shutdown.operation.failed'); process.exitCode = 1;
    }
    await store.close();
  } catch { console.error('hub.shutdown.failed'); process.exit(1); }
  finally { clearTimeout(deadline); }
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
