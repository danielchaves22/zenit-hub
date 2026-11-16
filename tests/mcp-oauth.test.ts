import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import express from 'express';
import { challenge, randomToken } from '../src/security.js';
import { McpGrants } from '../src/mcp-grants.js';
import { createMcpOAuth } from '../src/mcp-oauth.js';
import { createTestStore } from './database-helper.js';

async function fixture(t: TestContext) {
  const store = await createTestStore(randomBytes(32).toString('base64'));
  const grants = new McpGrants(store);
  const app = express();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const { router, provider } = createMcpOAuth(origin, grants);
  app.use(router);
  t.after(async () => {
    await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
    await store.close();
  });
  const register = (data: object) => fetch(origin + '/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
  });
  return { origin, grants, provider, register };
}

test('discovery describes one resource and read scope; clients can register HTTPS and native loopback callbacks', async t => {
  const f = await fixture(t);
  const resource = await (await fetch(f.origin + '/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(resource.resource, f.origin + '/mcp');
  assert.deepEqual(resource.scopes_supported, ['cash.read']);
  const issuer = await (await fetch(f.origin + '/.well-known/oauth-authorization-server')).json();
  assert.equal(issuer.authorization_endpoint, f.origin + '/authorize');
  assert.deepEqual(issuer.code_challenge_methods_supported, ['S256']);
  const native = await f.register({ redirect_uris: ['http://127.0.0.1/callback'], token_endpoint_auth_method: 'none' });
  assert.equal(native.status, 201);
  assert.equal((await native.json()).client_secret, undefined);
  const hosted = await f.register({ redirect_uris: ['https://example.org/callback'], token_endpoint_auth_method: 'client_secret_post' });
  assert.equal(hosted.status, 201);
  assert.ok((await hosted.json()).client_secret);
  for (const metadata of [
    { redirect_uris: [] },
    { redirect_uris: ['http://example.org/callback'] },
    { redirect_uris: ['https://example.org/callback#fragment'] },
    { redirect_uris: ['https://example.org/callback'], scope: 'cash.write' }
  ]) {
    assert.equal((await f.register(metadata)).status, 400);
  }
});

test('consent and token endpoints bind the browser, client, S256, resource and one approved Cash area', async t => {
  const f = await fixture(t);
  const callback = 'http://127.0.0.1:55321/callback';
  const client = await (await f.register({
    redirect_uris: ['http://127.0.0.1/callback'], token_endpoint_auth_method: 'none'
  })).json();
  const verifier = randomToken();
  const params = new URLSearchParams({
    client_id: client.client_id, response_type: 'code', redirect_uri: callback, code_challenge: challenge(verifier),
    code_challenge_method: 'S256', scope: 'cash.read', resource: f.origin + '/mcp', state: 'client-state'
  });
  async function authorize(change: Record<string, string> = {}) {
    const query = new URLSearchParams(params);
    for (const [key, value] of Object.entries(change)) query.set(key, value);
    return fetch(f.origin + '/authorize?' + query, { redirect: 'manual' });
  }
  const wrongScope = await authorize({ scope: 'cash.write' });
  assert.equal(new URL(wrongScope.headers.get('location')!).searchParams.get('error'), 'invalid_scope');
  const wrongResource = await authorize({ resource: 'https://example.org/another-mcp' });
  assert.equal(new URL(wrongResource.headers.get('location')!).searchParams.get('error'), 'invalid_target');
  assert.equal((await authorize({ redirect_uri: 'https://example.org/other-callback' })).status, 400);
  const response = await authorize();
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  const html = await response.text();
  assert.match(response.headers.get('content-security-policy')!, /form-action 'self' http:\/\/127\.0\.0\.1:55321;/);
  function field(name: string): string {
    const match = html.match(new RegExp('name="' + name + '" value="([^"]+)"'));
    assert.ok(match);
    return match[1];
  }
  const form = { code: field('code'), csrf: field('csrf'), recipient: field('recipient') };
  const submit = (fields = form, headers: Record<string, string> = { cookie, origin: f.origin }) =>
    fetch(f.origin + '/mcp-consent/finish', { method: 'POST', body: new URLSearchParams(fields), headers, redirect: 'manual' });
  assert.equal((await submit(form, { origin: f.origin })).status, 403);
  assert.equal((await submit(form, { cookie, origin: 'https://example.org' })).status, 403);
  assert.equal((await submit({ ...form, csrf: 'incorrect' })).status, 403);
  assert.equal((await submit({ ...form, recipient: 'https://other.example' })).status, 403);
  assert.match(await (await submit()).text(), /ainda não foi concluída/);
  const grant = { sender: 'synthetic', workspaceId: 3, workspaceReference: 'binding-fixture-workspace-3' };
  assert.equal(await f.grants.approveRequest(form.code, grant), true);
  const completed = await submit();
  assert.equal(completed.status, 303);
  const redirect = new URL(completed.headers.get('location')!);
  assert.equal(redirect.origin + redirect.pathname, callback);
  assert.equal(redirect.searchParams.get('state'), 'client-state');
  const code = redirect.searchParams.get('code')!;
  const exchange = (changes: Record<string, string> = {}) => fetch(f.origin + '/token', {
    method: 'POST', body: new URLSearchParams({
      grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: callback,
      code_verifier: verifier, resource: f.origin + '/mcp', ...changes
    })
  });
  assert.equal((await exchange({ code_verifier: randomToken() })).status, 400);
  assert.equal((await exchange({ redirect_uri: 'http://127.0.0.1:1234/callback' })).status, 400);
  assert.equal((await exchange({ resource: 'https://example.org/another-mcp' })).status, 400);
  const tokenResponse = await exchange();
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  assert.equal(tokens.scope, 'cash.read');
  const verification = await f.provider.verifyAccessToken(tokens.access_token);
  assert.deepEqual(verification.extra, grant);
  assert.equal(verification.resource?.href, f.origin + '/mcp');
  const revocation = await fetch(f.origin + '/revoke', {
    method: 'POST', body: new URLSearchParams({ client_id: client.client_id, token: tokens.refresh_token })
  });
  assert.equal(revocation.status, 200);
  await assert.rejects(f.provider.verifyAccessToken(tokens.access_token));
});
