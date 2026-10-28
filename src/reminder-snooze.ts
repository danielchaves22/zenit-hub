import type { Day } from './connectors/day.js';
import type { NotificationStore, Subscription } from './notification-store.js';
import type { ReminderQueue, SnoozeDraft } from './reminder-queue.js';
import { digest } from './security.js';
import { quietUntil } from './quiet-hours.js';
import { PublicError, type Reply } from './types.js';

const unavailable = 'Este aviso já foi concluído, alterado ou substituído, ou o envio está pausado. Use Adiar no lembrete vigente.';
const minutesPrompt = 'Por quantos minutos deseja adiar? Envie um número inteiro entre 1 e 10080, como 20, ou “cancelar”. O prazo começa quando você responder.';
export class ReminderSnooze {
  constructor(readonly queue: ReminderQueue, readonly db: NotificationStore, readonly day: Day,
    private report: (s: Subscription, error: unknown, now: number) => Promise<void>) {}

  private async current(sender: string, token: string, now: number) {
    const o = await this.queue.byToken(sender, token);
    const c = await this.queue.store.connection(sender, 'day');
    const s = await this.db.subscription(sender, 'day_reminders');
    if (!o || !c || o.state !== 'pending' || !o.attempt || !s?.enabled || s.revision !== o.revision ||
      JSON.stringify([c.accountId,c.grantId ?? null]) !== o.data.account || (o.valid_until !== null && o.valid_until <= now))
      throw new PublicError(unavailable);
    let status;
    try { status = await this.day.occurrenceState(sender,o.data.reminderId,o.data.reminderRevision,o.due); }
    catch (error) {
      await this.report(s,error,now);
      throw new PublicError('Não consegui conferir este lembrete no Day. O adiamento não foi aplicado. Tente o botão Adiar novamente quando o acesso estiver disponível.');
    }
    const validUntil = status.validUntil ? Date.parse(status.validUntil) : null;
    if (status.state !== 'pending' || status.reminder?.requires_confirmation !== true ||
      (validUntil !== null && (!Number.isFinite(validUntil) || validUntil <= now))) throw new PublicError(unavailable);
    return { o, reminder: status.reminder, validUntil };
  }

  async command(sender: string, command: string, button?: string): Promise<Reply | null> {
    const start = /^hub:snooze:([A-Za-z0-9_-]{43})$/.exec(button || '');
    if (start) {
      const previous = await this.db.pending<SnoozeDraft>(sender,true);
      if (previous?.data.type === 'reminder_snooze') await this.db.cancelPending(sender,previous.hash,true);
      const { o } = await this.current(sender,start[1],Date.now());
      const draft: SnoozeDraft = { type: 'reminder_snooze', occurrenceId: o.id, token: o.data.token };
      const token = await this.db.draft(sender,draft);
      return { text: `${o.data.title}\n${minutesPrompt}`, buttons: [{ id: `hub:snooze:cancel:${token}`, title: 'Cancelar' }] };
    }
    const cancel = /^hub:snooze:cancel:([A-Za-z0-9_-]{43})$/.exec(button || '');
    const pending = await this.db.pending<SnoozeDraft>(sender,true);
    if (cancel) {
      if (!pending || pending.data.type !== 'reminder_snooze' || pending.hash !== digest(cancel[1]))
        return { text: 'Esta escolha de adiamento expirou ou foi substituída.' };
      await this.db.cancelPending(sender,pending.hash,true);
      return { text: 'Adiamento cancelado. O lembrete segue a programação atual.' };
    }
    if (pending?.data.type !== 'reminder_snooze') return null;
    if (!button && command === 'cancelar') {
      await this.db.cancelPending(sender,pending.hash,true);
      return { text: 'Adiamento cancelado. O lembrete segue a programação atual.' };
    }
    // A new topic or button abandons this question. A later number must never
    // silently postpone an older reminder (or select an item in another dialog).
    if (button || !/^[+-]?\d[\d\s.,+-]*(?:min(?:uto)?s?)?$/.test(command)) {
      await this.db.cancelPending(sender,pending.hash,true); return null;
    }
    if (pending.expires <= Date.now()) {
      await this.db.cancelPending(sender,pending.hash,true);
      return { text: 'A pergunta expirou. Toque em Adiar no lembrete novamente para escolher os minutos.' };
    }
    const match = /^(\d+)\s*(?:min(?:uto)?s?)?$/.exec(command);
    const minutes = match ? Number(match[1]) : 0;
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 10080)
      return { text: `Use um número inteiro de 1 a 10080 minutos. ${minutesPrompt}` };
    let current;
    try { current = await this.current(sender,pending.data.token,Date.now()); }
    catch (error) { await this.db.cancelPending(sender,pending.hash); throw error; }
    const { o, reminder, validUntil } = current;
    // Start counting at acceptance, after the authenticated provider check.
    const now = Date.now(), until = now + minutes * 60_000;
    const quiet = reminder.respect_quiet_hours !== false ? quietUntil(until,await this.queue.settings(sender)) : null;
    if (!await this.queue.snooze(o,pending.hash,until,quiet,validUntil,now)) {
      await this.db.cancelPending(sender,pending.hash,true);
      return { text: 'O lembrete ou a escolha mudou. Use Adiar no aviso mais recente para tentar novamente.' };
    }
    const next = Math.max(until,quiet ?? 0);
    const when = new Intl.DateTimeFormat('pt-BR', { timeZone: o.data.timeZone, dateStyle: 'short', timeStyle: 'short' }).format(next);
    const timing = validUntil !== null && next >= validUntil
      ? 'A ocorrência atual termina antes desse prazo e não será reenviada. Os próximos horários do lembrete continuam programados.'
      : `Próximo aviso a partir de ${when}${quiet ? ', após o período de silêncio' : ''}. Depois, a repetição volta ao intervalo configurado.`;
    return { text: `Adiado por ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}: ${o.data.title}.\n${timing}\nO lembrete continua pendente.` };
  }
}
