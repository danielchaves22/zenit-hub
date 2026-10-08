import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readConfig } from '../src/config.js';
import { createTestStore } from './database-helper.js';
import { Guests } from '../src/guests.js';
import { Calendar } from '../src/connectors/calendar.js';
import { OAuth, googleScopes } from '../src/oauth.js';
import { Assistant } from '../src/assistant.js';
import { Day } from '../src/connectors/day.js';
import { digest } from '../src/security.js';
import type { Reply, Connection } from '../src/types.js';

const config = readConfig({ DATABASE_URL: 'postgresql://localhost/zenit_hub_test', HUB_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  OPENAI_API_KEY: 'test', OPENAI_MODEL: 'test' });
const connection: Connection = { sender: 'alice', provider: 'calendar', accountId: 'google-alice', label: 'alice@example.com',
  tokens: { access_token: 'secret', refresh_token: 'refresh', expires_at: Date.now() + 3600000, scope: googleScopes.join(' ') } };
const request = { calendarId: 'primary', eventId: 'event123', names: null };
const token = (r: Reply) => r.buttons![0].id.split(':')[3];
const event = { id: 'event123', etag: '"v1"', summary: 'Reunião', organizer: { self: true },
  start: { dateTime: '2026-12-23T14:00:00-03:00' }, end: { dateTime: '2026-12-23T17:00:00-03:00' },
  attendees: [{ email: 'ANA@example.com', displayName: 'Ana', responseStatus: 'accepted', optional: true, comment: 'Confirmado', additionalGuests: 1 },
    { email: 'room@example.com', resource: true, responseStatus: 'accepted' }],
  description: 'Preservar', location: 'Sala 1', conferenceData: { conferenceId: 'meet-id' }, reminders: { useDefault: true } };
async function setup(flow = false) {
  const store = await createTestStore(config.key); await store.connect(connection);
  const localConfig = { ...config, meta: { ...config.meta, guestsFlowId: flow ? '5678' : undefined } };
  const oauth = new OAuth(localConfig, store); const guests = new Guests(store);
  const fixture = { event: structuredClone(event) as any, role: 'owner', status: 200, fail: false };
  const writes: { url: string; init: RequestInit }[] = [];
  const calendar = new Calendar(oauth, async (url, init = {}) => {
    if (init.method) {
      writes.push({ url: String(url), init });
      if (fixture.fail) throw new Error('Lost response');
      return new Response(JSON.stringify({ id: event.id }), { status: fixture.status });
    }
    if (String(url).includes('/calendarList/')) return Response.json({ id: 'alice-calendar', summary: 'Pessoal', accessRole: fixture.role });
    if (new URL(String(url)).pathname.endsWith('/events')) return Response.json({ items: [fixture.event] });
    return Response.json(fixture.event);
  });
  const add = async (name: string, email: string) => { const r = await guests.prepare('alice', { operation: 'add', target: null, name, email }); await guests.confirm('alice', token(r), true); };
  return { store, localConfig, oauth, guests, calendar, fixture, writes, add };
}

test('adding favorite guests preserves the entire attendee list and RSVP, deduplicates and requires the latest owner button', async () => {
  const { store, calendar, writes, add } = await setup();
  try {
    await add('Ana', 'ana@example.com'); await add('Bruno', 'bruno@example.com');
    const draft = await calendar.prepareGuestAddition('alice', request);
    assert.match(draft.text, /Adicionar convidados/);
    assert.match((await calendar.openGuests('alice', token(draft))).text, /1\. Ana.*\n2\. Bruno/);
    await assert.rejects(calendar.confirm('alice', token(draft), true), /Escolha/);
    const preview = (await calendar.tryGuestNumbers('alice', ['1', '2', '2']))!;
    assert.match(preview.text, /Novos convidados:[\s\S]*bruno@example.com/);
    assert.match(preview.text, /já participam/); assert.equal(preview.buttons![0].title, 'Adicionar e convidar');
    assert.equal(writes.length, 0);
    await assert.rejects(calendar.confirm('alice', token(draft), true));
    await assert.rejects(calendar.confirm('bob', token(preview), true));
    await Promise.all([calendar.confirm('alice', token(preview), true), calendar.confirm('alice', token(preview), true)]);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].init.method, 'PATCH');
    assert.deepEqual(JSON.parse(String(writes[0].init.body)), { attendees: [...event.attendees, { email: 'bruno@example.com' }] });
    assert.equal((writes[0].init.headers as any)['If-Match'], event.etag);
    const url = new URL(writes[0].url);
    assert.equal(url.pathname, '/calendar/v3/calendars/alice-calendar/events/event123');
    assert.equal(url.searchParams.get('sendUpdates'), 'all');
  } finally { await store.close(); }
});

test('explicit emails work without favorites, do not become favorites, and duplicate-only selections never mutate', async () => {
  const { store, calendar, guests, writes } = await setup();
  try {
    let preview = await calendar.prepareGuestAddition('alice', { ...request, names: ['New@example.com', 'new@example.com'] });
    assert.match(preview.text, /new@example.com/);
    assert.deepEqual((await guests.list('alice')).items, []); assert.equal(writes.length, 0);
    const raw = JSON.stringify((await store.db.query('SELECT data FROM calendar_drafts')).rows);
    assert(!raw.includes('new@example.com')); assert(!raw.includes('ANA@example.com'));
    await calendar.confirm('alice', token(preview), true);
    assert.deepEqual(JSON.parse(String(writes[0].init.body)).attendees, [...event.attendees, { email: 'new@example.com' }]);
    await assert.rejects(calendar.prepareGuestAddition('alice', { ...request, names: ['ana@example.com'] }), /já participam/);
    await assert.rejects(calendar.selectGuestNames('alice', ['not-an-email']), /favorito/);
    preview = await calendar.selectGuestNames('alice', ['another@example.com']);
    await calendar.confirm('alice', token(preview), false);
    assert.equal(writes.length, 1);
  } finally { await store.close(); }
});

test('empty addition cancels without clearing existing attendees, including the Flow path', async () => {
  const { store, calendar, writes, add } = await setup(true);
  try {
    await add('Bruno', 'bruno@example.com');
    let draft = await calendar.prepareGuestAddition('alice', request);
    const flow = (await calendar.openGuests('alice', token(draft))).flow!;
    assert.equal(flow.favorites.length, 1);
    assert.match((await calendar.selectGuests('alice', flow.token, [])).text, /cancelada/);
    await assert.rejects(calendar.confirm('alice', flow.token, true));
    draft = await calendar.prepareGuestAddition('alice', request);
    const picked = await calendar.selectGuests('alice', token(draft), [flow.favorites[0].id]);
    await calendar.confirm('alice', token(picked), true);
    assert.deepEqual(JSON.parse(String(writes[0].init.body)).attendees, [...event.attendees, { email: 'bruno@example.com' }]);
    assert.equal(writes.length, 1);
  } finally { await store.close(); }
});

test('incomplete attendees, non-organizers, read-only calendars, entire series and special events are refused before drafting', async () => {
  const { store, calendar, fixture, writes } = await setup();
  try {
    for (const [change, pattern] of [
      [{ organizer: { self: false } }, /organizados/], [{ attendeesOmitted: true }, /todos os convidados/],
      [{ attendees: [{}] }, /lista completa/], [{ attendees: [{ email: 'group@example.com', asyncOperation: 'inProgress' }] }, /lista completa/],
      [{ recurrence: ['RRULE:FREQ=WEEKLY'] }, /série inteira/], [{ eventType: 'birthday' }, /especial/], [{ status: 'cancelled' }, /não está disponível/]
    ] as const) {
      fixture.event = { ...structuredClone(event), ...change };
      await assert.rejects(calendar.prepareGuestAddition('alice', request), pattern);
    }
    fixture.event = structuredClone(event); fixture.role = 'reader';
    await assert.rejects(calendar.prepareGuestAddition('alice', request), /só pode consultar/);
    fixture.role = 'owner';
    await store.connect({ ...connection, tokens: { ...connection.tokens, scope: 'https://www.googleapis.com/auth/calendar.events.readonly' } });
    await assert.rejects(calendar.prepareGuestAddition('alice', request), /Autorize a escrita/);
    assert.equal((await store.db.query('SELECT count(*)::int AS n FROM calendar_drafts')).rows[0].n, 0);
    assert.equal(writes.length, 0);
  } finally { await store.close(); }
});

test('single recurring occurrences work, stale events and uncertain requests are never retried', async () => {
  const { store, calendar, fixture, writes } = await setup();
  try {
    fixture.event.recurringEventId = 'series123';
    let preview = await calendar.prepareGuestAddition('alice', { ...request, names: ['new@example.com'] });
    assert.match(preview.text, /Somente esta ocorrência/);
    fixture.status = 412;
    assert.match((await calendar.confirm('alice', token(preview), true)).text, /mudou no Google/);
    await calendar.confirm('alice', token(preview), true); assert.equal(writes.length, 1);
    fixture.fail = true;
    preview = await calendar.prepareGuestAddition('alice', { ...request, names: ['new@example.com'] });
    assert.match((await calendar.confirm('alice', token(preview), true)).text, /Não vou repetir/);
    await calendar.confirm('alice', token(preview), true); assert.equal(writes.length, 2);
  } finally { await store.close(); }
});

test('guest addition rejects expired, reconnected and changed-favorites drafts; final reviewed emails remain stable', async () => {
  const { store, calendar, writes, add } = await setup();
  try {
    await add('Bruno', 'bruno@example.com');
    let draft = await calendar.prepareGuestAddition('alice', request);
    await add('Carol', 'carol@example.com');
    await assert.rejects(calendar.selectGuestNames('alice', ['1']), /favoritos mudaram/);
    draft = await calendar.prepareGuestAddition('alice', request);
    await store.db.query('UPDATE calendar_drafts SET expires=0 WHERE hash=$1', [digest(token(draft))]);
    await assert.rejects(calendar.selectGuestNames('alice', ['1']), /expirou/);
    draft = await calendar.prepareGuestAddition('alice', { ...request, names: ['Bruno'] });
    await store.connect(connection);
    await assert.rejects(calendar.confirm('alice', token(draft), true)); assert.equal(writes.length, 0);
    draft = await calendar.prepareGuestAddition('alice', { ...request, names: ['Bruno'] });
    await add('Daniel', 'daniel@example.com');
    await calendar.confirm('alice', token(draft), true);
    assert.deepEqual(JSON.parse(String(writes[0].init.body)).attendees, [...event.attendees, { email: 'bruno@example.com' }]);
  } finally { await store.close(); }
});

test('assistant requires freshly queried event IDs and routes additions to Calendar, never Cash', async () => {
  const { store, calendar, oauth, writes, localConfig, add } = await setup();
  try {
    await add('Bruno', 'bruno@example.com');
    const steps = [
      { name: 'calendar_add_guests', args: { ...request, names: ['Bruno'] } },
      { name: 'calendar_events', args: { calendarId: 'primary', start: '2026-12-23T00:00:00-03:00', end: '2026-12-24T00:00:00-03:00', limit: 20 } },
      { name: 'calendar_add_guests', args: { ...request, names: ['Bruno'] } }
    ];
    let calls = 0;
    const assistant = new Assistant(localConfig, store, oauth, { connected: async () => true, message: async () => { throw new Error('Wrong Cash route'); } } as any,
      new Day(oauth), calendar, async (_url, init) => {
        const req = JSON.parse(String(init?.body));
        assert(req.tools.some((t: any) => t.name === 'calendar_add_guests'));
        if (calls === 1) {
          assert.match(req.input.at(-1).output, /Consulte calendar_events/);
          assert.equal(await store.pendingCalendarDraft('alice'), null);
        }
        const step = steps[calls++];
        return Response.json({ output: [{ type: 'function_call', name: step.name, arguments: JSON.stringify(step.args), call_id: String(calls) }] });
      });
    const message = { id: 'wamid.add-guests', sender: 'alice', text: 'Adicione Bruno à reunião de 23/12/2026', timestamp: Date.now() / 1000 };
    const [preview] = await assistant.handle(message);
    assert.match(preview.text, /Adicionar convidados/); assert.equal(calls, 3); assert.equal(writes.length, 0);
    await assistant.handle({ ...message, text: '', button: preview.buttons![0].id });
    assert.equal(calls, 3); assert.equal(writes.length, 1);
  } finally { await store.close(); }
});
