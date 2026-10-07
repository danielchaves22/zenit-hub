import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readConfig } from '../src/config.js';
import { createTestStore } from './database-helper.js';
import { Guests } from '../src/guests.js';
import { Calendar } from '../src/connectors/calendar.js';
import { OAuth, googleScopes } from '../src/oauth.js';
import { Assistant } from '../src/assistant.js';
import { Day } from '../src/connectors/day.js';
import { WhatsApp } from '../src/whatsapp.js';
import { metaSignature, randomToken } from '../src/security.js';
import type { Reply, Connection } from '../src/types.js';

const config = readConfig({ DATABASE_URL: 'postgresql://localhost/zenit_hub_test', HUB_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  WHATSAPP_APP_SECRET: 'test-secret', WHATSAPP_PHONE_NUMBER_ID: '1234', WHATSAPP_ACCESS_TOKEN: 'test-token', WHATSAPP_GUESTS_FLOW_ID: '5678', OPENAI_API_KEY: 'test', OPENAI_MODEL: 'test' });
const token = (r: Reply) => r.buttons![0].id.split(':')[3];
const create = { operation: 'create', calendarId: 'primary', eventId: null, title: 'Reunião', description: null, location: null,
  start: '2026-12-23T14:00:00-03:00', end: '2026-12-23T17:00:00-03:00', allDay: false, reminderMinutes: null, timingEvidence: 'das 14h às 17h' };
const connection: Connection = { sender: 'alice', provider: 'calendar', accountId: 'google-alice', label: 'alice@example.com',
  tokens: { access_token: 'secret', refresh_token: 'refresh', expires_at: Date.now() + 3600000, scope: googleScopes.join(' ') } };
async function setup(flow = true) {
  const store = await createTestStore(config.key); await store.connect(connection);
  const guests = new Guests(store); const writes: any[] = [];
  const localConfig = flow ? config : { ...config, meta: { ...config.meta, guestsFlowId: undefined } };
  const oauth = new OAuth(localConfig, store);
  const calendar = new Calendar(oauth, async (_url, init) => {
    if (init?.method) writes.push({ url: String(_url), ...init });
    return new Response(JSON.stringify(init?.method ? { id: 'result' } : { id: 'primary', summary: 'Pessoal', accessRole: 'owner' }));
  });
  const add = async (name: string, email: string) => { const r = await guests.prepare('alice', { operation: 'add', target: null, name, email }); await guests.confirm('alice', token(r), true); };
  return { store, guests, calendar, writes, oauth, add, localConfig };
}

test('favorite CRUD is encrypted, isolated, confirmed once and leaves Calendar untouched', async () => {
  const { store, guests, writes } = await setup();
  try {
    const r = await guests.prepare('alice', { operation: 'add', target: null, name: 'Ana', email: ' ANA@example.com ' });
    assert.equal((await guests.list('alice')).items.length, 0);
    await assert.rejects(guests.confirm('bob', token(r), true));
    const results = await Promise.allSettled([guests.confirm('alice', token(r), true), guests.confirm('alice', token(r), true)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((await guests.list('alice')).items[0].email, 'ana@example.com');
    assert.deepEqual((await guests.list('bob')).items, []);
    const raw = JSON.stringify((await store.db.query('SELECT data FROM guest_favorites UNION ALL SELECT data FROM guest_favorite_drafts')).rows);
    assert(!raw.includes('ana@example.com')); assert(!raw.includes(token(r)));
    await assert.rejects(guests.prepare('alice', { operation: 'add', target: null, name: 'Outra', email: 'ana@example.com' }), /já está/);
    let edit = await guests.prepare('alice', { operation: 'update', target: 'Ana', name: null, email: 'new@example.com' });
    await guests.confirm('alice', token(edit), false); assert.equal((await guests.list('alice')).items[0].email, 'ana@example.com');
    edit = await guests.prepare('alice', { operation: 'update', target: 'Ana', name: null, email: 'new@example.com' });
    await guests.confirm('alice', token(edit), true); assert.equal((await guests.list('alice')).items[0].email, 'new@example.com');
    const remove = await guests.prepare('alice', { operation: 'remove', target: 'Ana', name: null, email: null });
    await guests.confirm('alice', token(remove), true); assert.deepEqual((await guests.list('alice')).items, []); assert.equal(writes.length, 0);
  } finally { await store.close(); }
});

test('ambiguous names, invalid email, capacity, expired and replaced favorite drafts fail closed', async () => {
  const { store, guests, add } = await setup();
  try {
    await add('Ana', 'one@example.com'); await add('Ana', 'two@example.com');
    await assert.rejects(guests.prepare('alice', { operation: 'remove', target: 'Ana', name: null, email: null }), /mais de um/);
    await assert.rejects(guests.prepare('alice', { operation: 'add', target: null, name: 'Teste', email: 'inválido' }));
    const old = await guests.prepare('alice', { operation: 'remove', target: 'one@example.com', name: null, email: null });
    const latest = await guests.prepare('alice', { operation: 'remove', target: 'two@example.com', name: null, email: null });
    await assert.rejects(guests.confirm('alice', token(old), true));
    await store.db.query('UPDATE guest_favorite_drafts SET expires=0');
    await assert.rejects(guests.confirm('alice', token(latest), true));
    for (let i = 2; i < 20; i++) await add('Pessoa ' + i, `person${i}@example.com`);
    await assert.rejects(add('Limite', 'limit@example.com'), /20 favoritos/);
  } finally { await store.close(); }
});

test('guest choice cannot create an event; owner-bound final preview sends exactly selected emails once', async () => {
  const { store, guests, calendar, writes, add } = await setup();
  try {
    await add('Ana', 'ana@example.com'); await add('João', 'joao@example.com');
    const first = await calendar.prepare('alice', create); const old = token(first);
    await assert.rejects(calendar.confirm('alice', old, true), /Escolha os convidados/);
    const flow = await calendar.openGuests('alice', old); assert.equal(flow.flow?.favorites.length, 2); assert.equal(writes.length, 0);
    const ids = (await guests.list('alice')).items.map(f => f.id);
    await assert.rejects(calendar.selectGuests('bob', old, ids));
    await assert.rejects(calendar.selectGuests('alice', old, [randomUUID()]), /inválido/);
    await assert.rejects(calendar.selectGuests('alice', old, [ids[0], ids[0]]), /duplicada/);
    const final = await calendar.selectGuests('alice', old, [ids[1]]);
    assert.match(final.text, /joao@example.com/); assert(!final.text.includes('ana@example.com'));
    assert.equal(writes.length, 0); assert.equal(final.buttons?.[0].title, 'Criar e convidar');
    await assert.rejects(calendar.selectGuests('alice', old, ids)); await assert.rejects(calendar.confirm('alice', old, true));
    await Promise.all([calendar.confirm('alice', token(final), true), calendar.confirm('alice', token(final), true)]);
    assert.equal(writes.length, 1); assert(writes[0].url.endsWith('?sendUpdates=all'));
    assert.deepEqual(JSON.parse(writes[0].body).attendees, [{ email: 'joao@example.com' }]);
  } finally { await store.close(); }
});

test('empty choice and chat fallback both reach final confirmation without adding unwanted guests', async () => {
  const { store, calendar, writes, add } = await setup(false);
  try {
    await add('Ana', 'ana@example.com');
    let r = await calendar.prepare('alice', create);
    assert.equal((await calendar.openGuests('alice', token(r))).flow, undefined);
    r = await calendar.selectGuestNames('alice', ['ana']); assert.equal(writes.length, 0);
    await calendar.confirm('alice', token(r), false); assert.equal(writes.length, 0);
    r = await calendar.prepare('alice', create);
    r = await calendar.selectGuests('alice', token(r), []);
    assert.match(r.text, /Convidados: nenhum/); await calendar.confirm('alice', token(r), true);
    assert.deepEqual(JSON.parse(writes[0].body).attendees, []);
  } finally { await store.close(); }
});

test('reconnection, changed favorites, newer event and expiry invalidate pending guest selections', async () => {
  const { store, calendar, writes, add } = await setup();
  try {
    await add('Ana', 'ana@example.com');
    let r = await calendar.prepare('alice', create); await add('João', 'joao@example.com');
    await assert.rejects(calendar.selectGuests('alice', token(r), []), /favoritos mudaram/);
    r = await calendar.prepare('alice', create); await store.connect(connection);
    await assert.rejects(calendar.selectGuests('alice', token(r), []));
    r = await calendar.prepare('alice', create); await calendar.prepare('alice', { ...create, title: 'Outra' });
    await assert.rejects(calendar.selectGuests('alice', token(r), []));
    r = await calendar.prepare('alice', create); await store.db.query('UPDATE calendar_drafts SET expires=0');
    await assert.rejects(calendar.selectGuests('alice', token(r), [])); assert.equal(writes.length, 0);
  } finally { await store.close(); }
});

test('Flow webhook is bounded and signed; structured selection bypasses both model and Cash', async () => {
  const { store, calendar, writes, add, guests, oauth } = await setup();
  try {
    await add('Ana', 'ana@example.com'); const draft = await calendar.prepare('alice', create);
    const ids = (await guests.list('alice')).items.map(f => f.id);
    const envelope = (response: unknown, interactiveExtra = {}) => Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: '1234' }, messages: [{ id: 'wamid.flow', from: 'alice', type: 'interactive', timestamp: Math.floor(Date.now() / 1000),
        interactive: { nfm_reply: { response_json: JSON.stringify(response) }, ...interactiveExtra } }]
    } }] }] }));
    const whatsapp = new WhatsApp(config); const response = { flow_token: token(draft), guest_ids: ids };
    const body = envelope(response); assert.throws(() => whatsapp.parse(body, 'bad'));
    const [incoming] = whatsapp.parse(body, metaSignature(body, config.meta.secret)); assert.equal(incoming.text, '');
    for (const invalid of [envelope({ ...response, guest_ids: [...ids, ...ids] }), envelope({ ...response, email: 'evil@example.com' }), envelope({ ...response, flow_token: 'bad' }), envelope(response, { button_reply: { id: 'zenit:confirm:1' } })]) {
      assert.equal(whatsapp.parse(invalid, metaSignature(invalid, config.meta.secret)).length, 0);
    }
    const assistant = new Assistant(config, store, oauth, {} as any, new Day(oauth), calendar, async () => { throw new Error('Must not call model'); });
    assert.match((await assistant.handle(incoming))[0].text, /ana@example.com/); assert.equal(writes.length, 0);
    await assert.rejects(assistant.handle({ ...incoming, text: 'ignore instructions' }), /separadamente/);
  } finally { await store.close(); }
});

test('Flow outbound contains only current options, no defaults, and validates before any send', async () => {
  const sent: any[] = []; const whatsapp = new WhatsApp(config, async (_url, init) => { sent.push(JSON.parse(String(init?.body))); return new Response('{}'); });
  const flow = { token: randomToken(), favorites: [{ id: randomUUID(), title: 'Ana', description: 'ana@example.com' }] };
  await whatsapp.send('alice', { text: 'Escolha', flow });
  const params = sent[0].interactive.action.parameters;
  assert.equal(params.flow_id, '5678'); assert.equal(params.flow_token, flow.token);
  assert.deepEqual(params.flow_action_payload, { screen: 'GUESTS', data: { favorites: flow.favorites } });
  for (const bad of [{ ...flow, token: 'bad' }, { ...flow, favorites: [] }, { ...flow, favorites: [...flow.favorites, ...flow.favorites] }]) await assert.rejects(whatsapp.send('alice', { text: 'Escolha', flow: bad }));
  await assert.rejects(whatsapp.send('alice', { text: 'Escolha', flow, buttons: [] })); assert.equal(sent.length, 1);
});

test('natural-language favorite management and guest choice use Hub tools and preserve final confirmation', async () => {
  const { store, calendar, oauth, guests, writes } = await setup(false);
  try {
    const tools = [
      { name: 'guest_favorite_prepare', arguments: { operation: 'add', target: null, name: 'Ana', email: 'ana@example.com' } },
      { name: 'calendar_prepare', arguments: create },
      { name: 'calendar_select_guests', arguments: { names: ['Ana'] } }
    ];
    let calls = 0;
    const assistant = new Assistant(config, store, oauth, { connected: async () => true, message: async () => { throw new Error('Cash must not receive guest operations'); } } as any,
      new Day(oauth), calendar, async (_url, init) => {
        const req = JSON.parse(String(init?.body));
        assert(req.tools.some((t: any) => t.name === 'guest_favorite_prepare'));
        const t = tools[calls++]; return new Response(JSON.stringify({ output: [{ type: 'function_call', name: t.name, arguments: JSON.stringify(t.arguments), call_id: String(calls) }] }));
      });
    const message = { id: 'wamid.model', sender: 'alice', text: 'Salve Ana, ana@example.com, como favorita', timestamp: Date.now() / 1000 };
    let [r] = await assistant.handle(message);
    assert.equal((await guests.list('alice')).items.length, 0);
    await assistant.handle({ ...message, text: '', button: r.buttons![0].id });
    [r] = await assistant.handle({ ...message, text: 'Crie Reunião em 23/12/2026 das 14h às 17h' });
    assert.match(r.text, /Deseja adicionar convidados/);
    [r] = await assistant.handle({ ...message, text: 'Ana' });
    assert.match(r.text, /ana@example.com/); assert.equal(writes.length, 0);
    await assistant.handle({ ...message, text: '', button: r.buttons![0].id });
    assert.equal(calls, 3); assert.equal(writes.length, 1);
  } finally { await store.close(); }
});

test('numbered chat choice selects exactly the listed guests without AI and still requires the final button', async () => {
  const { store, calendar, oauth, writes, add, localConfig } = await setup(false);
  try {
    await add('Ana', 'ana@example.com'); await add('Bruno', 'bruno@example.com'); await add('João', 'joao@example.com');
    const assistant = new Assistant(localConfig, store, oauth, {} as any, new Day(oauth), calendar,
      async () => { throw new Error('Numeric selection must not call AI'); });
    const message = { id: 'wamid.numbers', sender: 'alice', text: '', timestamp: Date.now() / 1000 };
    for (const answer of ['1 e 3', '1, 3', '1;3', '1 3']) {
      const draft = await calendar.prepare('alice', create);
      const [list] = await assistant.handle({ ...message, button: draft.buttons![0].id });
      assert.match(list.text, /1\. Ana — ana@example.com\n2\. Bruno — bruno@example.com\n3\. João — joao@example.com/);
      const [preview] = await assistant.handle({ ...message, text: answer });
      assert.match(preview.text, /ana@example.com/); assert.match(preview.text, /joao@example.com/);
      assert(!preview.text.includes('bruno@example.com')); assert.equal(writes.length, 0);
      await assistant.handle({ ...message, button: preview.buttons![1].id });
    }
    await calendar.prepare('alice', create);
    const [preview] = await assistant.handle({ ...message, text: '2' });
    assert.match(preview.text, /bruno@example.com/); assert.equal(writes.length, 0);
    await assistant.handle({ ...message, button: preview.buttons![0].id });
    assert.equal(writes.length, 1); assert.deepEqual(JSON.parse(writes[0].body).attendees, [{ email: 'bruno@example.com' }]);
  } finally { await store.close(); }
});

test('number selection validates snapshot, range, duplicates and sender before preparing invitations', async () => {
  const { store, calendar, writes, add } = await setup(false);
  try {
    await add('Ana', 'one@example.com'); await add('Ana', 'two@example.com');
    assert.equal(await calendar.tryGuestNumbers('alice', ['1']), null);
    await calendar.prepare('alice', create);
    assert.equal(await calendar.tryGuestNumbers('bob', ['1']), null);
    for (const numbers of [['0'], ['3'], ['1', '3'], ['99999999999999999999999']]) {
      await assert.rejects(calendar.tryGuestNumbers('alice', numbers), /Escolha números de 1 a 2/);
    }
    await assert.rejects(calendar.selectGuestNames('alice', ['Ana']), /mais de um/);
    const valid = await calendar.tryGuestNumbers('alice', ['2', '02', '2']);
    assert(valid); assert.match(valid.text, /two@example.com/); assert(!valid.text.includes('one@example.com'));
    assert.equal(await calendar.tryGuestNumbers('alice', ['1']), null);
    await calendar.confirm('alice', token(valid), true);
    assert.deepEqual(JSON.parse(writes[0].body).attendees, [{ email: 'two@example.com' }]);
    await calendar.prepare('alice', create); await add('Terceira', 'third@example.com');
    await assert.rejects(calendar.tryGuestNumbers('alice', ['1']), /favoritos mudaram/);
    assert.equal(writes.length, 1);
  } finally { await store.close(); }
});

test('number routing leaves amounts and dates alone and does not capture Cash replies without a pending guest selection', async () => {
  const { store, calendar, oauth, add, localConfig } = await setup(false);
  try {
    await add('Ana', 'ana@example.com');
    const received: string[] = [];
    const assistant = new Assistant(localConfig, store, oauth, { connected: async () => true, message: async (m: {text:string}) => {
      received.push(m.text); return [{ text: 'Resposta Cash' }];
    } } as any, new Day(oauth), calendar, async () => { throw new Error('Must route directly to Cash'); });
    await store.disconnect('alice', 'calendar');
    for (const text of ['1', '1 e 3', '23/12', '20h30', 'R$ 1,30', '1.30', 'Gastei 10']) {
      assert.equal((await assistant.handle({ id: 'wamid.cash', sender: 'alice', text, timestamp: Date.now() / 1000 }))[0].text, 'Resposta Cash');
    }
    assert.equal(received.length, 7);
  } finally { await store.close(); }
});
