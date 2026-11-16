import express, { type Response } from 'express';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import {
  InvalidClientMetadataError, InvalidGrantError, InvalidRequestError, InvalidScopeError,
  InvalidTargetError, InvalidTokenError
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { createHmac } from 'node:crypto';
import { digest, equal, randomToken } from './security.js';
import type { McpGrants } from './mcp-grants.js';

const readScope = 'cash.read';
const finishPath = '/mcp-consent/finish';
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
type GrantStore = Pick<McpGrants, 'getClient' | 'registerClient' | 'createRequest' | 'finishRequest' |
  'codeChallenge' | 'redeemCode' | 'rotateRefresh' | 'verifyAccess' | 'revokeToken'>;

function validRedirect(value: string): boolean {
  if (!URL.canParse(value) || value.length > 2048 || value.includes('#')) return false;
  const url = new URL(value);
  return !url.username && !url.password && (url.protocol === 'https:' ||
    (url.protocol === 'http:' && loopbackHosts.has(url.hostname)));
}

function validateScopes(scopes?: string[]) {
  if (scopes?.some(scope => scope !== readScope)) throw new InvalidScopeError('Acesso disponível apenas para leitura do Cash.');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]!);
}

function cookieName(code: string) { return 'hub_mcp_' + digest(code).slice(0, 24); }

function formSignature(browser: string, code: string, recipient: string) {
  return createHmac('sha256', browser).update(JSON.stringify([code, recipient])).digest('base64url');
}

function setConsentHeaders(res: Response, recipient: string) {
  // Chromium also checks form-action on the redirect to the OAuth client.
  res.set({
    'Content-Security-Policy': `default-src 'none'; form-action 'self' ${recipient}; base-uri 'none'; frame-ancestors 'none'`,
    'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff'
  });
}

function showConsent(res: Response, code: string, recipient: string, browser: string, retry: boolean) {
  setConsentHeaders(res, recipient);
  res.type('html').send(`<!doctype html><html lang="pt-BR"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Conectar ao Cash · Zenit Hub</title><main><h1>Conectar ao Cash</h1>
<p>O cliente em <strong>${escapeHtml(recipient)}</strong> solicita acesso de leitura aos saldos, contas a pagar e gastos de uma área do Cash.</p>
<p>Na sua conversa com o Zenit Hub pelo WhatsApp, envie <strong>conectar MCP ${escapeHtml(code)}</strong>.
Confira o cliente e a área de trabalho antes de autorizar.</p>
<p>${retry ? 'A conexão ainda não foi concluída. Se a solicitação expirou, inicie outra no cliente.' : 'Depois de confirmar no WhatsApp, volte a esta página.'}</p>
<form method="post" action="${finishPath}">
<input type="hidden" name="code" value="${escapeHtml(code)}">
<input type="hidden" name="recipient" value="${escapeHtml(recipient)}">
<input type="hidden" name="csrf" value="${formSignature(browser, code, recipient)}">
<button type="submit">Concluir conexão</button></form></main></html>`);
}

/** OAuth for the MCP resource. Application credentials stay inside the Hub. */
export function createMcpOAuth(publicUrl: string, grants: GrantStore) {
  const issuer = new URL(publicUrl);
  const resource = new URL('/mcp', issuer);
  function checkedResource(requested?: URL) {
    if (requested && requested.href !== resource.href) throw new InvalidTargetError('Recurso não reconhecido.');
    return resource.href;
  }
  const cookieOptions = { httpOnly: true, secure: issuer.protocol === 'https:', sameSite: 'lax' as const, path: finishPath };
  const provider: OAuthServerProvider = {
    clientsStore: {
      getClient: id => grants.getClient(id),
      registerClient: async metadata => {
        if (!metadata.redirect_uris.length || metadata.redirect_uris.length > 16 || !metadata.redirect_uris.every(validRedirect)) {
          throw new InvalidClientMetadataError('Informe callbacks HTTPS ou HTTP em loopback, sem credenciais ou fragmentos.');
        }
        if (metadata.token_endpoint_auth_method && !['none', 'client_secret_post'].includes(metadata.token_endpoint_auth_method)) {
          throw new InvalidClientMetadataError('Método de autenticação de cliente incompatível.');
        }
        if (metadata.grant_types?.some(value => value !== 'authorization_code' && value !== 'refresh_token') ||
            metadata.response_types?.some(value => value !== 'code') ||
            (metadata.scope && metadata.scope !== readScope)) {
          throw new InvalidClientMetadataError('Use authorization_code com PKCE e o escopo cash.read.');
        }
        return grants.registerClient(metadata);
      }
    },
    async authorize(client, params, res) {
      validateScopes(params.scopes);
      if (!validRedirect(params.redirectUri) || !/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge) ||
          (params.state?.length ?? 0) > 2048) {
        throw new InvalidRequestError('Parâmetros de autorização inválidos.');
      }
      const browser = randomToken();
      const code = await grants.createRequest({
        clientId: client.client_id, redirectUri: params.redirectUri, state: params.state,
        codeChallenge: params.codeChallenge, resource: checkedResource(params.resource)
      }, browser);
      res.cookie(cookieName(code), browser, { ...cookieOptions, maxAge: 600_000 });
      showConsent(res, code, new URL(params.redirectUri).origin, browser, false);
    },
    // The storage transaction verifies S256 against the original challenge before consuming the code.
    skipLocalPkceValidation: true,
    async challengeForAuthorizationCode(client, code) {
      const challenge = await grants.codeChallenge(client.client_id, code);
      if (!challenge) throw new InvalidGrantError('Autorização expirada ou inválida.');
      return challenge;
    },
    async exchangeAuthorizationCode(client, code, verifier, redirectUri, target) {
      if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !redirectUri) {
        throw new InvalidGrantError('Verificador PKCE ou callback ausente ou inválido.');
      }
      const pair = await grants.redeemCode({
        clientId: client.client_id, code, codeVerifier: verifier, redirectUri, resource: checkedResource(target)
      });
      if (!pair) throw new InvalidGrantError('Autorização expirada ou inválida.');
      return { ...pair, token_type: 'Bearer', scope: readScope };
    },
    async exchangeRefreshToken(client, refreshToken, scopes, target) {
      validateScopes(scopes);
      const pair = await grants.rotateRefresh({ clientId: client.client_id, refreshToken, resource: checkedResource(target) });
      if (!pair) throw new InvalidGrantError('Autorização expirada ou inválida.');
      return { ...pair, token_type: 'Bearer', scope: readScope };
    },
    async verifyAccessToken(token) {
      const access = await grants.verifyAccess(token, resource.href);
      if (!access) throw new InvalidTokenError('Autorização do MCP inválida.');
      return { token, clientId: access.clientId, scopes: [readScope], resource, expiresAt: access.expiresAt,
        extra: { sender: access.sender, workspaceId: access.workspaceId, workspaceReference: access.workspaceReference } };
    },
    async revokeToken(client, request) { await grants.revokeToken(client.client_id, request.token); }
  };

  const router = express.Router();
  router.use(mcpAuthRouter({ provider, issuerUrl: issuer, resourceServerUrl: resource,
    scopesSupported: [readScope], resourceName: 'Zenit Hub · Cash' }));
  router.post(finishPath, express.urlencoded({ extended: false, limit: '3kb' }), async (req, res) => {
    const { code, csrf, recipient } = req.body ?? {};
    if (req.get('origin') !== issuer.origin || typeof code !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(code) ||
        typeof csrf !== 'string' || typeof recipient !== 'string') {
      return res.sendStatus(403);
    }
    const prefix = cookieName(code) + '=';
    const browser = req.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(prefix))?.slice(prefix.length);
    if (!browser || !/^[A-Za-z0-9_-]{43}$/.test(browser) || !equal(csrf, formSignature(browser, code, recipient))) {
      return res.sendStatus(403);
    }
    const result = await grants.finishRequest(code, browser);
    if (!result) return showConsent(res, code, recipient, browser, true);
    const destination = new URL(result.redirectUri);
    destination.searchParams.set('code', result.code);
    if (result.state !== undefined) destination.searchParams.set('state', result.state);
    destination.searchParams.set('iss', issuer.href);
    setConsentHeaders(res, destination.origin);
    res.clearCookie(cookieName(code), cookieOptions);
    return res.redirect(303, destination.href);
  });
  return { router, provider };
}
