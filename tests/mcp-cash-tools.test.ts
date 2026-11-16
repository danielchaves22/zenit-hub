import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Workspace } from '../src/connectors/cash.js';
import { registerCashTools } from '../src/mcp-cash-tools.js';

const personal: Workspace = { id: 4, name: 'Pessoal', personal: true, cash: true, reference: '90:4' };
const business: Workspace = { id: 12, name: 'Empresa', personal: false, cash: true, reference: '90:12' };
const sender = '5541999990000';

async function fixture(t: TestContext) {
  const calls: Array<{ tool: string; args: Record<string, unknown>; workspaceId?: number }> = [];
  const state = {
    cashDisabled: false,
    grantWorkspace: { ...personal },
    returnedWorkspace: { ...personal },
    statusCount: 0,
    data: { ok: true } as Record<string, unknown>,
    queryError: false
  };
  const server = new McpServer({ name: 'zenit-hub-test', version: '1.0' });
  registerCashTools(server, {
    store: { cashDisabled: async who => { assert.equal(who, sender); return state.cashDisabled; } },
    cash: {
      async status(who) {
        assert.equal(who, sender);
        state.statusCount++;
        // The WhatsApp default can even be a workspace without Cash access.
        return { connected: false, workspace: { ...business, cash: false }, workspaces: [state.grantWorkspace] };
      },
      async query(who, tool, args, workspaceId) {
        assert.equal(who, sender);
        calls.push({ tool, args, workspaceId });
        if (state.queryError) throw new Error('detalhe privado do serviço');
        return { data: state.data, workspace: state.returnedWorkspace };
      }
    }
  }, { sender, workspaceId: personal.id, workspaceReference: personal.reference });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, calls, state };
}

test('MCP advertises exactly three read tools and dispatches only in the granted workspace', async t => {
  const { client, calls, state } = await fixture(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['cash_due', 'cash_expenses', 'cash_overview']);
  assert.ok(tools.every(tool => tool.annotations?.readOnlyHint && !tool.annotations.destructiveHint));
  assert.ok(tools.every(tool => tool.inputSchema.additionalProperties === false));
  assert.ok(tools.every(tool => !Object.hasOwn(tool.inputSchema.properties ?? {}, 'sender')));

  const result = await client.callTool({ name: 'cash_overview', arguments: {} });
  const value = { source: 'Cash', workspace: { id: personal.id, name: personal.name }, data: { ok: true } };
  assert.deepEqual(result.structuredContent, value);
  assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(value) }]);
  await client.callTool({ name: 'cash_due', arguments: { window: 'CUSTOM', startDate: '2026-12-01', endDate: '2026-12-01' } });
  const args = { startDate: '2026-10-01', endDate: '2026-10-31', category: 'Alimentação',
    fixedExpenses: 'EXCLUDE_FIXED', mode: 'LIST', page: 2, limit: 5, groupByCategory: true };
  await client.callTool({ name: 'cash_expenses', arguments: args });
  assert.deepEqual(calls.map(call => call.tool), ['get_financial_overview', 'get_due_obligations', 'get_realized_expenses']);
  assert.ok(calls.every(call => call.workspaceId === personal.id));
  assert.deepEqual(calls[2].args, args);
  assert.equal(state.statusCount, 3);
});

test('scope, date and pagination validation occur before any connector request', async t => {
  const { client, calls, state } = await fixture(t);
  for (const input of [
    { name: 'cash_overview', arguments: { workspaceId: business.id } },
    { name: 'cash_overview', arguments: { sender: 'another' } },
    { name: 'cash_due', arguments: { window: 'CUSTOM', startDate: '2026-02-30', endDate: '2026-03-01' } },
    { name: 'cash_due', arguments: { window: 'CUSTOM' } },
    { name: 'cash_due', arguments: { window: 'TODAY', endDate: '2026-04-01' } },
    { name: 'cash_due', arguments: { window: 'TODAY', limit: 21 } },
    { name: 'cash_expenses', arguments: { startDate: '2025-04-02', endDate: '2025-04-01' } },
    { name: 'cash_expenses', arguments: { startDate: '2020-01-31', endDate: '2025-01-01' } },
    { name: 'cash_expenses', arguments: { startDate: '2025-01-01', endDate: '2025-01-02', page: 10001 } }
  ]) {
    assert.equal((await client.callTool(input)).isError, true);
  }
  assert.deepEqual(calls, []);
  assert.equal(state.statusCount, 0);
});

test('MCP rechecks disconnect, app access and binding reference on every call', async t => {
  const { client, calls, state } = await fixture(t);
  const lookup = () => client.callTool({ name: 'cash_overview' });
  assert.equal((await lookup()).isError, false);
  state.cashDisabled = true;
  assert.equal((await lookup()).isError, true);
  assert.equal(state.statusCount, 1);
  state.cashDisabled = false;
  for (const workspace of [{ ...personal, cash: false }, { ...personal, reference: '91:4' }, business]) {
    state.grantWorkspace = workspace;
    assert.equal((await lookup()).isError, true);
  }
  assert.equal(calls.length, 1);

  state.grantWorkspace = personal;
  state.returnedWorkspace = { ...personal, reference: '92:4' };
  state.data = { ok: true, balance: 'valor de outra conta' };
  const changed = await lookup();
  assert.equal(changed.isError, true);
  assert.doesNotMatch(JSON.stringify(changed), /valor de outra conta/);

  state.queryError = true;
  const unavailable = await lookup();
  assert.equal(unavailable.isError, true);
  assert.doesNotMatch(JSON.stringify(unavailable), /detalhe privado/);
  assert.notDeepEqual(unavailable.structuredContent, changed.structuredContent);
});

test('MCP preserves category clarification and empty results from the Cash backend', async t => {
  const { client, state } = await fixture(t);
  const lookup = () => client.callTool({ name: 'cash_expenses', arguments: {
    startDate: '2026-01-01', endDate: '2026-01-31', category: 'Compras'
  } });
  state.data = { ok: false, code: 'AMBIGUOUS_CATEGORY', matches: [{ id: 1, name: 'Casa / Compras' }] };
  const ambiguous = await lookup();
  assert.equal(ambiguous.isError, true);
  assert.equal((ambiguous.structuredContent as { data: { code: string } }).data.code, 'AMBIGUOUS_CATEGORY');
  state.data = { ok: true, items: [], totalsCoverFullPeriod: true };
  const empty = await lookup();
  assert.equal(empty.isError, false);
  assert.deepEqual((empty.structuredContent as { data: unknown }).data, state.data);
});
