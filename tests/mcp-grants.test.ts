import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createTestStore } from './database-helper.js';
import { McpGrants } from '../src/mcp-grants.js';
import { challenge, randomToken } from '../src/security.js';
import { migrate } from '../src/migrations.js';

const redirectUri = 'http://127.0.0.1:6190/callback';
const resource = 'https://hub.example/mcp';
const grant = { sender: 'sender-a', workspaceId: 17, workspaceReference: 'binding-a:company-17' };

async function begin() {
  const store = await createTestStore(randomBytes(32).toString('base64'));
  const repository = new McpGrants(store);
  const client = await repository.registerClient({
    client_name: 'Test client', redirect_uris: [redirectUri], token_endpoint_auth_method: 'client_secret_post',
    client_secret: randomToken(),
  });
  const codeVerifier = randomToken();
  const inputs = { clientId: client.client_id, redirectUri, resource, state: 'client-state',
    codeChallenge: challenge(codeVerifier) };
  const browser = randomToken();
  const pairing = await repository.createRequest(inputs, browser);
  return { store, repository, client, browser, pairing, inputs, codeVerifier };
}

test('consent binds the initiating browser, client, callback, PKCE, resource and one workspace', async t => {
  const { store, repository, client, browser, pairing, inputs, codeVerifier } = await begin();
  t.after(() => store.close());
  assert.equal((await repository.getClient(client.client_id))?.client_secret, client.client_secret);
  assert.deepEqual(await repository.previewRequest(pairing), { clientName: 'Test client', redirectUri });
  assert.equal(await repository.finishRequest(pairing, browser), null);
  const approvals = await Promise.all([repository.approveRequest(pairing, grant), repository.approveRequest(pairing, grant)]);
  assert.deepEqual(approvals.sort(), [false, true]);
  assert.equal(await repository.previewRequest(pairing), null);
  assert.equal(await repository.finishRequest(pairing, 'unrelated-browser'), null);
  const confirmed = await repository.finishRequest(pairing, browser);
  assert.ok(confirmed);
  assert.equal(confirmed.redirectUri, redirectUri);
  assert.equal(confirmed.state, inputs.state);
  assert.equal(await repository.finishRequest(pairing, browser), null);
  assert.equal(await repository.codeChallenge(inputs.clientId, confirmed.code), inputs.codeChallenge);
  const exchange = { ...inputs, code: confirmed.code, codeVerifier };
  for (const other of [{ clientId: 'other' }, { codeVerifier: randomToken() }, { redirectUri: resource }, { resource: redirectUri }]) {
    assert.equal(await repository.redeemCode({ ...exchange, ...other }), null);
  }
  const tokens = await repository.redeemCode(exchange);
  assert.ok(tokens);
  const verified = await repository.verifyAccess(tokens.access_token, resource);
  assert.ok(verified);
  assert.equal(verified.sender, grant.sender);
  assert.equal(verified.workspaceId, grant.workspaceId);
  assert.equal(verified.workspaceReference, grant.workspaceReference);
  assert.equal(await repository.verifyAccess(tokens.access_token, redirectUri), null);
  assert.equal(await repository.verifyAccess(tokens.refresh_token, resource), null);
  const stored = await store.db.query(`SELECT data FROM mcp_clients UNION ALL SELECT hash FROM mcp_codes
    UNION ALL SELECT hash FROM mcp_tokens`);
  const persisted = JSON.stringify(stored.rows);
  for (const secret of [client.client_secret, confirmed.code, tokens.access_token, tokens.refresh_token]) {
    assert.ok(secret && !persisted.includes(secret));
  }
  assert.equal(await repository.redeemCode(exchange), null);
  assert.equal(await repository.verifyAccess(tokens.access_token, resource), null);
});

test('rotating a refresh token concurrently issues at most one pair and revokes its grant on replay', async t => {
  const { store, repository, pairing, browser, inputs, codeVerifier } = await begin();
  t.after(() => store.close());
  await repository.approveRequest(pairing, grant);
  const handoff = await repository.finishRequest(pairing, browser);
  assert.ok(handoff);
  const tokens = await repository.redeemCode({ ...inputs, code: handoff.code, codeVerifier });
  assert.ok(tokens);
  const params = { clientId: inputs.clientId, resource, refreshToken: tokens.refresh_token };
  assert.equal(await repository.rotateRefresh({ ...params, clientId: 'other-client' }), null);
  assert.equal(await repository.rotateRefresh({ ...params, resource: redirectUri }), null);
  await repository.revokeToken('other-client', tokens.refresh_token);
  const rotations = await Promise.all([repository.rotateRefresh(params), repository.rotateRefresh(params)]);
  assert.equal(rotations.filter(Boolean).length, 1);
  const newest = rotations.find(result => result !== null)!;
  assert.equal(await repository.rotateRefresh({ ...params, refreshToken: newest.refresh_token }), null);
  assert.equal(await repository.verifyAccess(newest.access_token, resource), null);
  assert.equal(await repository.verifyAccess(tokens.access_token, resource), null);
});

test('sender revocation cancels approved browser handoffs, and request/code expiry remains effective before pruning', async t => {
  const { store, repository, pairing, browser, inputs, codeVerifier } = await begin();
  t.after(() => store.close());
  await repository.approveRequest(pairing, grant);
  await repository.revokeSender(grant.sender);
  assert.equal(await repository.finishRequest(pairing, browser), null);
  const second = await repository.createRequest(inputs, browser);
  await repository.approveRequest(second, grant);
  await repository.revokeSender('unrelated');
  const handoff = await repository.finishRequest(second, browser);
  assert.ok(handoff);
  const third = await repository.createRequest(inputs, browser);
  const unused = await repository.registerClient({ redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' });
  const farFuture = Date.now() + 31 * 24 * 60 * 60 * 1000;
  t.mock.method(Date, 'now', () => farFuture);
  assert.equal(await repository.approveRequest(third, grant), false);
  assert.equal(await repository.redeemCode({ ...inputs, code: handoff.code, codeVerifier }), null);
  await store.prune();
  assert.equal(await repository.getClient(unused.client_id), undefined);
  assert.ok(await repository.getClient(inputs.clientId));
  const counts = await store.db.query(`SELECT (SELECT count(*) FROM mcp_requests) + (SELECT count(*) FROM mcp_codes)
    + (SELECT count(*) FROM mcp_grants) AS outstanding`);
  assert.equal(Number(counts.rows[0].outstanding), 0);
});

test('migration 11 upgrades the previous schema while retaining the Cash disconnection state', async t => {
  const store = await createTestStore(randomBytes(32).toString('base64'));
  t.after(() => store.close());
  // Recreate only the previous schema inside this disposable database fixture.
  await store.db.query(`DROP TABLE mcp_tokens, mcp_codes, mcp_requests, mcp_grants, mcp_clients;
    DELETE FROM hub_schema_migrations WHERE version=11;
    INSERT INTO sender_state(sender,cash_disabled) VALUES ('existing',true)`);
  await migrate(store.db);
  await migrate(store.db);
  assert.equal(await store.cashDisabled('existing'), true);
  assert.equal((await store.db.query('SELECT count(*)::integer AS grants FROM mcp_grants')).rows[0].grants, 0);
  await store.ready();
});

test('access expires separately from refresh and OAuth revocation preserves a second grant for the same user', async t => {
  const { store, repository, pairing, browser, inputs, codeVerifier } = await begin();
  t.after(() => store.close());
  async function issue(pairingCode: string) {
    await repository.approveRequest(pairingCode, grant);
    const handoff = await repository.finishRequest(pairingCode, browser);
    assert.ok(handoff);
    const tokens = await repository.redeemCode({ ...inputs, code: handoff.code, codeVerifier });
    assert.ok(tokens);
    return tokens;
  }
  const first = await issue(pairing);
  const second = await issue(await repository.createRequest(inputs, browser));
  await repository.revokeToken(inputs.clientId, first.access_token);
  assert.equal(await repository.verifyAccess(first.access_token, resource), null);
  assert.equal(await repository.rotateRefresh({ clientId: inputs.clientId, refreshToken: first.refresh_token, resource }), null);
  assert.ok(await repository.verifyAccess(second.access_token, resource));
  const tomorrow = Date.now() + 24 * 60 * 60 * 1000;
  t.mock.method(Date, 'now', () => tomorrow);
  assert.equal(await repository.verifyAccess(second.access_token, resource), null);
  const rotated = await repository.rotateRefresh({ clientId: inputs.clientId, refreshToken: second.refresh_token, resource });
  assert.ok(rotated);
  await repository.revokeSender(grant.sender);
  assert.equal(await repository.verifyAccess(rotated.access_token, resource), null);
});
