import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Cash } from './connectors/cash.js';
import type { Store } from './store.js';
import { McpGrants } from './mcp-grants.js';
import { createMcpOAuth } from './mcp-oauth.js';
import { registerCashTools } from './mcp-cash-tools.js';

const cashGrant = z.object({
  sender: z.string().min(1),
  workspaceId: z.number().int().positive(),
  workspaceReference: z.string().min(1),
});

export function cashMcpRouter(config: Config, store: Store, cash: Cash) {
  const router = express.Router();
  const resource = new URL('/mcp', config.publicUrl);
  const oauth = createMcpOAuth(config.publicUrl, new McpGrants(store));
  router.use(oauth.router);
  router.all('/mcp', (req, res, next) => {
    if (req.headers.origin && req.headers.origin !== resource.origin) return res.sendStatus(403);
    next();
  }, requireBearerAuth({
    verifier: oauth.provider,
    requiredScopes: ['cash.read'],
    expectedResource: resource,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource),
  }));
  router.post('/mcp', express.json({ limit: '32kb' }), async (req, res) => {
    const grant = cashGrant.safeParse(req.auth?.extra);
    if (!grant.success || (config.allowedSenders.size && !config.allowedSenders.has(grant.data.sender))) {
      return res.sendStatus(403);
    }
    // Each request is authenticated independently, including tools/call after a previous tools/list.
    const server = new McpServer({ name: 'zenit-hub-cash', version: '1.0.0' });
    registerCashTools(server, { cash, store }, grant.data);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.once('close', () => { void server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  router.all('/mcp', (_req, res) => { res.set('Allow', 'POST').sendStatus(405); });
  return router;
}
