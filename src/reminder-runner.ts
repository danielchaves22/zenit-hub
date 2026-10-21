import type { Day } from "./connectors/day.js";
import type { NotificationTransport } from "./notification-transport.js";
import type { NotificationStore, Subscription } from "./notification-store.js";
import { ReminderQueue, type Occurrence } from "./reminder-queue.js";
import { quietUntil } from "./quiet-hours.js";
import type { Reply } from "./types.js";
import { reminderTime } from "./reminder-format.js";

export class ReminderRunner {
  constructor(
    readonly queue: ReminderQueue,
    readonly db: NotificationStore,
    readonly day: Day,
    readonly transport: NotificationTransport,
    readonly report: (
      s: Subscription,
      error: unknown,
      now: number,
    ) => Promise<void>,
  ) {}
  private async connected(o: Occurrence) {
    const c = await this.queue.store.connection(o.sender, "day");
    return (
      !!c && JSON.stringify([c.accountId, c.grantId ?? null]) === o.data.account
    );
  }
  private async sync(o: Occurrence) {
    if (!(await this.connected(o))) {
      await this.queue.synced(o);
      return;
    }
    const result = await this.day.completeReminder(
      o.sender,
      o.data.reminderId,
      o.data.reminderRevision,
      o.due,
    );
    if (!["completed", "obsolete"].includes(result.state))
      throw new Error("Invalid completion response");
    await this.queue.synced(o);
  }
  async acknowledge(sender: string, token: string): Promise<Reply> {
    const o = await this.queue.byToken(sender, token);
    if (!o || !o.attempt || !(await this.connected(o)))
      return { text: "Esta confirmação não está disponível para sua conta." };
    if (o.state === "completed")
      return {
        text: o.sync_pending
          ? "Os avisos desta ocorrência já foram interrompidos. O registro no Day ainda está aguardando sincronização."
          : "Esta ocorrência já foi concluída. Os próximos horários do lembrete continuam programados.",
      };
    if (
      o.state !== "pending" ||
      (o.valid_until !== null && o.valid_until <= Date.now())
    )
      return {
        text: "Esta mensagem é de uma ocorrência anterior ou cancelada. Use o botão do lembrete mais recente.",
      };
    // Stop locally first. If Day is unavailable, durably synchronize later instead
    // of continuing to bother someone who has already pressed Concluído.
    await this.queue.finish(o, "completed", true);
    try {
      const result = await this.day.completeReminder(
        sender,
        o.data.reminderId,
        o.data.reminderRevision,
        o.due,
      );
      if (!["completed", "obsolete"].includes(result.state))
        throw new Error("Invalid completion response");
      await this.queue.synced(o);
      if (result.state === "obsolete")
        return {
          text: "Esta ocorrência já foi substituída ou alterada no Day. Seus avisos foram encerrados; a ocorrência atual não foi concluída.",
        };
      return {
        text: `Concluído: ${o.data.title}. Não repetirei mais esta ocorrência. Os próximos horários continuam programados.`,
      };
    } catch {
      await this.queue.defer(o, Date.now() + 60_000);
      return {
        text: "As repetições desta ocorrência foram interrompidas. Não consegui registrar a conclusão no Day agora; tentarei sincronizar automaticamente.",
      };
    }
  }
  async tick(now: number) {
    for (const o of await this.queue.due(now)) {
      const s = await this.db.subscription(o.sender, "day_reminders");
      try {
        if (o.sync_pending) {
          try {
            await this.sync(o);
          } catch (error) {
            if (s?.enabled) await this.report(s, error, now);
            throw error;
          }
          continue;
        }
        if (
          !s?.enabled ||
          s.revision !== o.revision ||
          !(await this.connected(o))
        ) {
          await this.queue.finish(o, "cancelled");
          continue;
        }
        let status;
        try {
          status = await this.day.occurrenceState(
            o.sender,
            o.data.reminderId,
            o.data.reminderRevision,
            o.due,
          );
        } catch (error) {
          await this.report(s, error, now);
          throw error;
        }
        if (status.state === "completed") {
          await this.queue.finish(o, "completed");
          continue;
        }
        if (status.state === "obsolete") {
          await this.queue.finish(o, "superseded");
          continue;
        }
        if (status.state !== "pending" || !status.reminder)
          throw new Error("Invalid occurrence state");
        const r = status.reminder;
        const validUntil = status.validUntil
          ? Date.parse(status.validUntil)
          : null;
        if (validUntil !== null && !Number.isFinite(validUntil))
          throw new Error("Invalid occurrence boundary");
        if (validUntil !== null && validUntil <= Math.max(now, Date.now())) {
          await this.queue.finish(o, "superseded");
          continue;
        }
        const quiet =
          r.respect_quiet_hours !== false
            ? quietUntil(now, await this.queue.settings(o.sender))
            : null;
        if (quiet !== null) {
          await this.queue.defer(o, quiet, true, validUntil);
          continue;
        }
        const repeat = r.requires_confirmation === true;
        if (
          repeat &&
          (!Number.isInteger(r.repeat_minutes) ||
            r.repeat_minutes < 1 ||
            r.repeat_minutes > 10080)
        )
          throw new Error("Invalid repeat interval");
        if (!(await this.transport.approved("day_reminders", false, repeat))) {
          await this.queue.defer(o, now + 60_000);
          continue;
        }
        // Recheck quiet hours and expiry after provider reads; never send a backlog
        // of missed repeats. The next attempt is relative to this attempt.
        const sendAt = Math.max(now, Date.now());
        const lateQuiet =
          r.respect_quiet_hours !== false
            ? quietUntil(sendAt, await this.queue.settings(o.sender))
            : null;
        if (lateQuiet !== null) {
          await this.queue.defer(o, lateQuiet, true, validUntil);
          continue;
        }
        if (validUntil !== null && validUntil <= sendAt) {
          await this.queue.finish(o, "superseded");
          continue;
        }
        const id = await this.queue.claim(
          o,
          sendAt,
          repeat ? r.repeat_minutes : null,
          validUntil,
        );
        if (!id) continue;
        try {
          const metaId = await this.transport.send(
            o.sender,
            "day_reminders",
            [String(r.title), reminderTime(o.due, o.data.timeZone, sendAt)],
            repeat ? `hub:done:${o.data.token}` : undefined,
          );
          await this.db.mark(id, "accepted", null, metaId);
        } catch {
          await this.db.mark(id, "uncertain", "send_failed");
          console.error("hub.notifications.send.uncertain");
        }
      } catch (error) {
        await this.queue.defer(o, now + 60_000);
        console.error("hub.reminders.check.failed");
      }
    }
  }
}
