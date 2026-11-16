import { randomBytes, randomUUID } from 'node:crypto';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { PoolClient } from 'pg';
import { transaction } from './database.js';
import { challenge, digest, equal, randomToken } from './security.js';
import type { Store } from './store.js';

const minute = 60_000;
const requestLifetime = 10 * minute;
const codeLifetime = minute;
const accessLifetime = 60 * minute;
const grantLifetime = 30 * 24 * 60 * minute;
const pairingHash = (code: string) => digest(code.toUpperCase());

export interface CashGrant {
  sender: string;
  workspaceId: number;
  workspaceReference: string;
}

interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  state?: string;
}

interface CodeExchange {
  clientId: string;
  code: string;
  redirectUri?: string;
  resource: string;
  codeVerifier: string;
}

export class McpGrants {
  constructor(private readonly store: Store) {}

  async registerClient(client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>) {
    const id = randomUUID();
    const registered = { ...client, client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000) };
    const data = this.store.vault.seal(registered, `mcp-client:${id}`);
    await this.store.db.query('INSERT INTO mcp_clients(id, data, created) VALUES ($1, $2, $3)', [id, data, Date.now()]);
    return registered;
  }

  async getClient(id: string) {
    const { rows } = await this.store.db.query<{ data: string }>('SELECT data FROM mcp_clients WHERE id=$1', [id]);
    return rows[0] ? this.store.vault.open<OAuthClientInformationFull>(rows[0].data, `mcp-client:${id}`) : undefined;
  }

  async createRequest(request: AuthorizationRequest, browserToken: string) {
    const pairingCode = randomBytes(8).toString('hex').toUpperCase();
    await this.store.db.query(`INSERT INTO mcp_requests
      (hash, browser_hash, client_id, redirect_uri, state, challenge, resource, expires)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [pairingHash(pairingCode), digest(browserToken), request.clientId, request.redirectUri, request.state ?? null,
      request.codeChallenge, request.resource, Date.now() + requestLifetime]);
    return pairingCode;
  }

  async previewRequest(pairingCode: string) {
    const { rows } = await this.store.db.query<{ client_id: string; redirect_uri: string; data: string }>(
      `SELECT r.client_id, r.redirect_uri, c.data FROM mcp_requests r JOIN mcp_clients c ON c.id=r.client_id
       WHERE r.hash=$1 AND r.grant_id IS NULL AND r.expires>$2`, [pairingHash(pairingCode), Date.now()]);
    if (!rows[0]) return null;
    const row = rows[0];
    const client = this.store.vault.open<OAuthClientInformationFull>(row.data, `mcp-client:${row.client_id}`);
    return { clientName: client.client_name || 'Cliente MCP', redirectUri: row.redirect_uri };
  }

  async approveRequest(pairingCode: string, grant: CashGrant) {
    return transaction(this.store.db, async tx => {
      // Serialize consent and revocation by the same WhatsApp identity, including pending handoffs.
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1), 903283)', [grant.sender]);
      const hash = pairingHash(pairingCode);
      const { rows } = await tx.query(`SELECT client_id, resource FROM mcp_requests
        WHERE hash=$1 AND grant_id IS NULL AND expires>$2 FOR UPDATE`, [hash, Date.now()]);
      if (!rows[0]) return false;
      const id = randomUUID();
      await tx.query(`INSERT INTO mcp_grants(id, client_id, resource, sender, workspace_id, workspace_reference, expires)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id, rows[0].client_id, rows[0].resource, grant.sender,
        grant.workspaceId, grant.workspaceReference, Date.now() + grantLifetime]);
      await tx.query('UPDATE mcp_requests SET grant_id=$2 WHERE hash=$1', [hash, id]);
      await tx.query('UPDATE mcp_clients SET approved=true WHERE id=$1 AND NOT approved', [rows[0].client_id]);
      return true;
    });
  }

  async finishRequest(pairingCode: string, browserToken: string) {
    return transaction(this.store.db, async tx => {
      const hash = pairingHash(pairingCode);
      const browserHash = digest(browserToken);
      // Revocation deletes the parent grant first. Take the same lock order before consuming the request.
      const matching = await tx.query(`SELECT g.id FROM mcp_grants g JOIN mcp_requests r ON r.grant_id=g.id
        WHERE r.hash=$1 AND r.browser_hash=$2 AND r.expires>$3 FOR UPDATE OF g`, [hash, browserHash, Date.now()]);
      if (!matching.rowCount) return null;
      const { rows } = await tx.query(`DELETE FROM mcp_requests
        WHERE hash=$1 AND browser_hash=$2 AND grant_id IS NOT NULL AND expires>$3
        RETURNING grant_id, redirect_uri, state, challenge`, [hash, browserHash, Date.now()]);
      if (!rows[0]) return null;
      const { grant_id, redirect_uri, state, challenge: pkce } = rows[0];
      const code = randomToken();
      await tx.query(`INSERT INTO mcp_codes(hash, grant_id, redirect_uri, challenge, expires)
        VALUES ($1, $2, $3, $4, $5)`, [digest(code), grant_id, redirect_uri, pkce, Date.now() + codeLifetime]);
      return { code, redirectUri: String(redirect_uri), state: state === null ? undefined : String(state) };
    });
  }

  async codeChallenge(clientId: string, code: string) {
    const { rows } = await this.store.db.query<{ challenge: string }>(
      `SELECT c.challenge FROM mcp_codes c JOIN mcp_grants g ON g.id=c.grant_id
       WHERE c.hash=$1 AND g.client_id=$2 AND c.expires>$3 AND g.expires>$3`,
    [digest(code), clientId, Date.now()]);
    return rows[0]?.challenge;
  }

  private async issueTokens(tx: PoolClient, grantId: string, grantExpires: number) {
    const accessToken = randomToken(), refreshToken = randomToken();
    const now = Date.now();
    const expires = Math.min(now + accessLifetime, grantExpires);
    await tx.query(`INSERT INTO mcp_tokens(hash, grant_id, kind, expires)
      VALUES ($1, $2, 'access', $3), ($4, $2, 'refresh', $5)`,
    [digest(accessToken), grantId, expires, digest(refreshToken), grantExpires]);
    return { access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer',
      expires_in: Math.floor((expires - now) / 1000) };
  }

  async redeemCode({ clientId, code, redirectUri, resource, codeVerifier }: CodeExchange) {
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) return null;
    return transaction(this.store.db, async tx => {
      const hash = digest(code);
      const { rows } = await tx.query(`SELECT c.challenge, c.used, g.id, g.expires FROM mcp_codes c
        JOIN mcp_grants g ON g.id=c.grant_id WHERE c.hash=$1 AND g.client_id=$2 AND g.resource=$3
        AND c.redirect_uri=$4 AND c.expires>$5 AND g.expires>$5 FOR UPDATE OF g, c`,
      [hash, clientId, resource, redirectUri ?? null, Date.now()]);
      const row = rows[0];
      if (!row || !equal(row.challenge, challenge(codeVerifier))) return null;
      if (row.used) {
        await tx.query('DELETE FROM mcp_grants WHERE id=$1', [row.id]);
        return null;
      }
      await tx.query('UPDATE mcp_codes SET used=true WHERE hash=$1', [hash]);
      return this.issueTokens(tx, row.id, Number(row.expires));
    });
  }

  async rotateRefresh({ clientId, refreshToken, resource }: { clientId: string; refreshToken: string; resource: string }) {
    return transaction(this.store.db, async tx => {
      const hash = digest(refreshToken);
      const { rows } = await tx.query(`SELECT t.used, g.id, g.expires FROM mcp_tokens t JOIN mcp_grants g ON g.id=t.grant_id
        WHERE t.hash=$1 AND t.kind='refresh' AND g.client_id=$2 AND g.resource=$3 AND t.expires>$4 AND g.expires>$4
        FOR UPDATE OF g, t`, [hash, clientId, resource, Date.now()]);
      const row = rows[0];
      if (!row) return null;
      // Keep consumed refresh-token hashes until the grant expires to detect reuse of any generation.
      if (row.used) {
        await tx.query('DELETE FROM mcp_grants WHERE id=$1', [row.id]);
        return null;
      }
      await tx.query('UPDATE mcp_tokens SET used=true WHERE hash=$1', [hash]);
      return this.issueTokens(tx, row.id, Number(row.expires));
    });
  }

  async verifyAccess(accessToken: string, resource: string) {
    const { rows } = await this.store.db.query(`SELECT g.client_id, g.resource, g.sender, g.workspace_id, g.workspace_reference, t.expires
      FROM mcp_tokens t JOIN mcp_grants g ON g.id=t.grant_id
      WHERE t.hash=$1 AND t.kind='access' AND g.resource=$2 AND t.expires>$3 AND g.expires>$3`,
    [digest(accessToken), resource, Date.now()]);
    const row = rows[0];
    if (!row) return null;
    return { clientId: String(row.client_id), resource: String(row.resource), expiresAt: Math.floor(Number(row.expires) / 1000),
      sender: String(row.sender), workspaceId: Number(row.workspace_id), workspaceReference: String(row.workspace_reference) };
  }

  async revokeToken(clientId: string, token: string) {
    await this.store.db.query(`DELETE FROM mcp_grants WHERE client_id=$1 AND id=(
      SELECT grant_id FROM mcp_tokens WHERE hash=$2)`, [clientId, digest(token)]);
  }

  async revokeSender(sender: string) {
    await transaction(this.store.db, async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1), 903283)', [sender]);
      await tx.query('DELETE FROM mcp_grants WHERE sender=$1', [sender]);
    });
  }

}

export async function pruneMcpGrants(tx: PoolClient, now: number) {
  await tx.query('DELETE FROM mcp_grants WHERE expires<=$1', [now]);
  await tx.query('DELETE FROM mcp_requests WHERE expires<=$1', [now]);
  await tx.query('DELETE FROM mcp_codes WHERE expires<=$1', [now]);
  await tx.query('DELETE FROM mcp_tokens WHERE expires<=$1', [now]);
  await tx.query(`DELETE FROM mcp_clients c WHERE NOT approved AND created<$1
    AND NOT EXISTS (SELECT 1 FROM mcp_requests r WHERE r.client_id=c.id)`, [now - 7 * 24 * 60 * minute]);
}
