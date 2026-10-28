import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Assistant } from '../src/assistant.js';
import { CalendarIntents } from '../src/calendar-intents.js';
import { Calendar } from '../src/connectors/calendar.js';
import { OAuth } from '../src/oauth.js';
import { readConfig } from '../src/config.js';
import type { Connection } from '../src/types.js';
import { createTestStore } from './database-helper.js';

const config = readConfig({ DATABASE_URL: 'postgresql://localhost/zenit_hub_test', HUB_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  OPENAI_API_KEY: 'synthetic-key', OPENAI_MODEL: 'synthetic-model' });
const connection: Connection = { sender: 'alice', provider: 'calendar', accountId: 'account-alice', label: 'alice@example.test',
  tokens: { access_token: 'synthetic-token', refresh_token: 'synthetic-refresh', expires_at: Date.now() + 3600_000,
    scope: 'https://www.googleapis.com/auth/calendar.events' } };
const first = 'Marque um compromisso pro dia 14/11/2026, às 12h30, chamado "Chá Revelação Maria"';
const change = { operation: 'create' as const, calendarId: 'primary', eventId: null, title: 'Chá Revelação Maria', description: null, location: null,
  start: '2026-11-14T12:30:00-03:00', end: null, allDay: false, timingEvidence: 'às 12h30', reminderMinutes: null };
const completion = { title: null, start: null, end: '2026-11-14T15:30:00-03:00', allDay: null, timingEvidence: 'às 15h30' };
const incoming = (text: string, sender = 'alice') => ({ id: randomUUID(), sender, text, timestamp: Date.now() / 1000 });
const call = (name: string, args: unknown) => ({ type: 'function_call', name, call_id: randomUUID(), arguments: JSON.stringify(args) });
const responseText = (text: string) => ({ type: 'message', content: [{ type: 'output_text', text }] });

async function fixture(outputs: ((body: any) => unknown | Promise<unknown>)[] = []) {
  const store = await createTestStore(config.key);
  await store.connect(connection);
  let aiCalls = 0;
  const googleCalls: { url: string; method: string }[] = [];
  let failure = 0;
  const oauth = new OAuth(config, store);
  const calendar = new Calendar(oauth, async (url, init) => {
    googleCalls.push({ url: String(url), method: init?.method || 'GET' });
    if (failure) return new Response('{}', { status: failure });
    assert.match(String(url), /users\/me\/calendarList\/primary/);
    return new Response(JSON.stringify({ id: 'primary', summary: 'Pessoal', accessRole: 'owner' }));
  });
  const assistant = new Assistant(config, store, oauth, { connected: async () => false } as any, {} as any, calendar, async (_url, init) => {
    const fn = outputs[aiCalls++]; assert(fn, 'unexpected model retry');
    return new Response(JSON.stringify({ output: [await fn(JSON.parse(String(init?.body)))] }));
  });
  return { store, assistant, googleCalls, aiCalls: () => aiCalls, fail: (status: number) => { failure = status; } };
}

test('split-time WhatsApp conversation preserves the event and produces the real button preview without writing', async () => {
  const f = await fixture([
    body => { assert.match(body.instructions, /MESMO QUE INCOMPLETO/); return call('calendar_prepare', change); },
    async body => {
      const intent = (await f.assistant.calendarIntents.pending('alice'))!;
      assert(body.instructions.includes(intent.id));
      assert.match(body.instructions, /Chá Revelação Maria/);
      return call('calendar_complete', { ...completion, intentId: intent.id });
    },
    () => responseText('Use o botão Confirmar da prévia para gravar.')
  ]);
  try {
    const firstReply = await f.assistant.handle(incoming(first));
    assert.match(firstReply[0].text, /horário de término/);
    assert.match(firstReply[0].text, /12:30/);
    assert.equal(firstReply[0].buttons, undefined);
    assert.equal(f.googleCalls.length, 0);
    assert.equal(await f.store.pendingCalendarDraft('alice'), null);
    const reply = (await f.assistant.handle(incoming('às 15h30')))[0];
    assert.match(reply.text, /Chá Revelação Maria/);
    assert.match(reply.text, /14\/11\/2026, 12:30.*14\/11\/2026, 15:30/);
    assert(reply.buttons?.some(button => button.title === 'Confirmar'));
    assert.equal(await f.assistant.calendarIntents.pending('alice'), null);
    const draft = (await f.store.pendingCalendarDraft<any>('alice'))!.data;
    assert.equal(draft.patch.start.dateTime, change.start);
    assert.equal(draft.patch.end.dateTime, completion.end);
    await f.assistant.handle(incoming('Sim, confirme'));
    assert(f.googleCalls.every(request => request.method === 'GET'));
    assert.equal(f.aiCalls(), 3);
  } finally { await f.store.close(); }
});

test('unrelated historical clocks and assistant claims cannot supply either missing time', async () => {
  const f = await fixture([
    () => call('calendar_prepare', { ...change, end: completion.end, timingEvidence: '12:30 às 15:30' }),
    body => {
      const result = JSON.parse(body.input.at(-1).output);
      assert.equal(result.source, 'hub_validation'); assert.equal(result.googleRequestSent, false);
      return responseText('O Google rejeitou os horários, tente novamente.');
    }
  ]);
  try {
    await f.store.addHistory('alice', 'user', 'Outra reunião ontem das 12:30 às 15:30');
    await f.store.addHistory('alice', 'assistant', 'Chá Revelação às 12:30 às 15:30');
    const result = await f.assistant.handle(incoming('Crie o Chá Revelação no dia 14/11/2026'));
    assert.doesNotMatch(result[0].text, /Google rejeitou/);
    assert.match(result[0].text, /Qual é o horário/);
    assert.equal(f.googleCalls.length, 0);
    assert.equal(await f.assistant.calendarIntents.pending('alice'), null);
  } finally { await f.store.close(); }
});

test('invalid or invented completion leaves the saved start unchanged; a corrected answer can finish it', async () => {
  const f = await fixture();
  try {
    const intents = f.assistant.calendarIntents;
    await intents.begin('alice', change, first);
    const original = (await intents.pending('alice'))!;
    await assert.rejects(intents.complete('alice', { ...completion, intentId: original.id, start: '2026-11-14T13:30:00-03:00' }, 'às 15h30'));
    await assert.rejects(intents.complete('alice', { ...completion, intentId: original.id, end: '2026-11-14T11:30:00-03:00', timingEvidence: '11h30' }, '11h30'), /posterior/);
    assert.deepEqual(await intents.pending('alice'), original);
    const reply = await intents.complete('alice', { ...completion, intentId: original.id, start: change.start, timingEvidence: 'às 15:30' }, 'às 15h30');
    assert(reply.buttons?.length);
  } finally { await f.store.close(); }
});

test('pending data are encrypted, survive a new service instance, and cannot cross sender or workspace', async () => {
  const f = await fixture();
  try {
    const intents = f.assistant.calendarIntents;
    await f.store.withHistoryScope('alice', 'cash:home', () => intents.begin('alice', change, first));
    const raw = JSON.stringify((await f.store.db.query('SELECT * FROM calendar_intents')).rows);
    assert(!raw.includes(change.title)); assert(!raw.includes(change.start));
    assert.equal(await intents.pending('alice'), null);
    assert.equal(await f.store.withHistoryScope('alice', 'cash:company', () => intents.pending('alice')), null);
    await f.store.connect({ ...connection, sender: 'bob' });
    const saved = await f.store.withHistoryScope('alice', 'cash:home', () => intents.pending('alice'));
    assert(saved);
    await assert.rejects(intents.complete('bob', { ...completion, intentId: saved.id }, 'às 15h30'), /expirou/);
    const restarted = new CalendarIntents(f.store, config.timeZone, async () => ({ text: 'preview' }));
    assert.deepEqual(await f.store.withHistoryScope('alice', 'cash:home', () => restarted.pending('alice')), saved);
    await f.store.db.query('UPDATE calendar_intents SET expires=0');
    assert.equal(await f.store.withHistoryScope('alice', 'cash:home', () => restarted.pending('alice')), null);
    await f.store.prune();
    assert.equal((await f.store.db.query('SELECT count(*)::int n FROM calendar_intents')).rows[0].n, 0);
  } finally { await f.store.close(); }
});

test('replacement, cancellation and reconnect invalidate old request IDs and old confirmation buttons', async () => {
  const f = await fixture();
  try {
    const intents = f.assistant.calendarIntents;
    await f.store.calendarDraft('alice', 'old-token', {});
    await intents.begin('alice', change, first);
    assert.equal(await f.store.pendingCalendarDraft('alice', 'old-token'), null);
    const old = (await intents.pending('alice'))!;
    await assert.rejects(f.assistant.handle({ ...incoming('Confirmar'), button: `hub:calendar:confirm:${'a'.repeat(43)}` }), /expirou/);
    assert.deepEqual(await intents.pending('alice'), old, 'an obsolete confirmation must not erase the newer incomplete request');
    await intents.begin('alice', { ...change, title: 'Outro evento', start: '2026-11-15T10:00:00-03:00', timingEvidence: '10h' }, 'Outro evento dia 15 às 10h');
    await assert.rejects(intents.complete('alice', { ...completion, intentId: old.id }, 'às 15h30'), /substituído/);
    assert.match((await f.assistant.handle(incoming('cancelar')))[0].text, /descartado/);
    assert.equal(await intents.pending('alice'), null);
    await intents.begin('alice', change, first);
    await f.store.connect(connection);
    assert.equal(await intents.pending('alice'), null);
    await intents.begin('alice', change, first);
    await f.store.disconnect('alice', 'calendar');
    assert.equal(await intents.pending('alice'), null);
  } finally { await f.store.close(); }
});

test('a Google failure is reported once, keeps the complete request and supports explicit retry', async () => {
  const f = await fixture([
    () => call('calendar_prepare', { ...change, end: completion.end, timingEvidence: '12h30 às 15h30' }),
    async () => call('calendar_complete', { ...completion, intentId: (await f.assistant.calendarIntents.pending('alice'))!.id, end: null, timingEvidence: null })
  ]);
  try {
    f.fail(403);
    const failed = (await f.assistant.handle(incoming('Crie Chá Revelação Maria em 14/11/2026, 12h30 às 15h30')))[0];
    assert.match(failed.text, /Google não permitiu/);
    assert.doesNotMatch(failed.text, /HH:mm|formato/);
    assert.equal(f.googleCalls.length, 1);
    assert.equal(f.aiCalls(), 1);
    assert(await f.assistant.calendarIntents.pending('alice'));
    f.fail(0);
    const reply = (await f.assistant.handle(incoming('Tente novamente')))[0];
    assert(reply.buttons?.length);
    assert.equal(f.googleCalls.length, 2);
    assert(f.googleCalls.every(request => request.method === 'GET'));
  } finally { await f.store.close(); }
});

test('internal failures do not become claims about Google and do not lose the pending event', async () => {
  const f = await fixture();
  try {
    const intents = new CalendarIntents(f.store, config.timeZone, async () => { throw new Error('private diagnostic'); });
    const reply = await intents.begin('alice', { ...change, end: completion.end, timingEvidence: '12h30 às 15h30' }, '12h30 às 15h30');
    assert.match(reply.text, /falha interna no Hub/);
    assert.doesNotMatch(reply.text, /private diagnostic|Google/);
    assert(await intents.pending('alice'));
  } finally { await f.store.close(); }
});

test('completion of an all-day date and missing title does not require repeating earlier fields', async () => {
  const f = await fixture();
  try {
    const intents = f.assistant.calendarIntents;
    await intents.begin('alice', { ...change, title: null, start: '2026-11-14', allDay: true, timingEvidence: 'dia inteiro' }, 'Dia 14/11/2026, dia inteiro');
    const id = (await intents.pending('alice'))!.id;
    const reply = await intents.complete('alice', { intentId: id, title: 'Conferência', start: null, end: null, allDay: null, timingEvidence: null }, 'Conferência');
    assert.match(reply.text, /último dia/);
    const preview = await intents.complete('alice', { ...completion, intentId: id, end: '2026-11-16', timingEvidence: null }, 'Até 15/11/2026');
    assert(preview.buttons?.length);
    assert.match(preview.text, /Conferência/);
  } finally { await f.store.close(); }
});

test('switching to a favorites query abandons the calendar request rather than borrowing its times later', async () => {
  const f = await fixture([() => call('guest_favorites', {}), () => responseText('Você ainda não tem favoritos.')]);
  try {
    await f.assistant.calendarIntents.begin('alice', change, first);
    await f.assistant.handle(incoming('Quais meus convidados favoritos?'));
    assert.equal(await f.assistant.calendarIntents.pending('alice'), null);
  } finally { await f.store.close(); }
});
