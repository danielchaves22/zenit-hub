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

const config = readConfig();
const store = new Store(config.databasePath, config.key);
const oauth = new OAuth(config, store);
const whatsapp = new WhatsApp(config);
const assistant = new Assistant(config, store, oauth, new Cash(config.cash), new Day(oauth), new Calendar(oauth));
const worker = new Worker(store, assistant, whatsapp);
const server = createApp(config, store, oauth, whatsapp).listen(config.port, '127.0.0.1', () => console.log(`Zenit Hub escutando na porta ${config.port}.`));
const interval = setInterval(() => void worker.tick().catch(() => console.error('hub.worker.failed')), 500);
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  clearInterval(interval);
  server.close();
  // Let requests and the current operation finish before the process exits.
  setTimeout(() => process.exit(0), 300_000).unref();
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
