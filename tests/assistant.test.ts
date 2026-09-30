import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { createTestStore } from './database-helper.js';
import { OAuth } from '../src/oauth.js';
import { Assistant } from '../src/assistant.js';
import { Day } from '../src/connectors/day.js';
import { Calendar } from '../src/connectors/calendar.js';
const config = readConfig({ DATABASE_URL: 'postgresql://test:test@localhost/zenit_hub_test', HUB_ENCRYPTION_KEY: randomBytes(32).toString('base64'), OPENAI_API_KEY: 'model-secret', OPENAI_MODEL: 'test-model', OPENAI_REASONING_EFFORT: 'none',
  DAY_SUPABASE_URL: 'https://example.supabase.co', DAY_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', DAY_CLIENT_ID: 'client', DAY_CLIENT_SECRET: 'secret' });
const message = { id: 'wamid.1', sender: 'alice', text: 'O que tenho pendente?', timestamp: Date.now() / 1000 };
async function connection(store: Store, provider: 'day' | 'calendar') {
  (await store.connect({ sender: 'alice', provider, accountId: 'alice-account', label: 'alice@example.com',
    tokens: { access_token: 'provider-secret', refresh_token: 'refresh-secret', expires_at: Date.now() + 3600000 } }));
}
test('existing Cash-only conversations require no additional model call and preserve confirmation buttons', async () => {
  const store = (await createTestStore(config.key));
  try {
    let modelCalls = 0; const replies = [{ text: 'Confirme', buttons: [{ id: 'zenit:confirm:1:123', title: 'Confirmar' }] }];
    const cash = { connected: async () => true, message: async (m: unknown) => { assert.equal(m, message); return replies; } };
    const oauth = new OAuth(config, store);
    const assistant = new Assistant(config, store, oauth, cash as any, new Day(oauth), new Calendar(oauth), (async () => { modelCalls++; throw new Error(); }) as typeof fetch);
    assert.deepEqual(await assistant.handle(message), replies); assert.equal(modelCalls, 0);
  } finally { (await store.close()); }
});
test('cross-application questions query connected tools with server-owned identity; credentials stay out of model context', async () => {
  const store = (await createTestStore(config.key)); (await connection(store, 'day')); (await connection(store, 'calendar'));
  try {
    const requests: any[] = []; const senders: string[] = [];
    const oauth = new OAuth(config, store);
    const fetcher = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)); requests.push(body);
      assert.deepEqual(body.reasoning, { effort: 'none' });
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
  } finally { (await store.close()); }
});
test('connection commands use no AI and a user cannot confirm another sender grant', async () => {
  const store = (await createTestStore(config.key));
  try {
    const oauth = new OAuth(config, store); let modelCalls = 0;
    const assistant = new Assistant(config, store, oauth, {} as any, {} as any, {} as any,
      (async () => { modelCalls++; throw new Error(); }) as typeof fetch);
    const result = await assistant.handle({ ...message, text: 'Quero conectar meu Day' });
    assert(result[0].text.includes('/connect/')); assert.equal(modelCalls, 0);
    const token = result[0].text.split('/connect/')[1];
    assert.equal((await store.readLink(token, 'link'))?.sender, 'alice');
  } finally { (await store.close()); }
});
test('Day filters owner, archive and status; overfull results are explicitly truncated', async () => {
  const store = (await createTestStore(config.key)); (await connection(store, 'day'));
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
  } finally { (await store.close()); }
});
test('calendar date bounds preserve timezone and refuse reversed or excessive ranges', async () => {
  const store = (await createTestStore(config.key)); (await connection(store, 'calendar'));
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
  } finally { (await store.close()); }
});

test('Calendar preview is returned directly and confirmation buttons execute without an AI call', async () => {
  const store = await createTestStore(config.key); await connection(store, 'calendar');
  try {
    const oauth = new OAuth(config, store); let modelCalls = 0; let preparations = 0; let confirmations = 0;
    const preview = { text: 'Prévia da agenda', buttons: [{ id: `hub:calendar:confirm:${'a'.repeat(43)}`, title: 'Confirmar' }] };
    const args = { operation: 'create', calendarId: 'primary', eventId: null, title: 'Show', description: null, location: null,
      start: '2026-12-23T14:00:00-03:00', end: '2026-12-23T17:00:00-03:00', allDay: false, reminderMinutes: null };
    const assistant = new Assistant(config, store, oauth, { connected: async () => false } as any, {} as any,
      { prepare: async (sender: string, input: unknown) => { assert.equal(sender, 'alice'); assert.deepEqual(input, args); preparations++; return preview; },
        confirm: async (sender: string, token: string, approved: boolean) => { assert.equal(sender, 'alice'); assert.equal(token, 'a'.repeat(43)); assert(approved); confirmations++; return { text: 'Evento criado.' }; } } as any,
      (async () => { modelCalls++; return new Response(JSON.stringify({ output: [{ type: 'function_call', name: 'calendar_prepare', call_id: '1', arguments: JSON.stringify(args) }] })); }) as typeof fetch);
    assert.deepEqual(await assistant.handle({ ...message, text: 'Crie o Show' }), [preview]);
    assert.equal(preparations, 1); assert.equal(modelCalls, 1); assert.equal(confirmations, 0);
    assert.deepEqual(await assistant.handle({ ...message, text: '', button: preview.buttons[0].id }), [{ text: 'Evento criado.' }]);
    assert.equal(confirmations, 1); assert.equal(modelCalls, 1);
  } finally { await store.close(); }
});

test('Calendar mutation IDs must come from a read in the current request and unconnected tools are rejected', async () => {
  const store = await createTestStore(config.key); await connection(store, 'calendar');
  try {
    const oauth = new OAuth(config, store); let calls = 0; let preparations = 0;
    const args = { operation: 'delete', calendarId: 'primary', eventId: 'invented', title: null, description: null, location: null,
      start: null, end: null, allDay: null, reminderMinutes: null };
    const assistant = new Assistant(config, store, oauth, { connected: async () => false } as any, {} as any,
      { prepare: async () => { preparations++; throw new Error('must not be called'); } } as any,
      (async (_url, init) => {
        calls++; const body = JSON.parse(String(init?.body));
        if (calls === 1) return new Response(JSON.stringify({ output: [{ type: 'function_call', name: 'calendar_prepare', call_id: '1', arguments: JSON.stringify(args) }] }));
        assert.match(JSON.stringify(body.input), /Consulte calendar_events/);
        return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Qual a data do evento?' }] }] }));
      }) as typeof fetch);
    assert.equal((await assistant.handle(message))[0].text, 'Qual a data do evento?'); assert.equal(preparations, 0);
    await store.disconnect('alice', 'calendar'); await connection(store, 'day'); calls = 0;
    await assert.rejects(assistant.handle(message)); assert.equal(preparations, 0);
  } finally { await store.close(); }
});
