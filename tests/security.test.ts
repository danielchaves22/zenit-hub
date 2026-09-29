import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.js';
import { Vault, metaSignature } from '../src/security.js';
import { readConfig } from '../src/config.js';
import { WhatsApp } from '../src/whatsapp.js';
import { Worker } from '../src/worker.js';

const key = randomBytes(32).toString('base64');
const config = readConfig({ HUB_ENCRYPTION_KEY: key, WHATSAPP_APP_SECRET: 'meta-secret', WHATSAPP_PHONE_NUMBER_ID: 'phone-1' });
test('tokens are encrypted, authenticated, and bound to their owner and provider', () => {
  const vault = new Vault(key); const encrypted = vault.seal({ token: 'private-token' }, 'alice:day');
  assert(!encrypted.includes('private-token'));
  assert.deepEqual(vault.open(encrypted, 'alice:day'), { token: 'private-token' });
  assert.throws(() => vault.open(encrypted, 'bob:day'));
  assert.throws(() => new Vault(randomBytes(32).toString('base64')).open(encrypted, 'alice:day'));
});
test('connections remain independent; raw SQL contains no access token or email', () => {
  const store = new Store(':memory:', key);
  try {
    for (const provider of ['day', 'calendar'] as const) store.connect({ sender: 'alice', provider, accountId: provider,
      label: `${provider}@example.com`, tokens: { access_token: 'private-token', refresh_token: 'refresh', expires_at: Date.now() + 3600000 } });
    assert.equal(store.connection('bob', 'day'), null);
    assert(!JSON.stringify(store.db.prepare('SELECT * FROM connections').all()).includes('private-token'));
    store.disconnect('alice', 'day');
    assert.equal(store.connection('alice', 'day'), null);
    assert.equal(store.connection('alice', 'calendar')?.accountId, 'calendar');
  } finally { store.close(); }
});
test('webhook verifies exact bytes, destination phone, sender allowlist, and age', () => {
  const whatsapp = new WhatsApp({ ...config, allowedSenders: new Set(['5544999990000']) });
  const body = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: 'phone-1' }, messages: [
      { id: 'one', from: '5544999990000', timestamp: Math.floor(Date.now() / 1000), type: 'text', text: { body: 'oi' } },
      { id: 'two', from: '5544888880000', timestamp: Math.floor(Date.now() / 1000), type: 'text', text: { body: 'oi' } },
      { id: 'old', from: '5544999990000', timestamp: 100, type: 'text', text: { body: 'oi' } }
    ] } }] }] }));
  const signature = metaSignature(body, config.meta.secret);
  assert.equal(whatsapp.parse(body, signature).length, 1);
  assert.throws(() => whatsapp.parse(Buffer.concat([body, Buffer.from(' ')]), signature));
  const wrongDestination = new WhatsApp({ ...config, meta: { ...config.meta, phoneId: 'other' } });
  assert.deepEqual(wrongDestination.parse(body, signature), []);
});
test('webhook redelivery and overlapping worker ticks execute one message once', async () => {
  const store = new Store(':memory:', key); let calls = 0; const sent: any[] = [];
  try {
    const message = { id: 'wamid.1', sender: 'alice', text: 'oi', timestamp: Date.now() / 1000 };
    assert(store.enqueue(message)); assert(!store.enqueue(message));
    const worker = new Worker(store, { handle: async () => { calls++; await new Promise(r => setTimeout(r, 20)); return [{ text: 'olá' }]; } } as any,
      { withTypingIndicator: async (_id: string, work: () => Promise<any>) => work(), send: async (...args: any[]) => { sent.push(args); } } as any);
    await Promise.all([worker.tick(), worker.tick()]); await worker.tick();
    assert.equal(calls, 1); assert.equal(sent.length, 1);
    assert.equal(store.db.prepare('SELECT state FROM inbox').get()?.state, 'done');
  } finally { store.close(); }
});
test('uncertain outbound delivery is not retried automatically', async () => {
  const store = new Store(':memory:', key); let calls = 0;
  try {
    store.sendLater('alice', { text: 'resposta' });
    const worker = new Worker(store, {} as any, { send: async () => { calls++; throw new Error('timeout after remote acceptance'); } } as any);
    await worker.tick(); await worker.tick();
    assert.equal(calls, 1);
    assert.equal(store.db.prepare('SELECT state FROM outbox').get()?.state, 'uncertain');
  } finally { store.close(); }
});
