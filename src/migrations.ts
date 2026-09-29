import type { Pool } from 'pg';
import { transaction } from './database.js';

export const schemaVersion = 1;
const initialSchema = `
  CREATE TABLE connections (
    sender TEXT NOT NULL, provider TEXT NOT NULL CHECK (provider IN ('day','calendar')),
    data TEXT NOT NULL, PRIMARY KEY (sender, provider)
  );
  CREATE TABLE oauth_links (
    hash TEXT PRIMARY KEY, sender TEXT NOT NULL, provider TEXT NOT NULL CHECK (provider IN ('day','calendar')),
    data TEXT NOT NULL, expires BIGINT NOT NULL, phase TEXT NOT NULL CHECK (phase IN ('link','state','confirmation'))
  );
  CREATE INDEX oauth_links_sender_provider ON oauth_links(sender, provider);
  CREATE INDEX oauth_links_expires ON oauth_links(expires);
  CREATE TABLE inbox (
    id TEXT PRIMARY KEY, sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
    sender TEXT NOT NULL, data TEXT NOT NULL, created BIGINT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','done','uncertain'))
  );
  CREATE INDEX inbox_pending ON inbox(sequence) WHERE state = 'pending';
  CREATE INDEX inbox_retention ON inbox(created) WHERE state = 'done';
  CREATE TABLE outbox (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sender TEXT NOT NULL, data TEXT NOT NULL, created BIGINT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','sent','uncertain'))
  );
  CREATE INDEX outbox_pending ON outbox(id) WHERE state = 'pending';
  CREATE INDEX outbox_retention ON outbox(created) WHERE state = 'sent';
  CREATE TABLE history (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, sender TEXT NOT NULL, data TEXT NOT NULL, created BIGINT NOT NULL
  );
  CREATE INDEX history_sender_id ON history(sender, id DESC);
  CREATE INDEX history_created ON history(created);
  CREATE TABLE sender_state (sender TEXT PRIMARY KEY, cash_disabled BOOLEAN NOT NULL DEFAULT FALSE);
`;

export async function migrate(pool: Pool) {
  await transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext(current_schema()), 903280)');
    await client.query(`CREATE TABLE IF NOT EXISTS hub_schema_migrations (
      version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ version: number }>('SELECT version FROM hub_schema_migrations ORDER BY version');
    if (rows.some(row => row.version > schemaVersion)) throw new Error('O banco exige uma versão mais recente do Hub.');
    if (!rows.some(row => row.version === 1)) {
      const existing = await client.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=current_schema() AND c.relkind IN ('r','p','v','m','f') AND c.relname <> 'hub_schema_migrations' LIMIT 1`);
      if (existing.rowCount) throw new Error('A primeira migração exige um schema vazio, exclusivo do Hub.');
      // Refuse collisions with tables belonging to another application.
      await client.query(initialSchema);
      await client.query('INSERT INTO hub_schema_migrations(version) VALUES (1)');
    }
  });
}
