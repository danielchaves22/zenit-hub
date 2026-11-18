import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readConfig } from '../src/config.js';
import { OAuth, googleScopes } from '../src/oauth.js';
import { Guests } from '../src/guests.js';
import { Calendar } from '../src/connectors/calendar.js';
import { Day } from '../src/connectors/day.js';
import { Assistant } from '../src/assistant.js';
import { digest } from '../src/security.js';
import { createTestStore } from './database-helper.js';
import type { Reply, Connection } from '../src/types.js';

const config = readConfig({ DATABASE_URL: 'postgresql://localhost/zenit_hub_test', HUB_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  OPENAI_API_KEY: 'test', WHATSAPP_GUESTS_FLOW_ID: '123' });
const connection: Connection = { sender: 'alice', provider: 'calendar', accountId: 'account-alice', label: 'alice@example.com',
  tokens: { access_token: 'test', refresh_token: 'test', expires_at: Date.now() + 3600000, scope: googleScopes.join(' ') } };
const create = { operation: 'create', calendarId: 'primary', eventId: null, title: 'Almoço', description: null, location: null,
  start: '2026-12-23T12:30:00-03:00', end: '2026-12-23T15:30:00-03:00', allDay: false, timingEvidence: 'das 12h30 às 15h30', reminderMinutes: null };
const revision = { title: null, description: null, location: null, start: null, end: null, allDay: null, timingEvidence: null, reminderMinutes: null };
const token = (r: Reply) => r.buttons![0].id.split(':')[3];
const btn = (r: Reply, title: string) => r.buttons!.find(b => b.title === title)!.id;

async function setup() {
  const store = await createTestStore(config.key); await store.connect(connection);
  const oauth = new OAuth(config, store); const guests = new Guests(store);
  const writes: { url: string; body: any; method: string }[] = [];
  const fixture = { role: 'owner' };
  const calendar = new Calendar(oauth, async (url, init = {}) => {
    if (init.method) {
      writes.push({ url: String(url), body: JSON.parse(String(init.body)), method: init.method });
      return Response.json({ id: 'created' });
    }
    if (String(url).includes('/calendarList/')) {
      const id = decodeURIComponent(String(url).split('/').at(-1)!);
      return Response.json({ id: id === 'primary' ? 'personal@example.com' : id, summary: id === 'work' ? 'Trabalho' : 'Pessoal', accessRole: fixture.role });
    }
    return Response.json({ id: 'event123', etag: 'v1', summary: 'Anterior', start: { dateTime: create.start }, end: { dateTime: create.end }, organizer: { self: true } });
  });
  const automatic = async (on: boolean, operation = 'update', calendarId = 'primary') => {
    const r = await calendar.prepareFavorite('alice', { operation, target: operation === 'add' ? null : 'Ana',
      name: operation === 'add' ? 'Ana' : null, email: operation === 'add' ? 'ana@example.com' : null, automatic: on, calendarId });
    await guests.confirm('alice', token(r), true); return r;
  };
  return { store, oauth, guests, calendar, writes, fixture, automatic };
}

test('confirmed default is scoped to the resolved calendar and appears on the first preview with three buttons', async () => {
  const f = await setup();
  try {
    const proposed = await f.calendar.prepareFavorite('alice', { operation: 'add', target: null, name: 'Ana', email: 'ana@example.com', automatic: true, calendarId: 'primary' });
    assert.match(proposed.text, /Convite automático: ativar\nAgenda: Pessoal\nConta Google: alice@example.com/);
    assert.deepEqual((await f.guests.list('alice')).items, []);
    await f.guests.confirm('alice', token(proposed), true);
    assert.equal((await f.guests.list('alice')).items[0].automatic![0].calendarId, 'personal@example.com');
    assert.match((await f.guests.listing('alice')).text, /Automático em: Pessoal/);
    const p = await f.calendar.prepare('alice', create);
    assert.match(p.text, /Convidados incluídos automaticamente:[\s\S]*Ana — ana@example.com/);
    assert.deepEqual(p.buttons!.map(b => b.title), ['Confirmar', 'Convidados', 'Cancelar']);
    assert.equal(f.writes.length, 0);
    const raw = JSON.stringify((await f.store.db.query('SELECT data FROM guest_favorites UNION ALL SELECT data FROM calendar_drafts')).rows);
    assert(!raw.includes('ana@example.com')); assert(!raw.includes('personal@example.com'));
    await Promise.all([f.calendar.confirm('alice', token(p), true), f.calendar.confirm('alice', token(p), true)]);
    assert.equal(f.writes.length, 1); assert.deepEqual(f.writes[0].body.attendees, [{ email: 'ana@example.com' }]);
    assert.equal(new URL(f.writes[0].url).searchParams.get('sendUpdates'), 'all');
  } finally { await f.store.close(); }
});

test('none removes automatic guests, survives corrections and reopening, and does not change future defaults', async () => {
  const f = await setup();
  try {
    await f.automatic(true, 'add');
    const first = await f.calendar.prepare('alice', create);
    const original = await f.calendar.pendingCreation('alice');
    const deadline = (await f.store.db.query('SELECT expires FROM calendar_drafts WHERE hash=$1', [digest(token(first))])).rows[0].expires;
    const editor = await f.calendar.openGuests('alice', token(first));
    assert.equal(editor.flow, undefined); assert.match(editor.text, /Seleção atual: ana@example.com/);
    assert(btn(editor, 'Sem convidados')); assert.equal(f.writes.length, 0);
    await assert.rejects(f.calendar.confirm('alice', token(first), true));
    const none = await f.calendar.selectGuests('alice', token(editor), []);
    assert.match(none.text, /Convidados: nenhum/); assert(!none.text.includes('ana@example.com'));
    const fixed = await f.calendar.reviseCreation('alice', { ...revision, title: 'Almoço corrigido', end: '2026-12-23T16:00:00-03:00' });
    assert.match(fixed.text, /Almoço corrigido/); assert.match(fixed.text, /Convidados: nenhum/);
    assert.equal((await f.calendar.pendingCreation('alice'))!.eventId, original!.eventId);
    assert.equal((await f.store.db.query('SELECT expires FROM calendar_drafts WHERE hash=$1', [digest(token(fixed))])).rows[0].expires, deadline);
    await assert.rejects(f.calendar.confirm('alice', token(none), true));
    const again = await f.calendar.openGuests('alice', token(fixed));
    const cleared = await f.calendar.selectGuests('alice', again.flow?.token || token(again), []);
    assert.equal((cleared.text.match(/Convidados:/g) || []).length, 1);
    await f.calendar.confirm('alice', token(cleared), true);
    assert.deepEqual(f.writes[0].body.attendees, []);
    assert.equal(f.writes[0].body.end.dateTime, '2026-12-23T16:00:00-03:00');
    assert.match((await f.calendar.prepare('alice', create)).text, /incluídos automaticamente:[\s\S]*ana@example.com/);
  } finally { await f.store.close(); }
});

test('defaults never cross sender, Google account or calendar, and never alter existing events', async () => {
  const f = await setup();
  try {
    await f.automatic(true, 'add');
    const work = await f.calendar.prepare('alice', { ...create, calendarId: 'work' });
    assert.match(work.text, /Convidados: nenhum/);
    await f.store.connect({ ...connection, sender: 'bob' });
    assert.match((await f.calendar.prepare('bob', create)).text, /Convidados: nenhum/);
    await f.store.connect({ ...connection, accountId: 'other-account' });
    assert.match((await f.calendar.prepare('alice', create)).text, /Convidados: nenhum/);
    await f.store.connect(connection);
    assert.match((await f.calendar.prepare('alice', create)).text, /incluídos automaticamente/);
    const edit = await f.calendar.prepare('alice', { ...create, operation: 'update', eventId: 'event123', title: 'Corrigido', start: null, end: null, allDay: null });
    await f.calendar.confirm('alice', token(edit), true);
    assert.equal(f.writes[0].method, 'PATCH'); assert(!('attendees' in f.writes[0].body));
    f.fixture.role = 'reader'; await assert.rejects(f.automatic(true), /permissão/);
  } finally { await f.store.close(); }
});

test('turning off a default keeps the favorite and reviewed drafts keep exactly their displayed emails', async () => {
  const f = await setup();
  try {
    await f.automatic(true, 'add');
    const old = await f.calendar.prepare('alice', create);
    await f.automatic(false);
    assert.equal((await f.guests.list('alice')).items.length, 1);
    assert.match((await f.guests.listing('alice')).text, /Convite manual/);
    await f.calendar.confirm('alice', token(old), true);
    assert.deepEqual(f.writes[0].body.attendees, [{ email: 'ana@example.com' }]);
    const next = await f.calendar.prepare('alice', create); assert.match(next.text, /Convidados: nenhum/);
    await f.calendar.confirm('alice', token(next), false); assert.equal(f.writes.length, 1);
    await f.automatic(true);
    const another = await f.calendar.prepare('alice', create);
    const removal = await f.guests.prepare('alice', { operation: 'remove', target: 'Ana', name: null, email: null });
    await f.guests.confirm('alice', token(removal), true);
    await f.calendar.confirm('alice', token(another), false);
    assert.match((await f.calendar.prepare('alice', create)).text, /Convidados: nenhum/);
  } finally { await f.store.close(); }
});

test('manual selection replaces defaults, can be reopened and old confirmation cannot send a previous list', async () => {
  const f = await setup();
  try {
    await f.automatic(true, 'add');
    const add = await f.guests.prepare('alice', { operation: 'add', target: null, name: 'Bruno', email: 'bruno@example.com' });
    await f.guests.confirm('alice', token(add), true);
    const initial = await f.calendar.prepare('alice', create);
    await f.calendar.openGuests('alice', token(initial));
    const manual = (await f.calendar.tryGuestNumbers('alice', ['2', '02']))!;
    assert.match(manual.text, /Bruno — bruno@example.com/); assert(!manual.text.includes('ana@example.com'));
    const editor = await f.calendar.openGuests('alice', token(manual));
    await assert.rejects(f.calendar.confirm('alice', token(manual), true));
    const latest = await f.calendar.selectGuestNames('alice', ['Ana', 'Bruno']);
    await assert.rejects(f.calendar.selectGuests('alice', token(editor), []));
    await f.calendar.confirm('alice', token(latest), true);
    assert.deepEqual(f.writes[0].body.attendees, [{ email: 'ana@example.com' }, { email: 'bruno@example.com' }]);
    assert.equal(f.writes.length, 1);
  } finally { await f.store.close(); }
});

test('WhatsApp configures automatic invitations and revises an empty selection through separate confirmed tools', async () => {
  const f = await setup();
  try {
    let call = 0;
    const tools = [ { name: 'guest_favorite_prepare', arguments: { operation: 'add', target: null, name: 'Ana', email: 'ana@example.com', automatic: true, calendarId: 'primary' } },
      { name: 'calendar_prepare', arguments: create },
      { name: 'calendar_revise_draft', arguments: { ...revision, end: '2026-12-23T16:00:00-03:00', timingEvidence: 'termine às 16h' } } ];
    const assistant = new Assistant(config, f.store, f.oauth, {} as any, new Day(f.oauth), f.calendar, async (_url, init) => {
      const tool = tools[call++]; assert(JSON.parse(String(init?.body)).tools.some((t: any) => t.name === tool.name));
      return Response.json({ output: [{ type: 'function_call', name: tool.name, arguments: JSON.stringify(tool.arguments), call_id: String(call) }] });
    });
    const message = { id: 'test', sender: 'alice', text: '', timestamp: Date.now() / 1000 };
    const [configReply] = await assistant.handle({ ...message, text: 'Sempre convide Ana, ana@example.com, na minha agenda principal' });
    await assistant.handle({ ...message, button: btn(configReply, 'Confirmar') });
    const [preview] = await assistant.handle({ ...message, text: 'Crie Almoço em 23/12/2026 das 12h30 às 15h30' });
    const [editor] = await assistant.handle({ ...message, button: btn(preview, 'Convidados') });
    const [none] = await assistant.handle({ ...message, button: btn(editor, 'Sem convidados') });
    assert.match(none.text, /Convidados: nenhum/); assert.equal(call, 2);
    const [revised] = await assistant.handle({ ...message, text: 'Corrija para que termine às 16h' });
    assert.match(revised.text, /16:00/); assert.match(revised.text, /Convidados: nenhum/);
    assert.equal(f.writes.length, 0);
    await assistant.handle({ ...message, button: btn(revised, 'Confirmar') });
    assert.equal(f.writes.length, 1); assert.deepEqual(f.writes[0].body.attendees, []);
  } finally { await f.store.close(); }
});
