import type { Store } from "./store.js";
import type { Subscription } from "./notification-store.js";
import { transaction } from "./database.js";
import { digest, randomToken } from "./security.js";
import { quietHoursSchema, type QuietHours } from "./quiet-hours.js";

export type OccurrenceData = {
  account: string;
  reminderId: string;
  reminderRevision: number;
  token: string;
  title: string;
  timeZone: string;
};
export type Occurrence = {
  id: string;
  sender: string;
  revision: number;
  due: number;
  next_send: number;
  valid_until: number | null;
  quiet_until: number;
  attempt: number;
  state: string;
  sync_pending: boolean;
  data: OccurrenceData;
};
export class ReminderQueue {
  constructor(readonly store: Store) {}
  private open(r: any): Occurrence {
    return {
      ...r,
      due: Number(r.due),
      next_send: Number(r.next_send),
      valid_until: r.valid_until === null ? null : Number(r.valid_until),
      quiet_until: Number(r.quiet_until),
      data: this.store.vault.open(
        r.data,
        `reminder-occurrence:${r.id}:${r.sender}`,
      ),
    };
  }
  async settings(sender: string): Promise<QuietHours | null> {
    const { rows } = await this.store.db.query(
      "SELECT data FROM notification_settings WHERE sender=$1",
      [sender],
    );
    return rows[0]
      ? quietHoursSchema.parse(
          this.store.vault.open(
            rows[0].data,
            `notification-settings:${sender}`,
          ),
        )
      : null;
  }
  async saveSettings(sender: string, settings: QuietHours) {
    const data = quietHoursSchema.parse(settings);
    await transaction(this.store.db, async (tx) => {
      await tx.query(
        "INSERT INTO notification_settings VALUES($1,$2) ON CONFLICT(sender) DO UPDATE SET data=excluded.data",
        [
          sender,
          this.store.vault.seal(data, `notification-settings:${sender}`),
        ],
      );
      await tx.query(
        "UPDATE reminder_occurrences SET next_send=$2,quiet_until=0 WHERE sender=$1 AND state='pending' AND quiet_until>0",
        [sender, Date.now()],
      );
    });
  }
  async remember(
    s: Subscription,
    r: {
      id: string;
      revision: number;
      dueAt: string;
      title: string;
      timeZone: string;
    },
    now: number,
  ) {
    const due = Date.parse(r.dueAt),
      key = digest(JSON.stringify([s.sender, s.data.accounts.day, r.id]));
    const id = digest(JSON.stringify([key, due])),
      token = randomToken();
    const data: OccurrenceData = {
      account: s.data.accounts.day,
      reminderId: r.id,
      reminderRevision: r.revision,
      token,
      title: r.title,
      timeZone: r.timeZone,
    };
    await transaction(this.store.db, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1),903282)", [
        s.sender,
      ]);
      const newer = await tx.query(
        "SELECT 1 FROM reminder_occurrences WHERE sender=$1 AND reminder_key=$2 AND due>=$3 LIMIT 1",
        [s.sender, key, due],
      );
      if (newer.rowCount) return;
      await tx.query(
        "UPDATE reminder_occurrences SET state='superseded',updated=$3 WHERE sender=$1 AND reminder_key=$2 AND state='pending'",
        [s.sender, key, now],
      );
      await tx.query(
        `INSERT INTO reminder_occurrences(id,sender,reminder_key,revision,due,next_send,ack_hash,data,updated)
        VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [
          id,
          s.sender,
          key,
          s.revision,
          due,
          digest(token),
          this.store.vault.seal(data, `reminder-occurrence:${id}:${s.sender}`),
          now,
        ],
      );
    });
  }
  async due(now: number) {
    const { rows } = await this.store.db.query(
      "SELECT * FROM reminder_occurrences WHERE (state='pending' OR sync_pending) AND next_send<=$1 ORDER BY next_send,id LIMIT 5",
      [now],
    );
    return rows.map((r) => this.open(r));
  }
  async byToken(sender: string, token: string) {
    const { rows } = await this.store.db.query(
      "SELECT * FROM reminder_occurrences WHERE sender=$1 AND ack_hash=$2",
      [sender, digest(token)],
    );
    return rows[0] ? this.open(rows[0]) : null;
  }
  async status(sender: string, now = Date.now()) {
    const { rows } = await this.store.db.query(
      `SELECT count(*) FILTER(WHERE o.state='pending')::int pending,
      count(*) FILTER(WHERE o.state='pending' AND quiet_until>$2)::int quiet,
      count(*) FILTER(WHERE o.state='pending' AND attempt>0)::int awaiting,
      count(*) FILTER(WHERE sync_pending)::int syncing
      FROM reminder_occurrences o JOIN notification_subscriptions s ON s.sender=o.sender AND s.kind='day_reminders'
      WHERE o.sender=$1 AND s.enabled AND s.revision=o.revision AND (valid_until IS NULL OR valid_until>$2)`,
      [sender, now],
    );
    return rows[0] as {
      pending: number;
      quiet: number;
      awaiting: number;
      syncing: number;
    };
  }
  async defer(
    o: Occurrence,
    at: number,
    quiet = false,
    validUntil: number | null = null,
  ) {
    await this.store.db.query(
      "UPDATE reminder_occurrences SET next_send=$2,quiet_until=$3,valid_until=coalesce($4,valid_until) WHERE id=$1 AND (state='pending' OR sync_pending)",
      [o.id, at, quiet ? at : 0, validUntil],
    );
  }
  async finish(
    o: Occurrence,
    state: "cancelled" | "superseded" | "completed",
    sync = false,
  ) {
    await this.store.db.query(
      "UPDATE reminder_occurrences SET state=$2,sync_pending=$3,next_send=$4,updated=$4 WHERE id=$1 AND state IN ('pending','completed')",
      [o.id, state, sync, Date.now()],
    );
  }
  async synced(o: Occurrence) {
    await this.store.db.query(
      "UPDATE reminder_occurrences SET sync_pending=false WHERE id=$1",
      [o.id],
    );
  }
  async claim(
    o: Occurrence,
    now: number,
    repeatMinutes: number | null,
    validUntil: number | null,
  ) {
    return transaction(this.store.db, async (tx) => {
      // A claim reserves one attempt before HTTP. A restart never replays it.
      const { rows } = await tx.query(
        `UPDATE reminder_occurrences SET attempt=attempt+1,next_send=$3,
        valid_until=$4,quiet_until=0,state=$5,updated=$2 WHERE id=$1 AND state='pending' AND attempt=$6 AND next_send<=$2
        AND EXISTS(SELECT 1 FROM notification_subscriptions s WHERE s.sender=reminder_occurrences.sender AND s.kind='day_reminders' AND s.enabled AND s.revision=reminder_occurrences.revision) RETURNING attempt`,
        [
          o.id,
          now,
          now + (repeatMinutes ?? 5) * 60_000,
          validUntil,
          repeatMinutes === null ? "finished" : "pending",
          o.attempt,
        ],
      );
      if (!rows[0]) return null;
      const id = digest(`${o.id}:${rows[0].attempt}`);
      await tx.query(
        `INSERT INTO notification_deliveries(id,sender,kind,revision,due,expires,data,created,state)
        VALUES($1,$2,'day_reminders',$3,$4,$5,$6,$7,'sending')`,
        [
          id,
          o.sender,
          o.revision,
          o.due,
          now + 300_000,
          this.store.vault.seal(
            { ...o.data, token: undefined },
            `notification:${id}:${o.sender}`,
          ),
          now,
        ],
      );
      return id;
    });
  }
}
