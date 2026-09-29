import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { digest, Vault } from './security.js';
import type { Connection, Incoming, Provider, Reply } from './types.js';

export class Store {
  readonly db: DatabaseSync;
  readonly vault: Vault;
  constructor(path: string, key: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.vault = new Vault(key);
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS connections(sender TEXT, provider TEXT, data TEXT NOT NULL, PRIMARY KEY(sender,provider));
      CREATE TABLE IF NOT EXISTS oauth_links(hash TEXT PRIMARY KEY, sender TEXT NOT NULL, provider TEXT NOT NULL,
        data TEXT NOT NULL, expires INTEGER NOT NULL, phase TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY, sender TEXT NOT NULL, data TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY, sender TEXT NOT NULL, data TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY, sender TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sender_state(sender TEXT PRIMARY KEY, cash_disabled INTEGER NOT NULL DEFAULT 0);
    `);
    // Interrupted work is not replayed automatically: a remote effect may already have happened.
    this.db.exec("UPDATE inbox SET state='uncertain' WHERE state='processing'; UPDATE outbox SET state='uncertain' WHERE state='sending'");
  }
  close() { this.db.close(); }
  connection(sender: string, provider: Provider): Connection | null {
    const row = this.db.prepare('SELECT data FROM connections WHERE sender=? AND provider=?').get(sender, provider);
    return row ? this.vault.open(String(row.data), `connection:${sender}:${provider}`) : null;
  }
  connect(c: Connection) {
    this.db.prepare('INSERT OR REPLACE INTO connections VALUES(?,?,?)').run(c.sender, c.provider,
      this.vault.seal(c, `connection:${c.sender}:${c.provider}`));
  }
  disconnect(sender: string, provider: Provider) {
    this.db.prepare('DELETE FROM connections WHERE sender=? AND provider=?').run(sender, provider);
    this.db.prepare('DELETE FROM oauth_links WHERE sender=? AND provider=?').run(sender, provider);
    this.db.prepare('DELETE FROM history WHERE sender=?').run(sender);
  }
  cashDisabled(sender: string) {
    return this.db.prepare('SELECT cash_disabled FROM sender_state WHERE sender=?').get(sender)?.cash_disabled === 1;
  }
  disableCash(sender: string, disabled: boolean) {
    this.db.prepare('INSERT OR REPLACE INTO sender_state VALUES(?,?)').run(sender, Number(disabled));
    this.db.prepare('DELETE FROM history WHERE sender=?').run(sender);
  }
  link(token: string, sender: string, provider: Provider, data: unknown, phase = 'link') {
    const hash = digest(token);
    this.db.prepare('INSERT INTO oauth_links VALUES(?,?,?,?,?,?)').run(hash, sender, provider,
      this.vault.seal(data, `oauth:${hash}`), Date.now() + 10 * 60_000, phase);
  }
  readLink(token: string, phase: string) {
    const hash = digest(token);
    const row = this.db.prepare('SELECT * FROM oauth_links WHERE hash=? AND phase=? AND expires>?').get(hash, phase, Date.now());
    if (!row) return null;
    return { sender: String(row.sender), provider: row.provider as Provider, data: this.vault.open<any>(String(row.data), `oauth:${hash}`) };
  }
  takeLink(token: string, phase: string) {
    const result = this.readLink(token, phase);
    if (!result) return null;
    const changed = this.db.prepare('DELETE FROM oauth_links WHERE hash=? AND phase=?').run(digest(token), phase).changes;
    return changed ? result : null;
  }
  cancelLinks(sender: string, provider: Provider) {
    this.db.prepare('DELETE FROM oauth_links WHERE sender=? AND provider=?').run(sender, provider);
  }
  enqueue(message: Incoming) {
    return this.db.prepare('INSERT OR IGNORE INTO inbox(id,sender,data,created) VALUES(?,?,?,?)').run(
      message.id, message.sender, this.vault.seal(message, `inbox:${message.id}`), Date.now()).changes > 0;
  }
  nextMessage(): Incoming | null {
    const row = this.db.prepare("SELECT * FROM inbox WHERE state='pending' ORDER BY created,rowid LIMIT 1").get();
    if (!row) return null;
    this.db.prepare("UPDATE inbox SET state='processing' WHERE id=?").run(row.id);
    return this.vault.open(String(row.data), `inbox:${row.id}`);
  }
  complete(message: Incoming, replies: Reply[]) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const reply of replies) this.sendLater(message.sender, reply);
      this.db.prepare("UPDATE inbox SET state='done' WHERE id=?").run(message.id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  fail(id: string) { this.db.prepare("UPDATE inbox SET state='uncertain' WHERE id=?").run(id); }
  sendLater(sender: string, reply: Reply) {
    this.db.prepare('INSERT INTO outbox(sender,data,created) VALUES(?,?,?)').run(sender,
      this.vault.seal(reply, `reply:${sender}`), Date.now());
  }
  nextReply(): { id: number; sender: string; reply: Reply } | null {
    const row = this.db.prepare("SELECT * FROM outbox WHERE state='pending' ORDER BY id LIMIT 1").get();
    if (!row) return null;
    this.db.prepare("UPDATE outbox SET state='sending' WHERE id=?").run(row.id);
    return { id: Number(row.id), sender: String(row.sender), reply: this.vault.open(String(row.data), `reply:${row.sender}`) };
  }
  sent(id: number, success: boolean) {
    this.db.prepare('UPDATE outbox SET state=? WHERE id=?').run(success ? 'sent' : 'uncertain', id);
  }
  addHistory(sender: string, role: 'user' | 'assistant', content: string) {
    this.db.prepare('INSERT INTO history(sender,data,created) VALUES(?,?,?)').run(sender,
      this.vault.seal({ role, content: content.slice(0, 8000) }, `history:${sender}`), Date.now());
    this.db.prepare('DELETE FROM history WHERE sender=? AND id NOT IN (SELECT id FROM history WHERE sender=? ORDER BY id DESC LIMIT 12)').run(sender, sender);
  }
  history(sender: string): { role: string; content: string }[] {
    return this.db.prepare('SELECT data FROM history WHERE sender=? AND created>? ORDER BY id').all(sender, Date.now() - 86400_000)
      .map(row => this.vault.open(String(row.data), `history:${sender}`));
  }
  prune() {
    this.db.prepare('DELETE FROM oauth_links WHERE expires<?').run(Date.now());
    this.db.prepare('DELETE FROM history WHERE created<?').run(Date.now() - 86400_000);
    for (const table of ['inbox', 'outbox']) this.db.prepare(`DELETE FROM ${table} WHERE created<? AND state IN ('done','sent')`).run(Date.now() - 30 * 86400_000);
  }
}
