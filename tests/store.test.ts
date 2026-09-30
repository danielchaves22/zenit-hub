import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createTestStore } from './database-helper.js';
import { Store } from '../src/store.js';
import { createPool, readDatabaseConfig } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { Worker } from '../src/worker.js';
import type { Connection, Reply } from '../src/types.js';

const key = randomBytes(32).toString('base64');
const message = { id: 'wamid.pg', sender: 'alice', text: 'oi', timestamp: Date.now() / 1000 };
const connection: Connection = { sender: 'alice', provider: 'day', accountId: 'account', label: 'alice@example.com',
  tokens: { access_token: 'access-private', refresh_token: 'refresh-private', expires_at: Date.now() + 3600_000 } };

test('database configuration fails without PostgreSQL and bounds the connection pool', () => {
  assert.throws(() => readDatabaseConfig({}));
  assert.throws(() => readDatabaseConfig({ DATABASE_URL: 'file:hub.sqlite' }));
  assert.throws(() => readDatabaseConfig({ DATABASE_URL: 'postgresql://localhost/db', HUB_DATABASE_POOL_MAX: '1' }));
  assert.equal(readDatabaseConfig({ DATABASE_URL: 'postgresql://localhost/zenit_hub' }).max, 5);
});

test('migrations are repeatable and do not reset persisted encrypted connections', async () => {
  const store = await createTestStore(key);
  try {
    await store.connect(connection);
    await Promise.all([migrate(store.db), migrate(store.db)]);
    assert.equal((await store.db.query('SELECT count(*)::int AS n FROM hub_schema_migrations')).rows[0].n, 2);
    assert.deepEqual(await store.connection('alice', 'day'), connection);
    const raw = JSON.stringify((await store.db.query('SELECT * FROM connections')).rows);
    assert(!raw.includes('access-private') && !raw.includes('alice@example.com'));
    await store.db.query('DELETE FROM hub_schema_migrations');
    await assert.rejects(migrate(store.db));
    assert.deepEqual(await store.connection('alice', 'day'), connection);
    assert.equal((await store.db.query('SELECT count(*)::int AS n FROM hub_schema_migrations')).rows[0].n, 0);
  } finally { await store.close(); }
});

test('concurrent ingress, claims and OAuth consumption never duplicate work', async () => {
  const store = await createTestStore(key);
  try {
    assert.equal((await Promise.all(Array.from({ length: 8 }, () => store.enqueue(message)))).filter(Boolean).length, 1);
    const claimed = await Promise.all([store.nextMessage(), store.nextMessage()]);
    assert.equal(claimed.filter(Boolean).length, 1);
    await store.link('once', 'alice', 'day', {});
    assert.equal((await Promise.all([store.takeLink('once', 'link'), store.takeLink('once', 'link')])).filter(Boolean).length, 1);
    await store.link('approval', 'alice', 'day', connection, 'confirmation');
    assert.equal(await store.approveLink('bob', 'approval', true), null);
    await store.addHistory('alice', 'assistant', 'old-account-private-context');
    assert.equal((await Promise.all([store.approveLink('alice', 'approval', true), store.approveLink('alice', 'approval', true)])).filter(Boolean).length, 1);
    assert.deepEqual(await store.history('alice'), []);
    assert.deepEqual(await store.connection('alice', 'day'), connection);
  } finally { await store.close(); }
});

test('completion and replies commit together or roll back together', async () => {
  const store = await createTestStore(key);
  try {
    await store.enqueue(message); await store.nextMessage();
    const circular: any = { text: 'bad' }; circular.self = circular;
    await assert.rejects(store.complete(message, [{ text: 'first' }, circular as Reply]));
    assert.equal((await store.db.query('SELECT state FROM inbox')).rows[0].state, 'processing');
    assert.equal((await store.db.query('SELECT count(*)::int AS n FROM outbox')).rows[0].n, 0);
    await store.complete(message, [{ text: 'committed' }]);
    await assert.rejects(store.complete(message, [{ text: 'duplicate' }]));
    const replies = await Promise.all([store.nextReply(), store.nextReply()]);
    assert.equal(replies.filter(Boolean).length, 1);
    assert.equal(replies.find(Boolean)?.reply.text, 'committed');
  } finally { await store.close(); }
});

test('deployment overlap elects one worker; restart preserves data and quarantines interrupted operations', async () => {
  const fixture = await createTestStore(key);
  const first = new Store(createPool(fixture.testPoolConfig), key);
  const second = new Store(createPool(fixture.testPoolConfig), key);
  try {
    await first.ready(); await first.connect(connection);
    assert.equal(await first.startWorker(), true);
    await first.enqueue(message); await first.nextMessage();
    await first.sendLater('alice', { text: 'remote acceptance unknown' }); await first.nextReply();
    assert.equal(await second.startWorker(), false);
    assert.equal((await second.db.query('SELECT state FROM inbox')).rows[0].state, 'processing');
    await first.close();
    assert.equal(await second.startWorker(), true);
    assert.equal((await second.db.query('SELECT state FROM inbox')).rows[0].state, 'uncertain');
    assert.equal((await second.db.query('SELECT state FROM outbox')).rows[0].state, 'uncertain');
    assert.equal(await second.nextMessage(), null); assert.equal(await second.nextReply(), null);
    assert.deepEqual(await second.connection('alice', 'day'), connection);
    assert.equal(await second.enqueue(message), false);
  } finally { if (!first.db.ended) await first.close(); await second.close(); await fixture.close(); }
});

test('history bounds and retention preserve pending and uncertain queue entries', async () => {
  const store = await createTestStore(key);
  try {
    for (let i = 0; i < 15; i++) await store.addHistory('alice', 'user', String(i));
    assert.equal((await store.history('alice')).length, 12);
    assert.equal((await store.history('alice'))[0].content, '3');
    await store.enqueue(message); await store.nextMessage(); await store.complete(message, [{ text: 'done' }]);
    const reply = await store.nextReply(); await store.sent(reply!.id, true);
    await store.enqueue({ ...message, id: 'uncertain' }); await store.nextMessage(); await store.fail('uncertain');
    await store.enqueue({ ...message, id: 'pending' });
    await store.db.query('UPDATE inbox SET created=0'); await store.db.query('UPDATE outbox SET created=0');
    await store.db.query('UPDATE history SET created=0');
    await store.link('expired', 'alice', 'day', {}); await store.db.query('UPDATE oauth_links SET expires=0');
    await store.prune();
    assert.deepEqual((await store.db.query('SELECT id FROM inbox ORDER BY id')).rows.map(row => row.id), ['pending', 'uncertain']);
    assert.deepEqual(await store.history('alice'), []);
    assert.equal(await store.readLink('expired', 'link'), null);
    assert.equal((await store.db.query('SELECT count(*)::int AS n FROM outbox')).rows[0].n, 0);
  } finally { await store.close(); }
});

test('graceful stop waits for the active operation and leaves its reply durably queued', async () => {
  const store = await createTestStore(key);
  let finish!: () => void; let started!: () => void;
  const active = new Promise<void>(resolve => { started = resolve; });
  const release = new Promise<void>(resolve => { finish = resolve; });
  try {
    await store.enqueue(message);
    const worker = new Worker(store, { handle: async () => { started(); await release; return [{ text: 'saved' }]; } } as any,
      { withTypingIndicator: async (_id: string, work: () => Promise<Reply[]>) => work() } as any);
    const tick = worker.tick(); await active;
    let stopped = false;
    const stop = worker.stop().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false);
    finish(); await Promise.all([tick, stop]);
    assert.equal((await store.db.query('SELECT state FROM inbox')).rows[0].state, 'done');
    assert.equal((await store.db.query('SELECT state FROM outbox')).rows[0].state, 'pending');
  } finally { finish?.(); await store.close(); }
});
