import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { eventChange } from './connectors/calendar-writes.js';
import { checkCalendarTiming } from './calendar-evidence.js';
import { Store } from './store.js';
import { PublicError, type Reply } from './types.js';

type Change = z.infer<typeof eventChange>;
export type CalendarIntent = { id: string; accountId: string; grantId?: string; change: Change };
export const eventCompletion = eventChange.pick({ title: true, start: true, end: true, allDay: true, timingEvidence: true })
  .extend({ intentId: z.string().uuid() }).strict();

// Only values validated against the current user's message enter this draft.
// Past assistant prose and unrelated turns cannot provide timing evidence.
export class CalendarIntents {
  constructor(private store: Store, private timeZone: string, private prepare: (sender: string, change: Change) => Promise<Reply>) {}
  pending(sender: string) { return this.store.pendingCalendarIntent<CalendarIntent>(sender); }

  async begin(sender: string, change: Change, message: string) {
    checkCalendarTiming(change, [message], this.timeZone, true);
    this.validate(change);
    const connection = await this.store.connection(sender, 'calendar');
    if (!connection) throw new PublicError('Conecte o Calendar antes de preparar um evento.');
    const intent: CalendarIntent = { id: randomUUID(), accountId: connection.accountId, grantId: connection.grantId, change };
    await this.store.saveCalendarIntent(sender, intent);
    return this.finish(sender, intent);
  }

  async complete(sender: string, input: unknown, message: string) {
    const args = eventCompletion.parse(input);
    const intent = await this.pending(sender);
    if (!intent || intent.id !== args.intentId) throw new PublicError('Esse pedido expirou ou foi substituído. Informe novamente o evento que deseja preparar.');
    const allDay = args.allDay ?? intent.change.allDay;
    const newTimes = { start: args.start === intent.change.start ? null : args.start,
      end: args.end === intent.change.end ? null : args.end };
    // Completing the date of an already explicit all-day request does not need
    // the user to say "dia inteiro" again. validate() still rejects timed values.
    if (!(intent.change.allDay === true && allDay === true))
      checkCalendarTiming({ operation: intent.change.operation, ...args, ...newTimes,
        allDay: (newTimes.start || newTimes.end || args.allDay !== null) ? allDay : null }, [message], this.timeZone, true);
    const change = { ...intent.change, title: args.title ?? intent.change.title,
      start: args.start ?? intent.change.start, end: args.end ?? intent.change.end, allDay,
      timingEvidence: args.timingEvidence ?? intent.change.timingEvidence };
    this.validate(change);
    const updated = { ...intent, change };
    await this.store.saveCalendarIntent(sender, updated);
    return this.finish(sender, updated);
  }

  private validate(change: Change) {
    for (const value of [change.start, change.end]) {
      if (!value) continue;
      const valid = change.allDay
        ? /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
        : z.string().datetime({ offset: true }).safeParse(value).success;
      if (!valid) throw new PublicError('O Hub não conseguiu interpretar a data e o horário do pedido. Nenhum evento foi gravado.');
    }
    if (change.start && change.end && Date.parse(change.end) <= Date.parse(change.start))
      throw new PublicError('O término precisa ser posterior ao início. Qual é a data e o horário de término?');
  }

  question(intent: CalendarIntent): string | null {
    const c = intent.change;
    if (c.operation === 'create' && !c.title) return 'Qual é o título do compromisso?';
    if (c.operation === 'create' || c.start !== null || c.end !== null || c.allDay !== null) {
      const format = (value: string) => new Intl.DateTimeFormat('pt-BR', { timeZone: this.timeZone,
        dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
      if (!c.start && !c.end) return 'Em qual data e horário será o compromisso? Informe início e término, ou diga “dia inteiro”.';
      if (!c.start) return c.allDay ? 'Qual é a data de início do compromisso de dia inteiro?' : `Qual é a data e o horário de início? Já tenho o término em ${format(c.end!)}.`;
      if (!c.end) return c.allDay ? 'Qual é o último dia desse compromisso de dia inteiro?' : `Qual será o horário de término do compromisso? Já tenho o início em ${format(c.start)}.`;
      if (c.allDay === null) return 'Esse compromisso é de dia inteiro ou tem horário?';
    }
    return null;
  }

  private async finish(sender: string, intent: CalendarIntent): Promise<Reply> {
    const question = this.question(intent);
    if (question) return { text: question };
    // Only a preview: CalendarWrites still enforces OAuth, permissions and the
    // final button. Keep the intent on failure so the user can retry its data.
    try {
      const reply = await this.prepare(sender, intent.change);
      await this.store.clearCalendarIntent(sender);
      return reply;
    } catch (error) {
      return { text: `Não consegui preparar a prévia. ${error instanceof PublicError ? error.message : 'Ocorreu uma falha interna no Hub.'} Nenhum evento foi gravado. O pedido foi mantido por até 30 minutos para tentar novamente.` };
    }
  }
}
