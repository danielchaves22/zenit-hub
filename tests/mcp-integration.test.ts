import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { Assistant } from '../src/assistant.js';
import { readConfig } from '../src/config.js';
import { Calendar } from '../src/connectors/calendar.js';
import { Cash } from '../src/connectors/cash.js';
import { Day } from '../src/connectors/day.js';
import { mcpPairingReply } from '../src/mcp-pairing.js';
import { OAuth } from '../src/oauth.js';
import { bridgeSignature } from '../src/security.js';
import { WhatsApp } from '../src/whatsapp.js';
import { createTestStore } from './database-helper.js';

async function listen(t: TestContext, server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return 'http://127.0.0.1:' + address.port;
}

test('MCP pairs over WhatsApp and reads the approved area through the signed bridge until revoked', async t => {
  const sender = '5541999990000';
  const secret = randomBytes(32).toString('hex');
  const personal = { id: 3, name: 'Pessoal', reference: '21:3', personal: true, cash: true };
  const business = { id: 8, name: 'Empresa', reference: '21:8', personal: false, cash: true };
  const queries: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const violations: string[] = [];
  const bridge = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      const path = '/api/integrations/hub/bridge';
      const signature = bridgeSignature(body, String(req.headers['x-hub-timestamp']), String(req.headers['x-hub-nonce']), path, secret);
      assert.equal(req.url, path);
      assert.equal(req.method, 'POST');
      assert.equal(req.headers['x-hub-signature'], signature);
      const input = JSON.parse(body);
      assert.equal(input.sender, sender);
      let result;
      if (input.operation === 'workspaces') {
        result = { connected: true, workspace: business, workspaces: [business, personal] };
      } else {
        assert.equal(input.operation, 'query', 'Only read operations are expected at the bridge');
        assert.equal(input.workspaceId, personal.id);
        queries.push({ tool: input.tool, args: input.args });
        result = { workspace: personal, data: { ok: true, referenceDate: '2026-11-01' } };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) {
      violations.push(String(error));
      res.writeHead(400).end();
    }
  });
  const cashUrl = await listen(t, bridge);
  const hub = createServer();
  const origin = await listen(t, hub);
  const resource = origin + '/mcp';
  const config = readConfig({
    DATABASE_URL: 'postgres://test@localhost/zenit_hub_test',
    HUB_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    HUB_PUBLIC_URL: origin, CASH_API_URL: cashUrl, CASH_HUB_SHARED_SECRET: secret
  });
  const store = await createTestStore(config.key);
  t.after(() => store.close());
  const oauth = new OAuth(config, store);
  const cash = new Cash(config.cash);
  const assistant = new Assistant(config, store, oauth, cash, new Day(oauth), new Calendar(oauth),
    async () => { throw new Error('Pairing does not use the model'); });
  hub.on('request', createApp(config, store, oauth, new WhatsApp(config), cash));

  const protectedResource = await fetch(origin + '/.well-known/oauth-protected-resource/mcp');
  assert.equal(protectedResource.status, 200);
  const metadata = await protectedResource.json();
  assert.equal(metadata.resource, resource);
  const discovery = await fetch(origin + '/.well-known/oauth-authorization-server');
  const auth = await discovery.json();
  assert.equal(discovery.status, 200);
  const redirectUri = 'http://127.0.0.1:8076/callback';
  const registration = await fetch(auth.registration_endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Cliente de teste', redirect_uris: [redirectUri],
      scope: 'cash.read', grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: 'none' })
  });
  assert.equal(registration.status, 201);
  const { client_id: clientId } = await registration.json();
  const verifier = randomBytes(32).toString('base64url');
  const state = randomUUID();
  const authorizationUrl = new URL(auth.authorization_endpoint);
  authorizationUrl.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri,
    response_type: 'code', scope: 'cash.read', state, resource, code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
  const page = await fetch(authorizationUrl);
  assert.equal(page.status, 200);
  const html = await page.text();
  const fields = new URLSearchParams();
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]+)"/g)) {
    fields.append(match[1], match[2]);
  }
  const code = fields.get('code');
  assert.match(code ?? '', /^[0-9A-F]{16}$/);
  const say = (text: string, button?: string) => assistant.handle({
    text, button, sender, id: 'wamid.' + randomUUID(), timestamp: Date.now() / 1000
  });
  const [preview] = await say('conectar MCP ' + code + ' Pessoal');
  assert.match(preview.text, /Pessoal/);
  const approval = preview.buttons?.find(button => button.title === 'Autorizar leitura');
  assert.ok(approval);
  await say('', approval.id);
  const cookie = page.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const finish = await fetch(origin + '/mcp-consent/finish', { method: 'POST', headers: { cookie, origin },
    redirect: 'manual', body: fields });
  assert.equal(finish.status, 303);
  const location = new URL(finish.headers.get('location')!);
  assert.equal(location.origin + location.pathname, redirectUri);
  assert.equal(location.searchParams.get('state'), state);
  const authorizationCode = location.searchParams.get('code');
  assert.ok(authorizationCode);
  const tokenResponse = await fetch(auth.token_endpoint, { method: 'POST', body: new URLSearchParams({
    grant_type: 'authorization_code', code: authorizationCode, code_verifier: verifier,
    redirect_uri: redirectUri, resource, client_id: clientId
  }) });
  assert.equal(tokenResponse.status, 200);
  const { access_token: accessToken } = await tokenResponse.json();
  const headers = { Authorization: 'Bearer ' + accessToken };
  const client = new Client({ name: 'zenit-hub-test', version: '1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers } });
  await client.connect(transport);
  t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['cash_due', 'cash_expenses', 'cash_overview']);
  for (const request of [
    { name: 'cash_overview', arguments: {} },
    { name: 'cash_due', arguments: { window: 'NEXT_7_DAYS' } },
    { name: 'cash_expenses', arguments: { startDate: '2026-11-01', endDate: '2026-11-15', groupByCategory: true } }
  ]) {
    const result = await client.callTool(request);
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, { source: 'Cash', workspace: { id: personal.id, name: personal.name },
      data: { ok: true, referenceDate: '2026-11-01' } });
  }
  assert.deepEqual(queries.map(query => query.tool), ['get_financial_overview', 'get_due_obligations', 'get_realized_expenses']);
  assert.equal(queries[2].args.groupByCategory, true);

  await say('desconectar MCP');
  const revoked = await fetch(resource, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }) });
  assert.equal(revoked.status, 401);
  assert.equal(await store.cashDisabled(sender), false);
  assert.deepEqual((await cash.status(sender)).workspace, business);
  assert.deepEqual(violations, []);
});

test('WhatsApp approval belongs to the sender and Cash binding shown in the preview', async () => {
  const key = randomBytes(32).toString('base64');
  const owner = '5541999990000';
  const pairingCode = '0123456789ABCDEF';
  const workspace = { id: 3, reference: '21:3', name: 'Pessoal', personal: true, cash: true };
  const approved: Array<{ sender: string; workspaceId: number; workspaceReference: string }> = [];
  const grants = {
    previewRequest: async () => ({ clientName: 'Cliente de teste', redirectUri: 'https://client.example/callback' }),
    approveRequest: async (_code: string, grant: (typeof approved)[number]) => { approved.push(grant); return true; },
    revokeSender: async () => {}
  };
  const cash = { status: async () => ({ connected: true, workspace, workspaces: [workspace] }) };
  const say = (sender: string, text: string, button?: string) => mcpPairingReply({
    id: 'wamid.' + randomUUID(), timestamp: Date.now() / 1000, sender, text, button
  }, key, grants, { cashDisabled: async () => false }, cash);

  const preview = await say(owner, 'conectar MCP ' + pairingCode);
  const button = preview?.buttons?.find(option => option.title === 'Autorizar leitura');
  assert.ok(button);
  // Keep every workspace field equal to test the sender check independently.
  await say('5541999990001', '', button.id);
  assert.deepEqual(approved, []);
  // A replacement binding keeps the company ID but has its own reference.
  workspace.reference = '22:3';
  await say(owner, '', button.id);
  assert.deepEqual(approved, []);
  const renewed = await say(owner, 'conectar MCP ' + pairingCode);
  const newButton = renewed?.buttons?.[0];
  assert.ok(newButton);
  await say(owner, '', newButton.id);
  assert.deepEqual(approved, [{ sender: owner, workspaceId: 3, workspaceReference: '22:3' }]);
});
