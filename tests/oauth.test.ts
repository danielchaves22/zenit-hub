import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { createTestStore } from './database-helper.js';
import { OAuth, googleScopes } from '../src/oauth.js';
const config = readConfig({ DATABASE_URL: 'postgresql://test:test@localhost/zenit_hub_test', HUB_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', DAY_SUPABASE_URL: 'https://example.supabase.co',
  DAY_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', DAY_CLIENT_ID: 'day-client', DAY_CLIENT_SECRET: 'day-secret' });
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
async function setup() {
  const store = (await createTestStore(config.key)); const calls: any[] = [];
  const oauth = new OAuth(config, store, (async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('zenit_day_hub_connection_check')) return response({ application: 'zenit-day', hub_read_only: true });
    if (String(url).endsWith('userinfo')) return response({ sub: 'account-123', email: 'other@example.com' });
    return response({ access_token: 'private-token', refresh_token: 'private-refresh', expires_in: 3600, token_type: 'Bearer', scope: googleScopes.join(' ') });
  }) as typeof fetch);
  return { store, oauth, calls };
}
test('OAuth requires the initiating browser and a second approval by the same WhatsApp sender', async () => {
  const { store, oauth, calls } = (await setup());
  try {
    const link = (await oauth.createLink('alice', 'calendar')); const token = link.split('/').at(-1)!;
    assert((await store.readLink(token, 'link'))); assert((await store.readLink(token, 'link'))); // previews do not consume
    const authorization = new URL((await oauth.begin(token, 'browser-cookie')));
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert(authorization.searchParams.get('scope')!.includes('calendar.events '));
    assert(!authorization.searchParams.get('scope')!.includes('calendar.events.readonly'));
    await assert.rejects(async () => (await oauth.begin(token, 'browser-cookie')));
    const state = authorization.searchParams.get('state')!;
    await assert.rejects(oauth.finish('calendar', state, 'wrong-browser', 'code'));
    assert.equal(calls.length, 0);
    await oauth.finish('calendar', state, 'browser-cookie', 'code');
    assert.equal((await store.connection('alice', 'calendar')), null);
    const confirmation = (await store.nextReply())!.reply.buttons![0].id.split(':')[2];
    await assert.rejects(async () => (await oauth.approve('bob', confirmation, true)));
    (await oauth.approve('alice', confirmation, true));
    assert.equal((await store.connection('alice', 'calendar'))?.accountId, 'account-123');
    await assert.rejects(async () => (await oauth.approve('alice', confirmation, true)));
    await assert.rejects(oauth.finish('calendar', state, 'browser-cookie', 'code'));
    const form = new URLSearchParams(calls[0].init.body);
    assert(form.get('code_verifier')); assert.equal(form.get('redirect_uri'), oauth.callback('calendar'));
  } finally { (await store.close()); }
});
test('denial and disconnect invalidate pending grants without affecting other providers', async () => {
  const { store, oauth } = (await setup());
  try {
    const begin = (await oauth.createLink('alice', 'day')).split('/').at(-1)!;
    const state = new URL((await oauth.begin(begin, 'browser'))).searchParams.get('state')!;
    await oauth.finish('day', state, 'browser', 'code');
    const confirmation = (await store.nextReply())!.reply.buttons![0].id.split(':')[2];
    (await oauth.approve('alice', confirmation, false));
    assert.equal((await store.connection('alice', 'day')), null);
    const token = (await oauth.createLink('alice', 'day')).split('/').at(-1)!;
    (await store.disconnect('alice', 'day'));
    await assert.rejects(async () => (await oauth.begin(token, 'browser')));
  } finally { (await store.close()); }
});
test('refresh cannot resurrect a disconnected connection', async () => {
  const { store } = (await setup());
  try {
    (await store.connect({ sender: 'alice', provider: 'day', accountId: '123', label: 'alice',
      tokens: { access_token: 'old', refresh_token: 'old-refresh', expires_at: 0 } }));
    let finish!: (r: Response) => void;
    let started!: () => void;
    const refreshing = new Promise<void>(resolve => { started = resolve; });
    const oauth = new OAuth(config, store, (() => new Promise(r => { finish = r; started(); })) as typeof fetch);
    const request = oauth.connection('alice', 'day');
    await refreshing;
    (await store.disconnect('alice', 'day'));
    finish(response({ access_token: 'new', refresh_token: 'new-refresh', expires_in: 3600 }));
    await assert.rejects(request); assert.equal((await store.connection('alice', 'day')), null);
  } finally { (await store.close()); }
});

test('Google grants require explicit event-write and calendar-list scopes before any connection can be approved', async () => {
  const store = await createTestStore(config.key);
  try {
    for (const scope of [undefined, 'openid email https://www.googleapis.com/auth/calendar.events.readonly', 'https://www.googleapis.com/auth/calendar.events']) {
      const oauth = new OAuth(config, store, (async () => response({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope })) as typeof fetch);
      const token = (await oauth.createLink('alice', 'calendar')).split('/').at(-1)!;
      const state = new URL(await oauth.begin(token, 'browser')).searchParams.get('state')!;
      await assert.rejects(oauth.finish('calendar', state, 'browser', 'code'), /Conceda acesso/);
      assert.equal(await store.connection('alice', 'calendar'), null);
    }
  } finally { await store.close(); }
});
