import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readConfig } from '../src/config.js';
import { OAuth, googleScopes } from '../src/oauth.js';
import { Calendar } from '../src/connectors/calendar.js';
import { createTestStore } from './database-helper.js';
import { migrate } from '../src/migrations.js';
import { digest } from '../src/security.js';
import type { Connection, Reply } from '../src/types.js';

const config = readConfig({ DATABASE_URL: 'postgresql://localhost/zenit_hub_test', HUB_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
const connection: Connection = { sender: 'alice', provider: 'calendar', accountId: 'google-alice', label: 'alice@example.com',
  tokens: { access_token: 'private-access', refresh_token: 'private-refresh', expires_at: Date.now() + 3600000, scope: googleScopes.join(' ') } };
const create = { operation: 'create', calendarId: 'primary', eventId: null, title: 'Show Crossroads', description: null, location: null,
  start: '2026-12-23T14:00:00-03:00', end: '2026-12-23T17:00:00-03:00', allDay: false, reminderMinutes: null };
const update = { ...create, operation: 'update', eventId: 'event123', title: 'Novo título', start: null, end: null, allDay: null };
const remove = { ...update, operation: 'delete', title: null };
const token = (r: Reply) => r.buttons![0].id.split(':')[3];
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
async function setup() {
  const store = await createTestStore(config.key); await store.connect(connection);
  const calls: { url: URL; init: RequestInit }[] = [];
  const fixture = { role: 'owner', status: 200, fail: false, series: false, eventType: 'default',
    calendar: undefined as Calendar | undefined, store, calls };
  const fetcher = (async (url, init = {}) => {
    calls.push({ url: new URL(String(url)), init });
    if (init.method && init.method !== 'GET') {
      if (fixture.fail) throw new Error('simulated connection lost after remote acceptance');
      return init.method === 'DELETE' && fixture.status === 200 ? new Response(null, { status: 204 }) : json({ id: 'result' }, fixture.status);
    }
    if (String(url).includes('/calendarList/')) return json({ id: 'alice-calendar', summary: 'Pessoal', accessRole: fixture.role });
    return json({ id: 'event123', etag: '"v1"', summary: 'Título anterior', start: { dateTime: create.start }, end: { dateTime: create.end },
      description: 'Conteúdo preservado', eventType: fixture.eventType, attendees: [{ email: 'guest@example.com' }], organizer: { self: true },
      ...(fixture.series ? { recurrence: ['RRULE:FREQ=WEEKLY'] } : {}) });
  }) as typeof fetch;
  fixture.calendar = new Calendar(new OAuth(config, store), fetcher);
  return { ...fixture, fixture, calendar: fixture.calendar };
}

test('create only persists an encrypted preview; same-sender button executes once even on concurrent replay', async () => {
  const { store, calendar, calls } = await setup();
  try {
    const preview = await calendar.prepare('alice', create); const key = token(preview);
    assert.match(preview.text, /23\/12\/2026,? 14:00/); assert.match(preview.text, /17:00/);
    assert(calls.every(c => !c.init.method));
    const raw = JSON.stringify((await store.db.query('SELECT * FROM calendar_drafts')).rows);
    assert(!raw.includes('Crossroads')); assert(!raw.includes('private-access')); assert(!raw.includes(key));
    await assert.rejects(calendar.confirm('bob', key, true));
    await Promise.all([calendar.confirm('alice', key, true), calendar.confirm('alice', key, true)]);
    assert.match((await calendar.confirm('alice', key, true)).text, /Evento criado/);
    const writes = calls.filter(c => c.init.method === 'POST'); assert.equal(writes.length, 1);
    const body = JSON.parse(String(writes[0].init.body));
    assert.match(body.id, /^[0-9a-f]{32}$/); assert.equal(body.start.dateTime, create.start);
    assert.equal(body.start.timeZone, 'America/Sao_Paulo'); assert.equal(body.summary, create.title);
  } finally { await store.close(); }
});

test('update previews the real event and guest notifications, then patches only requested fields with If-Match', async () => {
  const { store, calendar, calls } = await setup();
  try {
    const preview = await calendar.prepare('alice', update);
    assert.match(preview.text, /Título anterior/); assert.match(preview.text, /Novo título/);
    assert.match(preview.text, /guest@example.com/); assert.match(preview.text, /notificar/);
    assert.match((await calendar.confirm('alice', token(preview), true)).text, /Evento alterado/);
    const write = calls.find(c => c.init.method === 'PATCH')!;
    assert.deepEqual(JSON.parse(String(write.init.body)), { summary: update.title });
    assert.equal((write.init.headers as any)['If-Match'], '"v1"');
    assert.equal(write.url.searchParams.get('sendUpdates'), 'all');
  } finally { await store.close(); }
});

test('delete handles empty 204 and stale events fail closed without retrying', async () => {
  const { store, calendar, calls, fixture } = await setup();
  try {
    let preview = await calendar.prepare('alice', remove);
    assert.match((await calendar.confirm('alice', token(preview), true)).text, /Evento excluído/);
    assert.equal((calls.find(c => c.init.method === 'DELETE')!.init.headers as any)['If-Match'], '"v1"');
    fixture.status = 412; preview = await calendar.prepare('alice', update);
    assert.match((await calendar.confirm('alice', token(preview), true)).text, /mudou no Google/);
    await calendar.confirm('alice', token(preview), true);
    assert.equal(calls.filter(c => c.init.method === 'PATCH').length, 1);
  } finally { await store.close(); }
});

test('old read-only grants, reader calendars, series and special events cannot acquire mutation drafts', async () => {
  const { store, calendar, fixture } = await setup();
  try {
    await store.connect({ ...connection, tokens: { ...connection.tokens, scope: 'https://www.googleapis.com/auth/calendar.events.readonly' } });
    await assert.rejects(calendar.prepare('alice', create), /Autorize a escrita/);
    await store.connect(connection); fixture.role = 'reader';
    await assert.rejects(calendar.prepare('alice', create), /só pode consultar/);
    fixture.role = 'owner'; fixture.series = true;
    await assert.rejects(calendar.prepare('alice', update), /série inteira/);
    fixture.series = false; fixture.eventType = 'birthday';
    await assert.rejects(calendar.prepare('alice', update), /evento especial/);
    assert.equal((await store.db.query('SELECT count(*)::int AS n FROM calendar_drafts')).rows[0].n, 0);
  } finally { await store.close(); }
});

test('cancel, replacement, expiry, reconnect and disconnect invalidate previous buttons', async () => {
  const { store, calendar, calls } = await setup();
  try {
    let previous = await calendar.prepare('alice', create);
    await calendar.confirm('alice', token(previous), false);
    await assert.rejects(calendar.confirm('alice', token(previous), true));
    previous = await calendar.prepare('alice', create);
    let latest = await calendar.prepare('alice', { ...create, title: 'Revisado' });
    await assert.rejects(calendar.confirm('alice', token(previous), true));
    await store.db.query('UPDATE calendar_drafts SET expires=0 WHERE hash=$1', [digest(token(latest))]);
    await assert.rejects(calendar.confirm('alice', token(latest), true));
    latest = await calendar.prepare('alice', create);
    await store.connect(connection); // Even reauthorizing the SAME account creates a different grant.
    await assert.rejects(calendar.confirm('alice', token(latest), true));
    latest = await calendar.prepare('alice', create); await store.disconnect('alice', 'calendar');
    await assert.rejects(calendar.confirm('alice', token(latest), true));
    assert(!calls.some(c => c.init.method));
  } finally { await store.close(); }
});

test('token refresh preserves draft ownership; failures of unknown outcome are quarantined', async () => {
  const { store, calendar, calls, fixture } = await setup();
  try {
    const preview = await calendar.prepare('alice', create);
    const current = (await store.connection('alice', 'calendar'))!;
    await store.refreshConnection(current, { ...current.tokens, access_token: 'new-access', refresh_token: 'rotated-refresh' });
    fixture.fail = true;
    assert.match((await calendar.confirm('alice', token(preview), true)).text, /Não vou repetir/);
    await calendar.confirm('alice', token(preview), true);
    assert.equal(calls.filter(c => c.init.method === 'POST').length, 1);
    assert.equal((await store.calendarDraftResult('alice', token(preview)))?.state, 'uncertain');
  } finally { await store.close(); }
});

test('all-day boundaries and reminders are explicit; invalid dates and partial timing edits are rejected', async () => {
  const { store, calendar, calls } = await setup();
  try {
    const preview = await calendar.prepare('alice', { ...create, start: '2026-12-23', end: '2026-12-24', allDay: true, reminderMinutes: [] });
    assert.match(preview.text, /Dia inteiro: 23\/12\/2026/); assert(!preview.text.includes('24/12/2026'));
    await calendar.confirm('alice', token(preview), true);
    const body = JSON.parse(String(calls.find(c => c.init.method === 'POST')!.init.body));
    assert.deepEqual(body.start, { date: '2026-12-23' }); assert.deepEqual(body.reminders, { useDefault: false, overrides: [] });
    await assert.rejects(calendar.prepare('alice', { ...create, start: '2026-02-30', end: '2026-03-03', allDay: true }));
    await assert.rejects(calendar.prepare('alice', { ...create, start: create.end, end: create.start }));
    await assert.rejects(calendar.prepare('alice', { ...update, start: create.start }));
  } finally { await store.close(); }
});

test('migration from version 1 preserves connections; worker recovery never replays an interrupted mutation', async () => {
  const { store } = await setup();
  try {
    const saved = await store.connection('alice', 'calendar');
    await store.db.query('DROP TABLE calendar_drafts'); await store.db.query('DELETE FROM hub_schema_migrations WHERE version=2');
    await migrate(store.db); await migrate(store.db); await store.ready();
    assert.deepEqual(await store.connection('alice', 'calendar'), saved);
    await store.calendarDraft('alice', 'interrupted', { test: true });
    await store.claimCalendarDraft('alice', 'interrupted', true); await store.startWorker();
    assert.equal((await store.calendarDraftResult('alice', 'interrupted'))?.state, 'uncertain');
    assert.equal(await store.claimCalendarDraft('alice', 'interrupted', true), null);
  } finally { await store.close(); }
});
