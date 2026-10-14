import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Assistant } from '../src/assistant.js';
import { readConfig } from '../src/config.js';
import { createTestStore } from './database-helper.js';
import { OAuth } from '../src/oauth.js';
import { Day } from '../src/connectors/day.js';
import { Calendar } from '../src/connectors/calendar.js';
import { Cash, type Workspace } from '../src/connectors/cash.js';
import { resolveWorkspace, workspaceMenu, workspaceScope } from '../src/workspaces.js';
import { Notifications } from '../src/notifications.js';

const config = readConfig({ DATABASE_URL: 'postgres://test@localhost/zenit_hub_test',
  HUB_ENCRYPTION_KEY: randomBytes(32).toString('base64'), OPENAI_API_KEY: 'test', OPENAI_MODEL: 'test' });
const personal: Workspace = { id: 3, name: 'Casa Daniel', personal: true, reference: '7:3', cash: true, bizz: false };
const business: Workspace = { id: 4, name: 'Empresa X', personal: false, reference: '7:4', cash: true, bizz: true };
const message = (text: string, button?: string) => ({ id: 'wamid.test', sender: 'alice', text, button, timestamp: Date.now() / 1000 });
const fn = (name: string, args = {}) => new Response(JSON.stringify({ output: [{ type: 'function_call', name, call_id: name, arguments: JSON.stringify(args) }] }));
const answer = () => new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Saldo consultado.' }] }] }));
async function fixture(model: typeof fetch = async () => { throw new Error('Unexpected AI'); }) {
  const store = await createTestStore(config.key);
  const state = { current: personal, allowed: [personal, business], queries: [] as number[], selections: [] as number[] };
  const cash = {
    status: async () => ({ connected: state.current.cash === true, workspace: state.current, workspaces: state.allowed }),
    selectWorkspace: async (_s: string, id: number) => { const w = state.allowed.find(w => w.id === id)!; state.selections.push(id); state.current = w; return w; },
    query: async (_s: string, _tool: string, _args: unknown, id: number) => { state.queries.push(id); return { data: { ok: true, totalAmount: 40, totalItems: 1, items: [{ description: 'Conta' }] } }; }
  };
  const oauth = new OAuth(config, store);
  const assistant = new Assistant(config, store, oauth, cash as any, new Day(oauth), new Calendar(oauth), model);
  return { store, state, cash, assistant };
}

test('workspace commands and native list switch authorized context without AI or new authentication', async () => {
  const f = await fixture();
  try {
    const menu = await f.assistant.handle(message('Workspaces'));
    assert.equal(menu[0].list?.rows.length, 2);
    assert.match((await f.assistant.handle(message('', 'hub:workspace:select:4')))[0].text, /Empresa X/);
    assert.match((await f.assistant.handle(message('workspace atual')))[0].text, /Empresa X/);
    assert.match((await f.assistant.handle(message('voltar para o pessoal')))[0].text, /Casa Daniel/);
    assert.deepEqual(f.state.selections, [4,3]);
    await assert.rejects(f.assistant.handle(message('', 'hub:workspace:select:99')), /disponível/);
    await assert.rejects(f.assistant.handle(message('usar desconhecido')), /acessos autorizados/);
    assert.deepEqual(f.state.queries, []);
  } finally { await f.store.close(); }
});

test('workspace resolution never chooses between duplicate names and pages respect WhatsApp limits', () => {
  const status = { connected: true, workspace: personal, workspaces: [personal, { ...business, name: personal.name }] };
  assert.throws(() => resolveWorkspace(status, personal.name), /mais de um/);
  assert.equal(resolveWorkspace(status, 'pessoal').id, 3);
  status.workspaces = Array.from({ length: 24 }, (_, n) => ({ ...business, id: n + 1 }));
  assert.equal(workspaceMenu(status).list?.rows.length, 10);
  assert.equal(workspaceMenu(status, 2).list?.rows.length, 6);
});

test('financial history and queries are scoped; selection remains pinned during a concurrent change', async () => {
  let calls = 0;
  const f = await fixture(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    assert.ok(!JSON.stringify(request.input).includes('SEGREDO EMPRESA'));
    if (calls++ === 0) { f.state.current = business; return fn('cash_overview'); }
    return answer();
  });
  try {
    await f.store.withHistoryScope('alice', workspaceScope(business), () => f.store.addHistory('alice', 'assistant', 'SEGREDO EMPRESA'));
    const reply = await f.assistant.handle(message('Qual é o saldo?'));
    assert.deepEqual(f.state.queries, [3]);
    assert.match(reply[0].text, /^Cash · Casa Daniel/);
    const own = await f.store.withHistoryScope('alice', workspaceScope(personal), () => f.store.history('alice'));
    assert.equal(own.length, 2);
    const other = await f.store.withHistoryScope('alice', workspaceScope(business), () => f.store.history('alice'));
    assert.equal(other.length, 1);
  } finally { await f.store.close(); }
});

test('per-request workspace override reloads only destination history without changing the default', async () => {
  let calls = 0;
  const f = await fixture(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    if (calls++ === 0) return fn('workspace_use', { workspace: 'Empresa X' });
    assert.ok(!JSON.stringify(request.input).includes('SEGREDO CASA'));
    return calls === 2 ? fn('cash_overview') : answer();
  });
  try {
    await f.store.withHistoryScope('alice', workspaceScope(personal), () => f.store.addHistory('alice', 'assistant', 'SEGREDO CASA'));
    assert.match((await f.assistant.handle(message('Qual é o saldo da Empresa X?')))[0].text, /^Cash · Empresa X/);
    assert.deepEqual(f.state.queries, [4]); assert.deepEqual(f.state.selections, []);
    assert.equal(f.state.current.id, 3);
  } finally { await f.store.close(); }
});

test('history from a workspace with revoked Cash access is not sent to the model', async () => {
  const f = await fixture(async (_url, init) => {
    assert.ok(!String(init?.body).includes('SEGREDO REVOGADO'));
    assert.ok(!JSON.parse(String(init?.body)).tools.some((t: any) => t.name === 'cash_assistant'));
    return answer();
  });
  try {
    await f.store.withHistoryScope('alice', workspaceScope(business), () => f.store.addHistory('alice', 'assistant', 'SEGREDO REVOGADO'));
    f.state.current = { ...business, cash: false };
    f.state.allowed = [personal, f.state.current];
    await f.assistant.handle(message('O que pode consultar?'));
  } finally { await f.store.close(); }
});

test('daily summary stays on its consented workspace even after a switch; legacy subscriptions do not guess', async () => {
  const f = await fixture();
  try {
    const n = new Notifications(config, f.store, {} as any, f.cash as any, {} as any, { require: async () => {} } as any);
    const preview = await n.prepare('alice', { kind: 'daily_summary', time: '08:00', timeZone: 'America/Sao_Paulo', sources: ['cash'] });
    assert.match(preview.text, /Casa Daniel/);
    f.state.current = business;
    const token = preview.buttons![0].id.split(':').at(-1)!;
    await n.confirm('alice', token, true);
    const subscription = (await n.db.subscription('alice', 'daily_summary'))!;
    assert.equal(subscription.data.cashWorkspace?.id, 3);
    assert.match((await n.summary(subscription, '2026-10-14'))[2], /Casa Daniel/);
    assert.deepEqual(f.state.queries, [3]);
    delete subscription.data.cashWorkspace;
    assert.match((await n.summary(subscription, '2026-10-14'))[2], /configure novamente/);
    assert.deepEqual(f.state.queries, [3]);
  } finally { await f.store.close(); }
});

test('Cash connector pins the selected workspace in its signed request', async () => {
  const sent: any[] = [];
  const cash = new Cash({ ...config.cash, url: 'https://cash.test', secret: 'x'.repeat(32) }, async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ data: { ok: true } }));
  });
  await cash.query('alice', 'get_financial_overview', {}, 4);
  assert.equal(sent[0].workspaceId, 4);
  assert.equal(sent[0].userId, undefined); assert.equal(sent[0].role, undefined);
});
