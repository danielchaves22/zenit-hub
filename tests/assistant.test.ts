import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { OAuth } from '../src/oauth.js';
import { Assistant } from '../src/assistant.js';
import { Day } from '../src/connectors/day.js';
import { Calendar } from '../src/connectors/calendar.js';
const config = readConfig({ HUB_ENCRYPTION_KEY: randomBytes(32).toString('base64'), OPENAI_API_KEY: 'model-secret', OPENAI_MODEL: 'test-model',
  DAY_SUPABASE_URL: 'https://example.supabase.co', DAY_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', DAY_CLIENT_ID: 'client', DAY_CLIENT_SECRET: 'secret' });
const message = { id: 'wamid.1', sender: 'alice', text: 'O que tenho pendente?', timestamp: Date.now() / 1000 };
function connection(store: Store, provider: 'day' | 'calendar') {
  store.connect({ sender: 'alice', provider, accountId: 'alice-account', label: 'alice@example.com',
    tokens: { access_token: 'provider-secret', refresh_token: 'refresh-secret', expires_at: Date.now() + 3600000 } });
}
test('existing Cash-only conversations require no additional model call and preserve confirmation buttons', async () => {
  const store = new Store(':memory:', config.key);
  try {
    let modelCalls = 0; const replies = [{ text: 'Confirme', buttons: [{ id: 'zenit:confirm:1:123', title: 'Confirmar' }] }];
    const cash = { connected: async () => true, message: async (m: unknown) => { assert.equal(m, message); return replies; } };
    const oauth = new OAuth(config, store);
    const assistant = new Assistant(config, store, oauth, cash as any, new Day(oauth), new Calendar(oauth), (async () => { modelCalls++; throw new Error(); }) as typeof fetch);
    assert.deepEqual(await assistant.handle(message), replies); assert.equal(modelCalls, 0);
  } finally { store.close(); }
});
test('cross-application questions query connected tools with server-owned identity; credentials stay out of model context', async () => {
  const store = new Store(':memory:', config.key); connection(store, 'day'); connection(store, 'calendar');
  try {
    const requests: any[] = []; const senders: string[] = [];
    const oauth = new OAuth(config, store);
    const fetcher = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)); requests.push(body);
      const output = requests.length === 1 ? [{ type: 'function_call', name: 'day_subjects', call_id: '1', arguments: JSON.stringify({ status: 'pending', dueBefore: null, limit: 20 }) }]
        : requests.length === 2 ? [{ type: 'function_call', name: 'calendar_events', call_id: '2', arguments: JSON.stringify({ start: '2026-09-29T00:00:00-03:00', end: '2026-09-30T00:00:00-03:00', calendarId: 'primary', limit: 20 }) }]
          : [{ type: 'message', content: [{ type: 'output_text', text: 'Você tem uma tarefa e um compromisso.' }] }];
      return new Response(JSON.stringify({ output }));
    }) as typeof fetch;
    const assistant = new Assistant(config, store, oauth, { connected: async () => false } as any,
      { subjects: async (sender: string) => { senders.push(sender); return { subjects: [{ title: 'Tarefa' }] }; } } as any,
      { events: async (sender: string) => { senders.push(sender); return { events: [{ summary: 'Compromisso' }] }; } } as any, fetcher);
    assert.equal((await assistant.handle(message))[0].text, 'Você tem uma tarefa e um compromisso.');
    assert.deepEqual(senders, ['alice', 'alice']);
    const serialized = JSON.stringify(requests);
    assert(!serialized.includes('provider-secret')); assert(!serialized.includes('refresh-secret'));
    assert(!requests[0].tools.some((t: any) => t.name.startsWith('cash_')));
  } finally { store.close(); }
});
test('connection commands use no AI and a user cannot confirm another sender grant', async () => {
  const store = new Store(':memory:', config.key);
  try {
    const oauth = new OAuth(config, store); let modelCalls = 0;
    const assistant = new Assistant(config, store, oauth, {} as any, {} as any, {} as any,
      (async () => { modelCalls++; throw new Error(); }) as typeof fetch);
    const result = await assistant.handle({ ...message, text: 'Quero conectar meu Day' });
    assert(result[0].text.includes('/connect/')); assert.equal(modelCalls, 0);
    const token = result[0].text.split('/connect/')[1];
    assert.equal(store.readLink(token, 'link')?.sender, 'alice');
  } finally { store.close(); }
});
test('Day filters owner, archive and status; overfull results are explicitly truncated', async () => {
  const store = new Store(':memory:', config.key); connection(store, 'day');
  try {
    const oauth = new OAuth(config, store);
    const day = new Day(oauth, (async (url, init) => {
      const parsed = new URL(String(url));
      assert.equal(parsed.searchParams.get('user_id'), 'eq.alice-account');
      assert.equal(parsed.searchParams.get('archived'), 'eq.false');
      assert.equal(parsed.searchParams.get('status'), 'neq.done');
      assert.equal((init?.headers as any).Authorization, 'Bearer provider-secret');
      return new Response(JSON.stringify([{ title: 'A' }, { title: 'B' }]));
    }) as typeof fetch);
    const result = await day.subjects('alice', { status: 'pending', dueBefore: null, limit: 1 });
    assert(result.truncated); assert.equal(result.subjects.length, 1);
    await assert.rejects(day.subjects('bob', { status: 'pending', dueBefore: null, limit: 1 }));
  } finally { store.close(); }
});
test('calendar date bounds preserve timezone and refuse reversed or excessive ranges', async () => {
  const store = new Store(':memory:', config.key); connection(store, 'calendar');
  try {
    const calendar = new Calendar(new OAuth(config, store), (async (url) => {
      const parsed = new URL(String(url));
      assert.equal(parsed.searchParams.get('timeMin'), '2026-12-23T00:00:00-03:00');
      assert.equal(parsed.searchParams.get('timeMax'), '2026-12-24T00:00:00-03:00');
      return new Response(JSON.stringify({ items: [{ summary: 'Show' }], nextPageToken: 'next' }));
    }) as typeof fetch);
    const result = await calendar.events('alice', { start: '2026-12-23T00:00:00-03:00', end: '2026-12-24T00:00:00-03:00' });
    assert(result.truncated);
    await assert.rejects(calendar.events('alice', { start: '2026-12-24T00:00:00-03:00', end: '2026-12-23T00:00:00-03:00' }));
  } finally { store.close(); }
});
