import type { Pool, PoolClient } from 'pg';
import { transaction } from './database.js';
import { schemaVersion } from './migrations.js';
import { digest, Vault } from './security.js';
import type { Connection, Incoming, Provider, Reply, Tokens } from './types.js';

type LinkRow = { sender: string; provider: Provider; data: string; hash: string };
export class Store {
  readonly vault: Vault;
  private workerClient?: PoolClient;
  private workerLost = false;
  constructor(readonly db: Pool, key: string, private onWorkerLost: () => void = () => {}) {
    this.vault = new Vault(key);
  }
  async ready() {
    const { rows } = await this.db.query('SELECT max(version) AS version FROM hub_schema_migrations');
    if (rows[0]?.version !== schemaVersion) throw new Error('Execute npm run db:migrate antes de iniciar o Hub.');
  }
  async health() {
    if (this.workerLost) throw new Error('Worker perdeu a conexão com o banco.');
    await this.db.query('SELECT 1');
  }
  async startWorker() {
    if (this.workerLost) throw new Error('Worker perdeu a conexão com o banco.');
    if (this.workerClient) return true;
    const client = await this.db.connect();
    try {
      const { rows } = await client.query('SELECT pg_try_advisory_lock(hashtext(current_schema()), 903281) AS acquired');
      if (!rows[0].acquired) { client.release(); return false; }
      this.workerClient = client;
      client.on('error', this.lostWorker);
      // Only the elected worker recovers interrupted work during deployment overlap.
      await transaction(this.db, async tx => {
        await tx.query("UPDATE inbox SET state='uncertain' WHERE state='processing'");
        await tx.query("UPDATE outbox SET state='uncertain' WHERE state='sending'");
      });
      return true;
    } catch (error) {
      client.removeListener('error', this.lostWorker);
      this.workerClient = undefined;
      client.release(true);
      throw error;
    }
  }
  private lostWorker = () => { this.workerLost = true; this.onWorkerLost(); };
  async close() {
    if (this.workerClient) {
      const client = this.workerClient; this.workerClient = undefined;
      client.removeListener('error', this.lostWorker); client.release(true);
    }
    await this.db.end();
  }
  async connection(sender: string, provider: Provider): Promise<Connection | null> {
    const { rows } = await this.db.query('SELECT data FROM connections WHERE sender=$1 AND provider=$2', [sender, provider]);
    return rows[0] ? this.vault.open(rows[0].data, `connection:${sender}:${provider}`) : null;
  }
  private async saveConnection(client: Pool | PoolClient, c: Connection) {
    await client.query(`INSERT INTO connections(sender,provider,data) VALUES($1,$2,$3)
      ON CONFLICT(sender,provider) DO UPDATE SET data=EXCLUDED.data`,
    [c.sender, c.provider, this.vault.seal(c, `connection:${c.sender}:${c.provider}`)]);
  }
  async connect(c: Connection) { await this.saveConnection(this.db, c); }
  async refreshConnection(previous: Connection, tokens: Tokens): Promise<Connection | null> {
    const { sender, provider } = previous;
    const { rows } = await this.db.query('SELECT data FROM connections WHERE sender=$1 AND provider=$2', [sender, provider]);
    if (!rows[0]) return null;
    const current = this.vault.open<Connection>(rows[0].data, `connection:${sender}:${provider}`);
    if (current.accountId !== previous.accountId || current.tokens.refresh_token !== previous.tokens.refresh_token) return null;
    const refreshed = { ...current, tokens };
    const result = await this.db.query('UPDATE connections SET data=$1 WHERE sender=$2 AND provider=$3 AND data=$4',
      [this.vault.seal(refreshed, `connection:${sender}:${provider}`), sender, provider, rows[0].data]);
    return result.rowCount ? refreshed : null;
  }
  async disconnect(sender: string, provider: Provider) {
    await transaction(this.db, async tx => {
      await tx.query('DELETE FROM oauth_links WHERE sender=$1 AND provider=$2', [sender, provider]);
      await tx.query('DELETE FROM connections WHERE sender=$1 AND provider=$2', [sender, provider]);
      await tx.query('DELETE FROM history WHERE sender=$1', [sender]);
    });
  }
  async cashDisabled(sender: string) {
    const { rows } = await this.db.query('SELECT cash_disabled FROM sender_state WHERE sender=$1', [sender]);
    return rows[0]?.cash_disabled === true;
  }
  async disableCash(sender: string, disabled: boolean) {
    await transaction(this.db, async tx => {
      await tx.query(`INSERT INTO sender_state(sender,cash_disabled) VALUES($1,$2)
        ON CONFLICT(sender) DO UPDATE SET cash_disabled=EXCLUDED.cash_disabled`, [sender, disabled]);
      await tx.query('DELETE FROM history WHERE sender=$1', [sender]);
    });
  }
  async link(token: string, sender: string, provider: Provider, data: unknown, phase = 'link') {
    const hash = digest(token);
    await this.db.query('INSERT INTO oauth_links(hash,sender,provider,data,expires,phase) VALUES($1,$2,$3,$4,$5,$6)',
      [hash, sender, provider, this.vault.seal(data, `oauth:${hash}`), Date.now() + 10 * 60_000, phase]);
  }
  private openLink(row?: LinkRow) {
    return row ? { sender: row.sender, provider: row.provider, data: this.vault.open<any>(row.data, `oauth:${row.hash}`) } : null;
  }
  async readLink(token: string, phase: string) {
    const { rows } = await this.db.query<LinkRow>('SELECT * FROM oauth_links WHERE hash=$1 AND phase=$2 AND expires>$3', [digest(token), phase, Date.now()]);
    return this.openLink(rows[0]);
  }
  async takeLink(token: string, phase: string) {
    const { rows } = await this.db.query<LinkRow>('DELETE FROM oauth_links WHERE hash=$1 AND phase=$2 AND expires>$3 RETURNING *', [digest(token), phase, Date.now()]);
    return this.openLink(rows[0]);
  }
  async approveLink(sender: string, token: string, approved: boolean) {
    return transaction(this.db, async tx => {
      const { rows } = await tx.query<LinkRow>(`DELETE FROM oauth_links WHERE hash=$1 AND sender=$2
        AND phase='confirmation' AND expires>$3 RETURNING *`, [digest(token), sender, Date.now()]);
      const pending = this.openLink(rows[0]);
      if (pending && approved) {
        await this.saveConnection(tx, pending.data as Connection);
        await tx.query('DELETE FROM history WHERE sender=$1', [sender]);
      }
      return pending;
    });
  }
  async cancelLinks(sender: string, provider: Provider) {
    await this.db.query('DELETE FROM oauth_links WHERE sender=$1 AND provider=$2', [sender, provider]);
  }
  async enqueue(message: Incoming) {
    const result = await this.db.query(`INSERT INTO inbox(id,sender,data,created) VALUES($1,$2,$3,$4)
      ON CONFLICT(id) DO NOTHING`, [message.id, message.sender, this.vault.seal(message, `inbox:${message.id}`), Date.now()]);
    return result.rowCount === 1;
  }
  async nextMessage(): Promise<Incoming | null> {
    const { rows } = await this.db.query(`UPDATE inbox SET state='processing' WHERE id=(
      SELECT id FROM inbox WHERE state='pending' ORDER BY sequence LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id,data`);
    return rows[0] ? this.vault.open(rows[0].data, `inbox:${rows[0].id}`) : null;
  }
  async complete(message: Incoming, replies: Reply[]) {
    await transaction(this.db, async tx => {
      const result = await tx.query("UPDATE inbox SET state='done' WHERE id=$1 AND state='processing' RETURNING id", [message.id]);
      if (!result.rowCount) throw new Error('A mensagem não está em processamento.');
      for (const reply of replies) await this.insertReply(tx, message.sender, reply);
    });
  }
  async fail(id: string) { await this.db.query("UPDATE inbox SET state='uncertain' WHERE id=$1 AND state='processing'", [id]); }
  private async insertReply(client: Pool | PoolClient, sender: string, reply: Reply) {
    await client.query('INSERT INTO outbox(sender,data,created) VALUES($1,$2,$3)',
      [sender, this.vault.seal(reply, `reply:${sender}`), Date.now()]);
  }
  async sendLater(sender: string, reply: Reply) { await this.insertReply(this.db, sender, reply); }
  async nextReply(): Promise<{ id: string; sender: string; reply: Reply } | null> {
    const { rows } = await this.db.query(`UPDATE outbox SET state='sending' WHERE id=(
      SELECT id FROM outbox WHERE state='pending' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`);
    const row = rows[0];
    return row ? { id: row.id, sender: row.sender, reply: this.vault.open(row.data, `reply:${row.sender}`) } : null;
  }
  async sent(id: string, success: boolean) {
    await this.db.query("UPDATE outbox SET state=$1 WHERE id=$2 AND state='sending'", [success ? 'sent' : 'uncertain', id]);
  }
  async addHistory(sender: string, role: 'user' | 'assistant', content: string) {
    await transaction(this.db, async tx => {
      await tx.query('INSERT INTO history(sender,data,created) VALUES($1,$2,$3)',
        [sender, this.vault.seal({ role, content: content.slice(0, 8000) }, `history:${sender}`), Date.now()]);
      await tx.query('DELETE FROM history WHERE sender=$1 AND id NOT IN (SELECT id FROM history WHERE sender=$1 ORDER BY id DESC LIMIT 12)', [sender]);
    });
  }
  async history(sender: string): Promise<{ role: string; content: string }[]> {
    const { rows } = await this.db.query('SELECT data FROM history WHERE sender=$1 AND created>$2 ORDER BY id', [sender, Date.now() - 86400_000]);
    return rows.map(row => this.vault.open(row.data, `history:${sender}`));
  }
  async prune() {
    await transaction(this.db, async tx => {
      await tx.query('DELETE FROM oauth_links WHERE expires<$1', [Date.now()]);
      await tx.query('DELETE FROM history WHERE created<$1', [Date.now() - 86400_000]);
      await tx.query("DELETE FROM inbox WHERE created<$1 AND state='done'", [Date.now() - 30 * 86400_000]);
      await tx.query("DELETE FROM outbox WHERE created<$1 AND state='sent'", [Date.now() - 30 * 86400_000]);
    });
  }
}
