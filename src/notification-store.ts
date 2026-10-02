import { Store } from './store.js';
import { digest, randomToken } from './security.js';
import { transaction } from './database.js';
import type { Reply } from './types.js';

export type NotificationKind = 'daily_summary' | 'day_reminders';
export type Preferences = {
  time: string;
  timeZone: string;
  sources: ('cash' | 'day' | 'calendar')[];
  consentAt: number;
  accounts: Record<string, string>;
  since: number;
};
export type Subscription = {
  sender: string;
  kind: NotificationKind;
  enabled: boolean;
  revision: number;
  data: Preferences;
  checkedAt: number;
};
export type DeliveryData = {
  account?: string;
  reminderId?: string;
  reminderRevision?: number;
  title?: string;
  timeZone?: string;
  date?: string;
};
export type Delivery = {
  id: string;
  sender: string;
  kind: NotificationKind;
  revision: number;
  due: number;
  expires: number;
  data: DeliveryData;
};

export class NotificationStore {
  constructor(readonly store: Store) {}
  private open(row: any): Subscription {
    return {
      ...row,
      data: this.store.vault.open(row.data, `subscription:${row.sender}:${row.kind}`),
      checkedAt: Number(row.checked_at),
    };
  }
  async list(sender: string): Promise<Subscription[]> {
    const { rows } = await this.store.db.query(
      'SELECT * FROM notification_subscriptions WHERE sender=$1 ORDER BY kind',
      [sender],
    );
    return rows.map((row) => this.open(row));
  }
  async subscription(sender: string, kind: NotificationKind) {
    return (await this.list(sender)).find((s) => s.kind === kind);
  }
  async save(sender: string, kind: NotificationKind, data: Preferences, now = Date.now()) {
    await this.store.db.query(
      `INSERT INTO notification_subscriptions(sender,kind,enabled,revision,data,next_check,checked_at,updated)
      VALUES($1,$2,true,1,$3,$4,$4,$4) ON CONFLICT(sender,kind) DO UPDATE SET enabled=true,revision=notification_subscriptions.revision+1,
      data=excluded.data,next_check=excluded.next_check,checked_at=excluded.checked_at,updated=excluded.updated`,
      [sender, kind, this.store.vault.seal(data, `subscription:${sender}:${kind}`), now],
    );
  }
  async pause(sender: string, kind?: NotificationKind) {
    await transaction(this.store.db, async (tx) => {
      await tx.query(
        'UPDATE notification_subscriptions SET enabled=false,revision=revision+1,updated=$3 WHERE sender=$1 AND ($2::text IS NULL OR kind=$2)',
        [sender, kind ?? null, Date.now()],
      );
      await tx.query("UPDATE notification_drafts SET state='cancelled' WHERE sender=$1 AND state='pending'", [
        sender,
      ]);
      await tx.query(
        "UPDATE notification_deliveries SET state='skipped',reason='opt_out' WHERE sender=$1 AND state='pending' AND ($2::text IS NULL OR kind=$2)",
        [sender, kind ?? null],
      );
    });
  }
  async due(now: number): Promise<Subscription[]> {
    const { rows } = await this.store.db.query(
      'SELECT * FROM notification_subscriptions WHERE enabled AND next_check<=$1 ORDER BY next_check LIMIT 20',
      [now],
    );
    return rows.map((row) => this.open(row));
  }
  async checked(s: Subscription, now: number, success: boolean) {
    await this.store.db.query(
      'UPDATE notification_subscriptions SET next_check=$1,checked_at=CASE WHEN $2 THEN $3 ELSE checked_at END WHERE sender=$4 AND kind=$5 AND revision=$6',
      [now + (success ? 30_000 : 60_000), success, now, s.sender, s.kind, s.revision],
    );
  }
  async draft(sender: string, data: unknown) {
    const token = randomToken(),
      hash = digest(token);
    await transaction(this.store.db, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1),903282)', [sender]);
      await tx.query("UPDATE notification_drafts SET state='cancelled' WHERE sender=$1 AND state='pending'", [
        sender,
      ]);
      await tx.query('INSERT INTO notification_drafts(hash,sender,data,expires) VALUES($1,$2,$3,$4)', [
        hash,
        sender,
        this.store.vault.seal(data, `notification-draft:${hash}:${sender}`),
        Date.now() + 600_000,
      ]);
    });
    return token;
  }
  async claim<T>(sender: string, token: string, approved: boolean): Promise<T | null> {
    const hash = digest(token);
    const { rows } = await this.store.db.query(
      `UPDATE notification_drafts SET state=$1 WHERE hash=$2 AND sender=$3 AND expires>$4 AND state='pending' RETURNING data`,
      [approved ? 'executing' : 'cancelled', hash, sender, Date.now()],
    );
    return rows[0] ? this.store.vault.open<T>(rows[0].data, `notification-draft:${hash}:${sender}`) : null;
  }
  async finish(sender: string, token: string, reply: Reply, state = 'done') {
    const hash = digest(token);
    await this.store.db.query(
      "UPDATE notification_drafts SET state=$1,result=$2 WHERE hash=$3 AND sender=$4 AND state='executing'",
      [state, this.store.vault.seal(reply, `notification-result:${hash}:${sender}`), hash, sender],
    );
  }
  async result(sender: string, token: string): Promise<Reply | null> {
    const hash = digest(token);
    const { rows } = await this.store.db.query(
      'SELECT result FROM notification_drafts WHERE hash=$1 AND sender=$2',
      [hash, sender],
    );
    return rows[0]?.result
      ? this.store.vault.open(rows[0].result, `notification-result:${hash}:${sender}`)
      : null;
  }
  async enqueue(
    s: Subscription,
    occurrence: string,
    due: number,
    ttl: number,
    data: DeliveryData,
    now = Date.now(),
  ) {
    const id = digest(JSON.stringify([s.sender, s.kind, occurrence]));
    await this.store.db.query(
      `INSERT INTO notification_deliveries(id,sender,kind,revision,due,expires,data,created)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING`,
      [
        id,
        s.sender,
        s.kind,
        s.revision,
        due,
        due + ttl,
        this.store.vault.seal(data, `notification:${id}:${s.sender}`),
        now,
      ],
    );
  }
  async next(now: number): Promise<Delivery | null> {
    await this.store.db.query(
      "UPDATE notification_deliveries SET state='skipped',reason='expired' WHERE state='pending' AND expires<=$1",
      [now],
    );
    const { rows } = await this.store.db.query(
      `SELECT * FROM notification_deliveries WHERE state='pending' AND due<=$1 ORDER BY due,id LIMIT 1`,
      [now],
    );
    const r = rows[0];
    return r
      ? {
          ...r,
          due: Number(r.due),
          expires: Number(r.expires),
          data: this.store.vault.open(r.data, `notification:${r.id}:${r.sender}`),
        }
      : null;
  }
  async sending(id: string) {
    const r = await this.store.db.query(
      "UPDATE notification_deliveries SET state='sending' WHERE id=$1 AND state='pending'",
      [id],
    );
    return r.rowCount === 1;
  }
  async mark(
    id: string,
    state: 'accepted' | 'skipped' | 'uncertain',
    reason: string | null = null,
    metaId: string | null = null,
  ) {
    await this.store.db.query(
      "UPDATE notification_deliveries SET state=$2,reason=$3,meta_id=$4 WHERE id=$1 AND state IN ('pending','sending')",
      [id, state, reason, metaId],
    );
  }
  async receipt(id: string, status: string) {
    if (!['delivered', 'read', 'failed'].includes(status)) return;
    await this.store.db.query(
      `UPDATE notification_deliveries SET state=$2 WHERE meta_id=$1 AND
      (state IN ('accepted','uncertain') OR (state='delivered' AND $2='read'))`,
      [id, status],
    );
  }
  async history(sender: string) {
    const { rows } = await this.store.db.query(
      'SELECT kind,due,state,reason FROM notification_deliveries WHERE sender=$1 ORDER BY created DESC LIMIT 10',
      [sender],
    );
    return rows;
  }
}
