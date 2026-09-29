import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { createTestStore } from './database-helper.js';
import { OAuth } from '../src/oauth.js';
import { WhatsApp } from '../src/whatsapp.js';
import { createApp } from '../src/app.js';
import { metaSignature } from '../src/security.js';
test('real HTTP ingress persists signed messages once; OAuth pages require cookie-bound POST', async () => {
  const config = readConfig({ DATABASE_URL: 'postgresql://test:test@localhost/zenit_hub_test', HUB_ENCRYPTION_KEY: randomBytes(32).toString('base64'), WHATSAPP_APP_SECRET: 'secret',
    WHATSAPP_PHONE_NUMBER_ID: 'phone', WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'verify', GOOGLE_CLIENT_ID: 'google', GOOGLE_CLIENT_SECRET: 'secret' });
  const store = (await createTestStore(config.key)); const oauth = new OAuth(config, store);
  const server = createApp(config, store, oauth, new WhatsApp(config)).listen(0, '127.0.0.1');
  await once(server, 'listening'); const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  config.publicUrl = origin;
  try {
    const challenge = await fetch(`${origin}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=123`);
    assert.equal(await challenge.text(), '123');
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: 'phone' }, messages: [{ id: 'wamid.1', from: '5544999990000', timestamp: Math.floor(Date.now() / 1000), type: 'text', text: { body: 'oi' } }]
    } }] }] });
    const post = (signature: string) => fetch(`${origin}/webhooks/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signature }, body });
    assert.equal((await post('bad')).status, 401);
    for (let i = 0; i < 2; i++) assert.equal((await post(metaSignature(Buffer.from(body), 'secret'))).status, 202);
    assert.equal((await store.db.query('SELECT count(*)::int AS n FROM inbox')).rows[0]?.n, 1);
    const token = (await oauth.createLink('alice', 'calendar')).split('/').at(-1)!;
    const preview = await fetch(`${origin}/connect/${token}`);
    assert.equal(preview.status, 200); assert((await store.readLink(token, 'link')));
    const html = await preview.text(); const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1];
    const cookie = preview.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await fetch(`${origin}/connect/${token}`, { method: 'POST' })).status, 403);
    const wrongOrigin = await fetch(`${origin}/connect/${token}`, { method: 'POST', headers: { cookie, Origin: 'https://other.example', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf }), redirect: 'manual' });
    assert.equal(wrongOrigin.status, 403); assert((await store.readLink(token, 'link')));
    const start = await fetch(`${origin}/connect/${token}`, { method: 'POST', headers: { cookie, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf }), redirect: 'manual' });
    assert.equal(start.status, 303); assert(start.headers.get('location')?.startsWith('https://accounts.google.com/'));
    assert.equal(start.headers.get('referrer-policy'), 'same-origin');
    assert.equal((await fetch(`${origin}/health`)).status, 200);
    const enqueue = store.enqueue.bind(store); const health = store.health.bind(store);
    try {
      store.enqueue = async () => { throw new Error('private-database-error'); };
      const failed = await post(metaSignature(Buffer.from(body), 'secret'));
      assert.equal(failed.status, 500); assert(!(await failed.text()).includes('private-database-error'));
      store.health = async () => { throw new Error('private-database-error'); };
      assert.equal((await fetch(`${origin}/health`)).status, 503);
    } finally { store.enqueue = enqueue; store.health = health; }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); (await store.close()); }
});
