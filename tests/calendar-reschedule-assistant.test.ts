import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Assistant } from '../src/assistant.js';
import { readConfig } from '../src/config.js';
import { OAuth } from '../src/oauth.js';
import { createTestStore } from './database-helper.js';

const config = readConfig({ DATABASE_URL: 'postgresql://localhost/zenit_hub_test', HUB_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  OPENAI_API_KEY: 'synthetic-key', OPENAI_MODEL: 'synthetic-model' });
const move = { calendarId: 'primary', eventId: 'missa123', date: '2026-10-12' };
const query = { calendarId: 'primary', start: '2026-12-12T00:00:00-03:00', end: '2026-12-13T00:00:00-03:00', limit: 20 };
const change = { operation: 'update', calendarId: 'primary', eventId: 'missa123', title: null, description: null, location: null,
  start: '2026-10-12T08:00:00-03:00', end: '2026-10-12T09:00:00-03:00', allDay: false, reminderMinutes: null, timingEvidence: '08:00 às 09:00' };
const preview = { text: 'Missa na paróquia: 12/12 → 12/10, 8h–9h. Nada foi gravado.', buttons: [{ id: `hub:calendar:confirm:${'a'.repeat(43)}`, title: 'Confirmar' }] };
const tool = (name: string, args: unknown) => ({ type: 'function_call', name, call_id: name, arguments: JSON.stringify(args) });
async function setup(outputs: unknown[], inspect?: (body: any, call: number) => void) {
  const store = await createTestStore(config.key);
  await store.connect({ sender: 'alice', provider: 'calendar', accountId: 'alice-account', label: 'alice@example.test',
    tokens: { access_token: 'synthetic-token', refresh_token: 'synthetic-refresh', expires_at: Date.now() + 3600000 } });
  const oauth = new OAuth(config, store);
  const prepared: { name: string; input: unknown }[] = [];
  let calls = 0;
  const assistant = new Assistant(config, store, oauth, { connected: async () => false } as any, {} as any, {
    events: async () => ({ calendar: 'primary', events: [{ id: 'missa123', summary: 'Missa na paróquia', start: { dateTime: '2026-12-12T08:00:00-03:00' }, end: { dateTime: '2026-12-12T09:00:00-03:00' } }] }),
    prepareReschedule: async (_sender: string, input: unknown) => { prepared.push({ name: 'move', input }); return preview; },
    prepare: async (_sender: string, input: unknown) => { prepared.push({ name: 'update', input }); return preview; }
  } as any, async (_url, init) => {
    const body = JSON.parse(String(init?.body)); inspect?.(body, calls);
    const output = outputs[calls++]; assert(output, 'unexpected extra model call');
    return new Response(JSON.stringify({ output: [output] }));
  });
  return { store, assistant, prepared };
}
const incoming = (text: string) => ({ id: 'msg1', sender: 'alice', timestamp: Date.now() / 1000, text });

test('a date correction with same original hours uses a freshly read event and returns the confirmation preview', async () => {
  const f = await setup([tool('calendar_events', query), tool('calendar_reschedule', move)]);
  try {
    assert.deepEqual(await f.assistant.handle(incoming('Eu quero alterar o evento Missa na paróquia do dia 12/12 para dia 12/10, no mesmo horário do original')), [preview]);
    assert.deepEqual(f.prepared, [{ name: 'move', input: move }]);
  } finally { await f.store.close(); }
});

test('a bare clock reply keeps the pending request in history and accepts normalized evidence', async () => {
  const f = await setup([tool('calendar_events', query), tool('calendar_prepare', change)], body => {
    assert.match(JSON.stringify(body.input), /Missa na paróquia do dia 12\/12 para dia 12\/10/);
    assert.match(JSON.stringify(body.input), /8:00 às 9:00/);
  });
  try {
    await f.store.addHistory('alice', 'user', 'Alterar Missa na paróquia do dia 12/12 para dia 12/10');
    await f.store.addHistory('alice', 'assistant', 'Qual é o horário de início e de fim?');
    assert.deepEqual(await f.assistant.handle(incoming('8:00 às 9:00')), [preview]);
    assert.deepEqual(f.prepared, [{ name: 'update', input: change }]);
  } finally { await f.store.close(); }
});

test('an incorrect timing tool call can recover using the date-only tool before asking the user again', async () => {
  const f = await setup([tool('calendar_prepare', { ...change, timingEvidence: 'mesmo horário' }), tool('calendar_events', query), tool('calendar_reschedule', move)], (body, call) => {
    if (call === 1) assert.match(body.input.at(-1).output, /calendar_reschedule/);
  });
  try {
    assert.deepEqual(await f.assistant.handle(incoming('Mova a missa de 12/12 para 12/10, no mesmo horário')), [preview]);
    assert.deepEqual(f.prepared, [{ name: 'move', input: move }]);
  } finally { await f.store.close(); }
});

test('date-only moves still require a current lookup; missing times cannot be invented by retries', async () => {
  const f = await setup([tool('calendar_reschedule', move), tool('calendar_prepare', change), tool('calendar_prepare', change)], (body, call) => {
    if (call === 1) assert.match(body.input.at(-1).output, /Consulte calendar_events/);
  });
  try {
    const result = await f.assistant.handle(incoming('Crie um evento amanhã'));
    assert.match(result[0].text, /Qual é o horário/);
    assert.equal(result[0].buttons, undefined);
    assert.deepEqual(f.prepared, []);
  } finally { await f.store.close(); }
});
