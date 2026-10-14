import type { Pool } from 'pg';
import { transaction } from './database.js';

export const schemaVersion = 7;
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
    if (!rows.some(row => row.version === 2)) {
      await client.query(`CREATE TABLE calendar_drafts (
        hash TEXT PRIMARY KEY, sender TEXT NOT NULL, data TEXT NOT NULL,
        expires BIGINT NOT NULL, state TEXT NOT NULL DEFAULT 'pending'
          CHECK (state IN ('pending','executing','done','cancelled','uncertain')),
        result TEXT
      );
      CREATE UNIQUE INDEX calendar_drafts_pending ON calendar_drafts(sender) WHERE state='pending';
      CREATE INDEX calendar_drafts_expires ON calendar_drafts(expires);
      INSERT INTO hub_schema_migrations(version) VALUES (2);`);
    }
    if (!rows.some(row => row.version === 3)) {
      await client.query(`CREATE TABLE notification_subscriptions (
        sender TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('daily_summary','day_reminders')),
        enabled BOOLEAN NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL,
        next_check BIGINT NOT NULL, checked_at BIGINT NOT NULL, updated BIGINT NOT NULL,
        PRIMARY KEY(sender,kind)
      );
      CREATE INDEX notification_subscriptions_due ON notification_subscriptions(next_check) WHERE enabled;
      CREATE TABLE notification_drafts (
        hash TEXT PRIMARY KEY,sender TEXT NOT NULL,data TEXT NOT NULL,expires BIGINT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','executing','done','cancelled','uncertain')),result TEXT
      );
      CREATE UNIQUE INDEX notification_drafts_pending ON notification_drafts(sender) WHERE state='pending';
      CREATE INDEX notification_drafts_expiry ON notification_drafts(expires);
      CREATE TABLE notification_deliveries (
        id TEXT PRIMARY KEY,sender TEXT NOT NULL,kind TEXT NOT NULL,revision INTEGER NOT NULL,
        due BIGINT NOT NULL,expires BIGINT NOT NULL,data TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','accepted','delivered','read','failed','skipped','uncertain')),
        meta_id TEXT UNIQUE,reason TEXT,created BIGINT NOT NULL
      );
      CREATE INDEX notification_deliveries_due ON notification_deliveries(due) WHERE state='pending';
      CREATE INDEX notification_deliveries_history ON notification_deliveries(sender,created DESC);
      INSERT INTO hub_schema_migrations(version) VALUES(3);`);
    }
    if (!rows.some(row => row.version === 4)) {
      await client.query(`CREATE TABLE guest_favorites (
        sender TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE guest_favorite_drafts (
        hash TEXT PRIMARY KEY, sender TEXT NOT NULL, data TEXT NOT NULL, expires BIGINT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done','cancelled'))
      );
      CREATE UNIQUE INDEX guest_favorite_drafts_pending ON guest_favorite_drafts(sender) WHERE state='pending';
      CREATE INDEX guest_favorite_drafts_expiry ON guest_favorite_drafts(expires);
      INSERT INTO hub_schema_migrations(version) VALUES(4);`);
    }
    if (!rows.some(row => row.version === 5)) {
      await client.query(`ALTER TABLE notification_subscriptions
        ADD COLUMN problem TEXT CHECK(problem IN ('connection_changed','day_access','day_consent','day_unavailable')),
        ADD COLUMN problem_since BIGINT NOT NULL DEFAULT 0,
        ADD COLUMN problem_notified_at BIGINT NOT NULL DEFAULT 0;
        INSERT INTO hub_schema_migrations(version) VALUES(5);`);
    }
    if (!rows.some(row => row.version === 6)) {
      await client.query(`CREATE TABLE notification_settings(sender TEXT PRIMARY KEY,data TEXT NOT NULL);
        CREATE TABLE reminder_occurrences(
          id TEXT PRIMARY KEY,sender TEXT NOT NULL,reminder_key TEXT NOT NULL,
          revision INTEGER NOT NULL,due BIGINT NOT NULL,next_send BIGINT NOT NULL,
          valid_until BIGINT,quiet_until BIGINT NOT NULL DEFAULT 0,
          attempt INTEGER NOT NULL DEFAULT 0,ack_hash TEXT UNIQUE NOT NULL,data TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','completed','superseded','cancelled','finished')),
          sync_pending BOOLEAN NOT NULL DEFAULT false,updated BIGINT NOT NULL
        );
        CREATE INDEX reminder_occurrences_next ON reminder_occurrences(next_send) WHERE state='pending' OR sync_pending;
        CREATE INDEX reminder_occurrences_owner ON reminder_occurrences(sender,reminder_key,due DESC);
        INSERT INTO hub_schema_migrations(version) VALUES(6);`);
    }
    if (!rows.some(row => row.version === 7)) {
      // Legacy turns have no reliable workspace. Do not guess their ownership.
      await client.query(`ALTER TABLE history ADD COLUMN scope TEXT NOT NULL DEFAULT '';
        UPDATE history SET scope='legacy';
        CREATE INDEX history_sender_scope_id ON history(sender,scope,id DESC);
        INSERT INTO hub_schema_migrations(version) VALUES(7);`);
    }
  });
}
