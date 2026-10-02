import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Store } from './store.js';
import type { Day } from './connectors/day.js';
import type { Cash } from './connectors/cash.js';
import type { Calendar } from './connectors/calendar.js';
import { PublicError, type Reply } from './types.js';
import {
  NotificationStore,
  type NotificationKind,
  type Preferences,
  type Subscription,
  type Delivery,
} from './notification-store.js';
import { NotificationTransport } from './notification-transport.js';

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const notificationChange = z
  .object({
    kind: z.enum(['daily_summary', 'day_reminders']),
    time: clock.nullable(),
    timeZone: z.string().min(1).max(80),
    sources: z.array(z.enum(['cash', 'day', 'calendar'])).max(3),
  })
  .strict();
export const reminderSchedule = z
  .object({
    kind: z.enum(['daily', 'weekly', 'monthly', 'interval']),
    timeZone: z.string().min(1).max(80),
    startAt: z.string().datetime({ offset: true }),
    endAt: z.string().datetime({ offset: true }).nullable(),
    times: z.array(clock).max(24),
    weekDays: z.array(z.number().int().min(0).max(6)).max(7),
    monthDay: z.number().int().min(1).max(31).nullable(),
    intervalMinutes: z.number().int().min(1).max(10080).nullable(),
    windowStart: clock.nullable(),
    windowEnd: clock.nullable(),
  })
  .strict();
export const reminderChange = z
  .object({
    operation: z.enum(['create', 'update', 'pause', 'resume', 'delete']),
    id: z.string().uuid().nullable(),
    title: z.string().trim().min(1).max(500).nullable(),
    schedule: reminderSchedule.nullable(),
  })
  .strict();
type Draft =
  | { type: 'subscription'; kind: NotificationKind; data: Preferences }
  | {
      type: 'reminder';
      account: string;
      operationId: string;
      id: string;
      revision: number;
      doc: any;
      operation: string;
    };
const names: Record<NotificationKind, string> = {
  daily_summary: 'Resumo diário',
  day_reminders: 'Lembretes do Day',
};
const trim = (s: string, n = 210) => (s.length <= n ? s : s.slice(0, n - 21) + '… consulte os demais.');
const plain = (s: unknown) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const localDate = (at: number, zone: string) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: zone, dateStyle: 'short' }).format(at);
const display = (at: number | string, zone: string) =>
  new Intl.DateTimeFormat('pt-BR', { timeZone: zone, dateStyle: 'short', timeStyle: 'short' }).format(
    new Date(at),
  );

export class Notifications {
  readonly db: NotificationStore;
  private ticking = false;
  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly day: Day,
    readonly cash: Cash,
    readonly calendar: Calendar,
    readonly transport = new NotificationTransport(config),
  ) {
    this.db = new NotificationStore(store);
  }
  private async accounts(sender: string, sources: Preferences['sources']) {
    const accounts: Record<string, string> = {};
    for (const source of sources) {
      if (source === 'cash') {
        if ((await this.store.cashDisabled(sender)) || !(await this.cash.connected(sender)))
          throw new PublicError('Conecte o Cash antes de incluí-lo nas notificações.');
        accounts.cash = 'connected';
      } else {
        const c = await this.store.connection(sender, source);
        if (!c)
          throw new PublicError(
            `Conecte ${source === 'day' ? 'o Day' : 'o Calendar'} antes de incluí-lo nas notificações.`,
          );
        accounts[source] = JSON.stringify([c.accountId, c.grantId ?? null]);
      }
    }
    return accounts;
  }
  private async valid(s: Subscription) {
    // Local authorization changes invalidate delivery. A provider outage must
    // leave the other sections usable; its authenticated read reports failure.
    for (const source of s.data.sources) {
      if (source === 'cash') {
        if (await this.store.cashDisabled(s.sender)) return false;
      } else {
        const c = await this.store.connection(s.sender, source);
        if (!c || JSON.stringify([c.accountId, c.grantId ?? null]) !== s.data.accounts[source]) return false;
      }
    }
    return true;
  }
  async catalog(sender: string): Promise<Reply> {
    const list = await this.db.list(sender);
    const lines = await Promise.all(
      (['daily_summary', 'day_reminders'] as const).map(async (kind) => {
        let ready = false;
        try {
          ready = await this.transport.approved(kind);
        } catch {
          /* Honest unavailable state. */
        }
        const s = list.find((s) => s.kind === kind);
        return `• ${names[kind]}: ${s?.enabled ? 'assinado' + (kind === 'daily_summary' ? ` às ${s.data.time} (${s.data.timeZone})` : '') : s ? 'pausado' : 'não assinado'}. ${ready ? 'Envio disponível.' : 'Envio aguardando configuração/aprovação no WhatsApp.'}`;
      }),
    );
    return {
      text: `Zenit Hub — notificações\n\n${lines.join('\n')}\n\nO resumo reúne agenda, contas vencendo e tarefas das fontes escolhidas. Peça “quero o resumo diário às 7h” e confirme pelo botão.\n\nOs lembretes recorrentes ficam no Day. Peça “ativar lembretes do Day” para autorizar e assinar o envio. Depois você pode criar, listar, editar, pausar ou excluir pelo chat ou pelo Day.\n\nPara pausar tudo, envie “parar notificações”. Conectar uma aplicação não assina avisos automaticamente.`,
      buttons: [
        { id: 'hub:notify:summary', title: 'Resumo diário' },
        { id: 'hub:notify:day', title: 'Lembretes do Day' },
        { id: 'hub:notify:status', title: 'Minhas assinaturas' },
      ],
    };
  }
  async status(sender: string): Promise<Reply> {
    const list = await this.db.list(sender),
      history = await this.db.history(sender);
    const states: Record<string, string> = {
      accepted: 'aceito pelo WhatsApp',
      delivered: 'entregue',
      read: 'lido',
      failed: 'falhou',
      skipped: 'não enviado',
      uncertain: 'envio incerto',
      pending: 'na fila',
      sending: 'em envio',
    };
    return {
      text: `Minhas notificações\n${list.map((s) => `${names[s.kind]}: ${s.enabled ? 'ativo' : 'pausado'}${s.kind === 'daily_summary' ? ` — ${s.data.time}, ${s.data.timeZone}; fontes: ${s.data.sources.join(', ')}` : ''}`).join('\n') || 'Nenhuma assinatura.'}\n\nÚltimos avisos:\n${history.map((h) => `${names[h.kind as NotificationKind]} — ${display(Number(h.due), this.config.timeZone)}: ${states[h.state] || h.state}`).join('\n') || 'Nenhum aviso programado ainda.'}\n\nEnvie “parar notificações”, “cancelar resumo diário” ou “cancelar lembretes do Day”. Para retomar, peça a assinatura novamente.`,
    };
  }
  async daySetup(sender: string): Promise<Reply> {
    if (!(await this.store.connection(sender, 'day')))
      return { text: 'Envie “conectar Day” primeiro. Depois peça “ativar lembretes do Day”.' };
    if (!(await this.day.remindersAuthorized(sender)))
      return {
        text: `O acesso atual do Day permite consultar assuntos. Para usar lembretes, entre na mesma conta e autorize nesta página:\n${this.config.day.siteUrl}/hub/reminders\n\nDepois volte aqui e envie “ativar lembretes do Day”. A assinatura será confirmada por botão.`,
      };
    return this.prepare(sender, {
      kind: 'day_reminders',
      time: null,
      timeZone: this.config.timeZone,
      sources: ['day'],
    });
  }
  async command(sender: string, command: string, button?: string): Promise<Reply | null> {
    const decision = /^hub:notify:(confirm|cancel):([A-Za-z0-9_-]{43})$/.exec(button || '');
    if (decision) return this.confirm(sender, decision[2], decision[1] === 'confirm');
    if (button === 'hub:notify:summary')
      return {
        text: 'Em qual horário você quer receber o resumo diário? Exemplo: “Quero o resumo diário às 7h com Cash, Day e Calendar”. Você verá o horário, fuso e fontes antes de confirmar.',
      };
    if (
      button === 'hub:notify:day' ||
      /^(?:ativar|assinar|receber|quero receber) (?:os )?lembretes(?: do day)?$/.test(command)
    )
      return this.daySetup(sender);
    if (
      button === 'hub:notify:status' ||
      ['minhas assinaturas', 'minhas notificacoes', 'status das notificacoes'].includes(command)
    )
      return this.status(sender);
    if (
      [
        'parar notificacoes',
        'parar todas as notificacoes',
        'cancelar notificacoes',
        'cancelar todas as notificacoes',
        'pausar notificacoes',
        'stop',
        'sair',
      ].includes(command)
    ) {
      await this.db.pause(sender);
      return {
        text: 'Todas as notificações pelo WhatsApp foram pausadas. Seus lembretes no Day continuam salvos. Para retomar, envie “notificações”.',
      };
    }
    const stop = /^(?:cancelar|pausar|parar) (?:o |os )?(resumo diario|lembretes do day)$/.exec(command);
    if (stop) {
      const kind = stop[1] === 'resumo diario' ? 'daily_summary' : 'day_reminders';
      await this.db.pause(sender, kind);
      return {
        text: `${names[kind]}: envio pelo WhatsApp pausado. Para retomar, peça a assinatura novamente.`,
      };
    }
    if (
      [
        'notificacoes',
        'avisos',
        'quais notificacoes posso receber',
        'quais notificacoes estao disponiveis',
        'quais sao as notificacoes disponiveis',
        'listar notificacoes',
      ].includes(command)
    )
      return this.catalog(sender);
    return null;
  }
  private async draft(sender: string, data: Draft, text: string): Promise<Reply> {
    const token = await this.db.draft(sender, data);
    return {
      text,
      buttons: [
        { id: `hub:notify:confirm:${token}`, title: 'Confirmar' },
        { id: `hub:notify:cancel:${token}`, title: 'Cancelar' },
      ],
    };
  }
  async prepare(sender: string, input: unknown): Promise<Reply> {
    const a = notificationChange.parse(input);
    new Intl.DateTimeFormat('pt-BR', { timeZone: a.timeZone }).format();
    if (a.kind === 'daily_summary' && a.time === null)
      throw new PublicError('Informe o horário do resumo diário.');
    const sources =
      a.kind === 'day_reminders'
        ? (['day'] as const)
        : ([...new Set(a.sources)].sort() as Preferences['sources']);
    if (!sources.length)
      throw new PublicError('Escolha pelo menos uma fonte conectada: Cash, Day ou Calendar.');
    const accounts = await this.accounts(sender, [...sources]);
    if (a.kind === 'day_reminders') await this.day.requireReminders(sender);
    await this.transport.require(a.kind);
    const data: Preferences = {
      time: a.time || '00:00',
      timeZone: a.timeZone,
      sources: [...sources],
      accounts,
      consentAt: 0,
      since: 0,
    };
    return this.draft(
      sender,
      { type: 'subscription', kind: a.kind, data },
      `Assinar ${names[a.kind]} pelo WhatsApp?\n${a.kind === 'daily_summary' ? `Todos os dias às ${data.time}, fuso ${data.timeZone}.\nFontes: ${data.sources.join(', ')}.\nO resumo consulta a agenda principal do Calendar e dados sincronizados.` : 'Receber todos os seus lembretes ativos e sincronizados do Day, nos horários definidos em cada lembrete.'}\n\nOs avisos poderão chegar sem uma mensagem sua antes. Você pode pausar a qualquer momento com “parar notificações”.\n\nConfirme pelo botão para ativar.`,
    );
  }
  async prepareReminder(sender: string, input: unknown, seen: Set<string>): Promise<Reply> {
    const parsed = reminderChange.safeParse(input);
    if (!parsed.success) throw new PublicError('Horário ou recorrência inválidos. Peça ao usuário para confirmar os horários no formato HH:MM, de 00:00 a 23:59. Não corrija nem crie o lembrete por suposição.');
    const a = parsed.data;
    await this.day.requireReminders(sender);
    const account = (await this.accounts(sender, ['day'])).day;
    let doc: any,
      revision = 0,
      id = a.id || randomUUID();
    if (a.operation === 'create') {
      if (a.id || !a.title || !a.schedule)
        throw new PublicError('Informe texto, frequência e horários do lembrete.');
      doc = { title: a.title, subject_id: null, enabled: true, deleted: false, schedule: a.schedule };
    } else {
      if (!a.id || !seen.has(a.id))
        throw new PublicError('Consulte a lista de lembretes nesta solicitação antes de alterar um deles.');
      const r = (await this.day.reminders(sender, a.id)).items[0];
      if (!r) throw new PublicError('Lembrete não encontrado.');
      revision = r.revision;
      doc = {
        title: r.title,
        subject_id: r.subject_id,
        enabled: r.enabled,
        deleted: r.deleted,
        schedule: r.schedule,
      };
      if (a.operation === 'update') {
        if (a.title) doc.title = a.title;
        if (a.schedule) doc.schedule = a.schedule;
      } else {
        if (a.title || a.schedule)
          throw new PublicError('Pausar, retomar ou excluir preserva o texto e a recorrência.');
        doc.enabled = a.operation === 'resume';
        doc.deleted = a.operation === 'delete';
      }
    }
    const next = doc.enabled ? await this.day.previewReminder(sender, doc.schedule) : [];
    if (doc.enabled && !next.length)
      throw new PublicError('Essa regra não tem ocorrências futuras. Confira as datas.');
    const s = doc.schedule,
      days = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
    const frequency =
      s.kind === 'daily'
        ? 'Diariamente'
        : s.kind === 'weekly'
          ? `Semanalmente: ${s.weekDays.map((i: number) => days[i]).join(', ')}`
          : s.kind === 'monthly'
            ? `Dia ${s.monthDay} de cada mês (último dia se o mês for menor)`
            : `A cada ${s.intervalMinutes} minutos${s.windowStart ? `, das ${s.windowStart} às ${s.windowEnd}` : ', desde o início, inclusive à noite'}`;
    const sub = await this.db.subscription(sender, 'day_reminders');
    return this.draft(
      sender,
      { type: 'reminder', account, id, revision, doc, operation: a.operation, operationId: randomUUID() },
      `Revisar lembrete no Day\n${doc.title}\n${frequency}${s.kind !== 'interval' ? `, ${s.times.join(', ')}` : ''}\nFuso: ${s.timeZone}\nInício: ${display(s.startAt, s.timeZone)}${s.endAt ? `\nFim (exclusivo): ${display(s.endAt, s.timeZone)}` : ''}\nEstado após confirmar: ${doc.deleted ? 'excluído' : doc.enabled ? 'ativo' : 'pausado'}\n${next.length ? `Próximos horários: ${next.map((at) => display(at, s.timeZone)).join('; ')}\n` : ''}\n${sub?.enabled ? 'Envio pelo WhatsApp assinado.' : 'Envio pelo WhatsApp não assinado. Para recebê-lo, peça “ativar lembretes do Day”.'}\nConfirme pelo botão para salvar.`,
    );
  }
  async confirm(sender: string, token: string, approved: boolean): Promise<Reply> {
    const draft = await this.db.claim<Draft>(sender, token, approved);
    if (!draft)
      return (
        (await this.db.result(sender, token)) || {
          text: 'Esta confirmação expirou, já foi processada ou foi substituída. Consulte o estado antes de repetir.',
        }
      );
    if (!approved) return { text: 'Alteração cancelada.' };
    try {
      let reply: Reply;
      if (draft.type === 'subscription') {
        if (
          JSON.stringify(await this.accounts(sender, draft.data.sources)) !==
          JSON.stringify(draft.data.accounts)
        )
          throw new PublicError('Uma conexão mudou. Solicite a assinatura novamente.');
        await this.transport.require(draft.kind);
        if (draft.kind === 'day_reminders') await this.day.requireReminders(sender);
        const now = Date.now();
        await this.db.save(sender, draft.kind, { ...draft.data, consentAt: now, since: now }, now);
        reply = {
          text: `${names[draft.kind]} assinado pelo WhatsApp${draft.kind === 'daily_summary' ? ` às ${draft.data.time} (${draft.data.timeZone})` : ''}. Os próximos horários serão considerados; avisos antigos não serão reenviados. Para pausar, envie “parar notificações”.`,
        };
      } else {
        if ((await this.accounts(sender, ['day'])).day !== draft.account)
          throw new PublicError('A conta do Day mudou. Solicite a alteração novamente.');
        await this.day.requireReminders(sender);
        const result = await this.day.saveReminder(
          sender,
          draft.operationId,
          draft.id,
          draft.revision,
          draft.doc,
        );
        if (result.result === 'conflict')
          throw new PublicError('O lembrete mudou no Day. Consulte a versão atual e solicite novamente.');
        if (result.result !== 'saved') throw new Error('Invalid save result');
        reply = {
          text: `Lembrete ${draft.doc.deleted ? 'excluído' : draft.doc.enabled ? 'salvo' : 'pausado'} no Day: ${draft.doc.title}.`,
        };
      }
      await this.db.finish(sender, token, reply);
      return reply;
    } catch (e) {
      const reply = {
        text:
          e instanceof PublicError
            ? e.message
            : 'Não foi possível confirmar. Consulte seus lembretes/assinaturas antes de repetir.',
      };
      await this.db.finish(sender, token, reply, 'uncertain');
      return reply;
    }
  }
  async tick(now = Date.now()) {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const s of await this.db.due(now)) {
        try {
          if (!(await this.valid(s))) {
            await this.db.pause(s.sender, s.kind);
            continue;
          }
          if (s.kind === 'daily_summary') {
            const date = localDate(now, s.data.timeZone);
            const { rows } = await this.store.db.query(
              'SELECT extract(epoch from (($1::date+$2::time) AT TIME ZONE $3))*1000 AS due',
              [date, s.data.time, s.data.timeZone],
            );
            const due = Number(rows[0].due);
            if (due >= s.data.since && due <= now && now - due < 3600_000)
              await this.db.enqueue(s, date, due, 3600_000, { date }, now);
          } else {
            const after = Math.max(s.data.since - 1, s.checkedAt, now - 300_000);
            const result = await this.day.occurrences(s.sender, after, now);
            if (!Array.isArray(result.items) || result.truncated)
              throw new Error('Incomplete reminder window');
            for (const r of result.items) {
              const due = Date.parse(r.dueAt);
              if (!Number.isFinite(due) || due <= after || due > now) throw new Error('Invalid occurrence');
              await this.db.enqueue(
                s,
                `${s.data.accounts.day}:${r.id}:${due}`,
                due,
                300_000,
                {
                  account: s.data.accounts.day,
                  reminderId: r.id,
                  reminderRevision: r.revision,
                  title: r.title,
                  timeZone: r.timeZone,
                },
                now,
              );
            }
          }
          await this.db.checked(s, now, true);
        } catch {
          await this.db.checked(s, now, false);
          console.error('hub.notifications.poll.failed');
        }
      }
      // Bound each tick so incoming messages are not starved by a backlog.
      for (let i = 0; i < 5; i++) {
        const d = await this.db.next(now);
        if (!d) break;
        await this.deliver(d, now);
      }
    } finally {
      this.ticking = false;
    }
  }
  private async deliver(d: Delivery, now: number) {
    try {
      const s = await this.db.subscription(d.sender, d.kind);
      if (!s?.enabled || s.revision !== d.revision || !(await this.valid(s))) {
        await this.db.mark(d.id, 'skipped', 'subscription_changed');
        return;
      }
      if (!(await this.transport.approved(d.kind))) {
        await this.db.mark(d.id, 'skipped', 'template_unavailable');
        return;
      }
      let values: string[];
      if (d.kind === 'day_reminders') {
        const r = (await this.day.reminders(d.sender, d.data.reminderId)).items[0];
        if (!r || !r.enabled || r.deleted || r.revision !== d.data.reminderRevision) {
          await this.db.mark(d.id, 'skipped', 'reminder_changed');
          return;
        }
        values = [plain(r.title), `${display(d.due, d.data.timeZone!)} (${d.data.timeZone})`];
      } else values = await this.summary(s, d.data.date!);
      // Authorization and age are checked again after the read requests.
      const latest = await this.db.subscription(d.sender, d.kind);
      if (!latest?.enabled || latest.revision !== d.revision || Math.max(now, Date.now()) >= d.expires) {
        await this.db.mark(d.id, 'skipped', 'expired_or_cancelled');
        return;
      }
      if (!(await this.db.sending(d.id))) return;
      try {
        const id = await this.transport.send(d.sender, d.kind, values);
        await this.db.mark(d.id, 'accepted', null, id);
      } catch {
        await this.db.mark(d.id, 'uncertain', 'send_failed');
        console.error('hub.notifications.send.uncertain');
      }
    } catch {
      await this.db.mark(d.id, 'skipped', 'source_unavailable');
      console.error('hub.notifications.source.failed');
    }
  }
  async summary(s: Subscription, date: string): Promise<string[]> {
    const sections: Record<string, string> = {
      calendar: 'Não incluída na assinatura.',
      cash: 'Não incluído na assinatura.',
      day: 'Não incluído na assinatura.',
    };
    const zone = s.data.timeZone;
    for (const source of s.data.sources)
      try {
        if (source === 'calendar') {
          const { rows } = await this.store.db.query(
            `SELECT ($1::date::timestamp AT TIME ZONE $2) AS start,(($1::date+1)::timestamp AT TIME ZONE $2) AS finish`,
            [date, zone],
          );
          const r = await this.calendar.events(s.sender, {
            start: rows[0].start.toISOString(),
            end: rows[0].finish.toISOString(),
            calendarId: 'primary',
            limit: 50,
          });
          const events = r.events.filter((e: any) => e.status !== 'cancelled');
          sections.calendar = events.length
            ? trim(
                `${events.length}${r.truncated ? '+' : ''} evento(s): ` +
                  events
                    .map(
                      (e: any) =>
                        `${e.start?.date ? 'dia inteiro' : new Intl.DateTimeFormat('pt-BR', { timeZone: zone, timeStyle: 'short' }).format(new Date(e.start.dateTime))} ${plain(e.summary || 'Sem título')}`,
                    )
                    .join('; '),
              )
            : 'Nenhum evento na agenda principal.';
        } else if (source === 'cash') {
          const r = await this.cash.query(s.sender, 'get_due_obligations', {
            window: 'CUSTOM',
            startDate: date,
            endDate: date,
            limit: 20,
          });
          const data = r.data;
          if (data?.ok !== true) throw new Error('Incomplete Cash summary');
          const amount = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(
            data.totalAmount,
          );
          sections.cash = data.totalItems
            ? trim(
                `${data.totalItems} conta(s) vencendo hoje, ${amount}: ` +
                  data.items.map((i: any) => plain(i.description)).join('; '),
              )
            : 'Nenhuma conta pendente vencendo hoje.';
        } else {
          const r = await this.day.daily(s.sender, date);
          sections.day = r.items.length
            ? trim(
                `${r.items.length}${r.truncated ? '+' : ''} assunto(s): ` +
                  r.items
                    .map(
                      (i: any) =>
                        `${plain(i.title)} (${i.due_on && i.due_on < date ? 'prazo atrasado' : i.due_on === date ? 'prazo hoje' : i.review_on && i.review_on <= date ? 'retomada' : 'planejado hoje'})`,
                    )
                    .join('; '),
              )
            : 'Nenhum assunto com prazo, retomada ou planejamento para hoje.';
        }
      } catch {
        sections[source] = 'Consulta indisponível; não significa ausência de compromissos.';
      }
    return [date.split('-').reverse().join('/'), sections.calendar, sections.cash, sections.day];
  }
}
