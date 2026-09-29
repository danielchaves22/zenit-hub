import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { OAuth } from '../src/oauth.js';
const config = readConfig({ HUB_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', DAY_SUPABASE_URL: 'https://example.supabase.co',
  DAY_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', DAY_CLIENT_ID: 'day-client', DAY_CLIENT_SECRET: 'day-secret' });
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
function setup() {
  const store = new Store(':memory:', config.key); const calls: any[] = [];
  const oauth = new OAuth(config, store, (async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('zenit_day_hub_connection_check')) return response({ application: 'zenit-day', hub_read_only: true });
    if (String(url).endsWith('userinfo')) return response({ sub: 'account-123', email: 'other@example.com' });
    return response({ access_token: 'private-token', refresh_token: 'private-refresh', expires_in: 3600, token_type: 'Bearer' });
  }) as typeof fetch);
  return { store, oauth, calls };
}
test('OAuth requires the initiating browser and a second approval by the same WhatsApp sender', async () => {
  const { store, oauth, calls } = setup();
  try {
    const link = oauth.createLink('alice', 'calendar'); const token = link.split('/').at(-1)!;
    assert(store.readLink(token, 'link')); assert(store.readLink(token, 'link')); // previews do not consume
    const authorization = new URL(oauth.begin(token, 'browser-cookie'));
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.throws(() => oauth.begin(token, 'browser-cookie'));
    const state = authorization.searchParams.get('state')!;
    await assert.rejects(oauth.finish('calendar', state, 'wrong-browser', 'code'));
    assert.equal(calls.length, 0);
    await oauth.finish('calendar', state, 'browser-cookie', 'code');
    assert.equal(store.connection('alice', 'calendar'), null);
    const confirmation = store.nextReply()!.reply.buttons![0].id.split(':')[2];
    assert.throws(() => oauth.approve('bob', confirmation, true));
    oauth.approve('alice', confirmation, true);
    assert.equal(store.connection('alice', 'calendar')?.accountId, 'account-123');
    assert.throws(() => oauth.approve('alice', confirmation, true));
    await assert.rejects(oauth.finish('calendar', state, 'browser-cookie', 'code'));
    const form = new URLSearchParams(calls[0].init.body);
    assert(form.get('code_verifier')); assert.equal(form.get('redirect_uri'), oauth.callback('calendar'));
  } finally { store.close(); }
});
test('denial and disconnect invalidate pending grants without affecting other providers', async () => {
  const { store, oauth } = setup();
  try {
    const begin = oauth.createLink('alice', 'day').split('/').at(-1)!;
    const state = new URL(oauth.begin(begin, 'browser')).searchParams.get('state')!;
    await oauth.finish('day', state, 'browser', 'code');
    const confirmation = store.nextReply()!.reply.buttons![0].id.split(':')[2];
    oauth.approve('alice', confirmation, false);
    assert.equal(store.connection('alice', 'day'), null);
    const token = oauth.createLink('alice', 'day').split('/').at(-1)!;
    store.disconnect('alice', 'day');
    assert.throws(() => oauth.begin(token, 'browser'));
  } finally { store.close(); }
});
test('refresh cannot resurrect a disconnected connection', async () => {
  const { store } = setup();
  try {
    store.connect({ sender: 'alice', provider: 'day', accountId: '123', label: 'alice',
      tokens: { access_token: 'old', refresh_token: 'old-refresh', expires_at: 0 } });
    let finish!: (r: Response) => void;
    const oauth = new OAuth(config, store, (() => new Promise(r => { finish = r; })) as typeof fetch);
    const request = oauth.connection('alice', 'day');
    store.disconnect('alice', 'day');
    finish(response({ access_token: 'new', refresh_token: 'new-refresh', expires_in: 3600 }));
    await assert.rejects(request); assert.equal(store.connection('alice', 'day'), null);
  } finally { store.close(); }
});
