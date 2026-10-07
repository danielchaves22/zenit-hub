import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { OAuth } from '../oauth.js';
import { digest, randomToken } from '../security.js';
import { PublicError, type Connection, type Fetch, type Reply } from '../types.js';
import { Guests, resolveFavorite, type Favorite } from '../guests.js';

const calendarId = z.string().min(1).max(512);
export const eventChange = z.object({
  operation: z.enum(['create', 'update', 'delete']), calendarId,
  eventId: z.string().regex(/^[a-zA-Z0-9_-]{5,1024}$/).nullable(), title: z.string().trim().min(1).max(300).nullable(),
  description: z.string().max(2000).nullable(), location: z.string().max(500).nullable(),
  start: z.string().max(40).nullable(), end: z.string().max(40).nullable(), allDay: z.boolean().nullable(),
  timingEvidence: z.string().max(1000).nullable(),
  reminderMinutes: z.array(z.number().int().min(0).max(40320)).max(5).nullable()
}).strict();
type EventTime = { date?: string | null; dateTime?: string | null; timeZone?: string | null };
type Event = { id: string; etag: string; summary?: string; description?: string; location?: string;
  start: EventTime; end: EventTime; status?: string; recurrence?: string[]; recurringEventId?: string;
  eventType?: string; attendees?: { email?: string }[]; attendeesOmitted?: boolean;
  organizer?: { self?: boolean; email?: string }; reminders?: { useDefault: boolean; overrides?: { method: string; minutes: number }[] } };
type Patch = Partial<Pick<Event, 'summary' | 'description' | 'location' | 'start' | 'end' | 'reminders' | 'attendees'>>;
type Draft = { operation: 'create' | 'update' | 'delete'; accountId: string; grant: string;
  calendarId: string; eventId: string; etag?: string; patch: Patch; preview: string;
  guests?: { stage: 'choose' | 'review'; token: string; revision: number; favorites: Favorite[] } };
class CalendarError extends PublicError {
  constructor(readonly status: number) {
    super(status === 412 ? 'O evento mudou no Google depois da prévia. Consulte novamente e revise uma nova confirmação.'
      : status === 401 ? 'A autorização do Google expirou ou foi revogada. Envie "conectar Calendar".'
      : status === 403 ? 'O Google não permitiu a operação nesta agenda. Confira as permissões da conta ou reconecte o Calendar.'
      : status === 404 || status === 410 ? 'A agenda ou o evento não está mais disponível. Consulte novamente.'
      : status === 400 ? 'O Google recusou os dados do evento. Revise as datas e os campos do pedido.'
      : 'O Google não confirmou a operação. Consulte a agenda antes de repetir o pedido.');
  }
}
const grant = (c: Connection) => c.grantId || digest(`${c.accountId}:${c.tokens.refresh_token}`);
const plain = (s: string) => s.replace(/[\r\n\t]/g, ' ');
function times(start: string, end: string, allDay: boolean, timeZone: string): { start: EventTime; end: EventTime } {
  if (allDay) {
    const valid = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
    if (!valid(start) || !valid(end) || end <= start) throw new PublicError('Para dia inteiro, informe datas válidas; a data final é exclusiva e deve ser posterior ao início.');
    return { start: { date: start }, end: { date: end } };
  }
  if (!z.string().datetime({ offset: true }).safeParse(start).success || !z.string().datetime({ offset: true }).safeParse(end).success || Date.parse(end) <= Date.parse(start)) {
    throw new PublicError('Informe início e fim válidos, com ano e fuso horário. O fim deve ser posterior ao início.');
  }
  return { start: { dateTime: start, timeZone }, end: { dateTime: end, timeZone } };
}
function when(event: Pick<Event, 'start' | 'end'>, zone: string) {
  if (event.start.date && event.end.date) {
    const day = (s: string) => s.split('-').reverse().join('/');
    const last = new Date(Date.parse(event.end.date) - 86400_000).toISOString().slice(0, 10);
    return `Dia inteiro: ${day(event.start.date)}${last !== event.start.date ? ` até ${day(last)}` : ''}`;
  }
  const format = (s?: string | null) => s ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: zone }).format(new Date(s)) : 'não informado';
  return `${format(event.start.dateTime)} → ${format(event.end.dateTime)} (${zone})`;
}

export class CalendarWrites {
  constructor(private oauth: OAuth, private fetcher: Fetch = fetch) {}
  private async request(c: Connection, path: string, init: RequestInit = {}) {
    let response: Response;
    try { response = await this.fetcher(`https://www.googleapis.com/calendar/v3${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(45_000),
      headers: { Authorization: `Bearer ${c.tokens.access_token}`, 'Content-Type': 'application/json', ...init.headers } }); }
    catch { throw new PublicError('O Google não respondeu. Consulte a agenda antes de repetir uma operação.'); }
    if (!response.ok) throw new CalendarError(response.status);
    if (response.status === 204) return null;
    const text = await response.text();
    if (text.length > 2_000_000) throw new PublicError('Resposta muito grande. Consulte um período menor.');
    try { return JSON.parse(text); } catch { throw new PublicError('O Google retornou uma resposta inválida. Consulte a agenda antes de repetir.'); }
  }
  private async writable(sender: string) {
    const c = await this.oauth.connection(sender, 'calendar');
    if (!c.tokens.scope?.split(' ').includes('https://www.googleapis.com/auth/calendar.events')) {
      throw new PublicError('Autorize a escrita na agenda enviando "conectar Calendar" novamente.');
    }
    return c;
  }
  async prepare(sender: string, input: unknown): Promise<Reply> {
    const q = eventChange.parse(input); const c = await this.writable(sender);
    const calendar = await this.request(c, `/users/me/calendarList/${encodeURIComponent(q.calendarId)}`);
    if (!['owner', 'writer'].includes(calendar.accessRole)) throw new PublicError('Sua conta só pode consultar esta agenda. Escolha uma agenda com permissão de edição.');
    const target = calendarId.parse(calendar.id); const path = `/calendars/${encodeURIComponent(target)}/events`;
    let before: Event | undefined; const patch: Patch = {};
    if (q.operation === 'create') {
      if (q.eventId !== null || !q.title || !q.start || !q.end || q.allDay === null) throw new PublicError('Para criar, informe título, início e fim, com ano, e se o evento dura o dia inteiro.');
    } else {
      if (!q.eventId) throw new PublicError('Consulte os eventos e identifique o compromisso antes de alterá-lo.');
      before = await this.request(c, `${path}/${encodeURIComponent(q.eventId)}`) as Event;
      if (!before.etag || before.status === 'cancelled') throw new PublicError('Este evento não está disponível para edição. Consulte novamente.');
      if (before.recurrence?.length) throw new PublicError('Para eventos recorrentes, indique uma ocorrência com data. Alterar a série inteira ainda deve ser feito no Google Calendar.');
      if (before.eventType && before.eventType !== 'default') throw new PublicError('Este é um evento especial do Google. Edite-o diretamente no Calendar.');
      if (before.attendeesOmitted) throw new PublicError('Não foi possível conferir todos os convidados. Revise este evento diretamente no Google Calendar.');
    }
    const fields = [q.title, q.description, q.location, q.start, q.end, q.allDay, q.reminderMinutes];
    if (q.operation === 'delete' && fields.some(v => v !== null)) throw new PublicError('Para excluir, envie somente a identificação do evento.');
    if (q.operation !== 'delete') {
      if (q.title !== null) patch.summary = q.title;
      if (q.description !== null) patch.description = q.description;
      if (q.location !== null) patch.location = q.location;
      if (q.start !== null || q.end !== null || q.allDay !== null) {
        if (q.start === null || q.end === null || q.allDay === null) throw new PublicError('Para mudar o horário, informe início, fim e se o evento dura o dia inteiro.');
        const range = times(q.start, q.end, q.allDay, this.oauth.config.timeZone);
        // Clear mutually exclusive fields when converting between timed and all-day events.
        patch.start = { date: null, dateTime: null, timeZone: null, ...range.start };
        patch.end = { date: null, dateTime: null, timeZone: null, ...range.end };
        if (q.operation === 'create') Object.assign(patch, range);
      }
      if (q.reminderMinutes !== null) patch.reminders = { useDefault: false, overrides: [...new Set(q.reminderMinutes)].map(minutes => ({ method: 'popup', minutes })) };
      if (!Object.keys(patch).length) throw new PublicError('Informe o que deseja alterar no evento.');
    }
    const after = { ...before, ...patch } as Event;
    const action = q.operation === 'create' ? 'Criar evento' : q.operation === 'update' ? 'Alterar evento' : 'Excluir evento desta agenda';
    const lines = [`Google Calendar — ${action}`, `Conta: ${plain(c.label)}`, `Agenda: ${plain(calendar.summary || target)}`];
    if (before) lines.push(`Evento atual: ${plain(before.summary || '(sem título)')}`, when(before, this.oauth.config.timeZone));
    if (q.operation !== 'delete') {
      lines.push(`${before ? 'Após a alteração' : 'Título'}: ${plain(after.summary || '(sem título)')}`, when(after, this.oauth.config.timeZone));
      if ('location' in patch) lines.push(`Local: ${patch.location || '(remover)'}`);
      if ('description' in patch) lines.push(`Descrição: ${patch.description || '(remover)'}`);
      if (patch.reminders) lines.push(`Lembretes no Google: ${q.reminderMinutes?.length ? q.reminderMinutes.join(', ') + ' min antes' : 'sem lembretes'}`);
      else if (q.operation === 'create') lines.push('Lembretes: padrão da agenda.');
    }
    if (before?.recurringEventId) lines.push('Somente esta ocorrência; as outras datas permanecem como estão.');
    if (before?.attendees?.length) {
      lines.push(`Convidados: ${before.attendees.map(a => a.email || '(sem e-mail)').join(', ')}`);
      lines.push(before.organizer?.self ? 'O Google poderá notificar os convidados desta alteração ou exclusão.' : 'Evento de outro organizador: a operação será feita na sua cópia; o Google poderá enviar notificações.');
    }
    lines.push('Confirme pelo botão em até 10 minutos. Nada foi gravado ainda.');
    const preview = lines.join('\n');
    if (preview.length > 7000) throw new PublicError('O evento tem detalhes demais para revisar no WhatsApp. Faça a alteração diretamente no Google Calendar.');
    const token = randomToken();
    const draft: Draft = { operation: q.operation, accountId: c.accountId, grant: grant(c), calendarId: target,
      eventId: q.eventId || randomUUID().replaceAll('-', ''), etag: before?.etag, patch, preview };
    if (q.operation === 'create') {
      const favorites = await new Guests(this.oauth.store).list(sender);
      if (favorites.items.length) draft.guests = { stage: 'choose', token, revision: favorites.revision, favorites: favorites.items };
    }
    await this.oauth.store.calendarDraft(sender, token, draft);
    if (draft.guests) return { text: `${preview}\n\nDeseja adicionar convidados favoritos? Escolha antes de confirmar a criação.`, buttons: [
      { id: `hub:calendar:guests:${token}`, title: 'Escolher convidados' },
      { id: `hub:calendar:none:${token}`, title: 'Sem convidados' },
      { id: `hub:calendar:cancel:${token}`, title: 'Cancelar' }
    ] };
    return { text: preview, buttons: [{ id: `hub:calendar:confirm:${token}`, title: 'Confirmar' }, { id: `hub:calendar:cancel:${token}`, title: 'Cancelar' }] };
  }
  private async choosing(sender: string, token?: string) {
    const pending = await this.oauth.store.pendingCalendarDraft<Draft>(sender, token);
    if (!pending?.data.guests || pending.data.guests.stage !== 'choose') throw new PublicError('A seleção expirou ou já foi concluída/substituída. Faça um novo pedido de evento.');
    const draft = pending.data; const c = await this.writable(sender);
    if (c.accountId !== draft.accountId || grant(c) !== draft.grant) throw new PublicError('A conexão do Calendar mudou. Faça o pedido novamente.');
    const favorites = await new Guests(this.oauth.store).list(sender);
    if (favorites.revision !== draft.guests!.revision) throw new PublicError('Seus favoritos mudaram depois deste pedido. Prepare o evento novamente para usar a lista atual.');
    return draft;
  }
  async openGuests(sender: string, token: string): Promise<Reply> {
    const draft = await this.choosing(sender, token); const favorites = draft.guests!.favorites;
    if (!this.oauth.config.meta.guestsFlowId) return { text: `Convidados favoritos\n${favorites.map((f, i) => `${i + 1}. ${f.name} — ${f.email}`).join('\n')}\n\nResponda com os números (por exemplo, "1", "1 e 3" ou "1, 2, 3"), nomes ou e-mails desejados, ou "sem convidados". Depois você revisará o evento antes de criar e enviar os convites.`,
      buttons: [{ id: `hub:calendar:none:${token}`, title: 'Sem convidados' }, { id: `hub:calendar:cancel:${token}`, title: 'Cancelar' }] };
    return { text: 'Marque os convidados deste evento. Ao continuar, você receberá uma prévia para confirmar a criação e os convites. Nenhum favorito vem marcado. Para não convidar ninguém, continue sem marcar opções.',
      flow: { token, favorites: favorites.map((f, i) => ({ id: f.id, title: `${i + 1}. ${f.name}`.slice(0, 30), description: f.email })) } };
  }
  async selectGuestNames(sender: string, input: unknown): Promise<Reply> {
    const names = z.array(z.string().trim().min(1).max(254)).max(20).parse(input);
    const draft = await this.choosing(sender);
    const favorites = draft.guests!.favorites;
    const ids = names.map(n => {
      if (!/^\d+$/.test(n)) return resolveFavorite(favorites, n).id;
      const index = Number(n) - 1;
      if (!Number.isSafeInteger(index) || index < 0 || index >= favorites.length) throw new PublicError(`Escolha números de 1 a ${favorites.length}, conforme a lista deste evento, ou envie "sem convidados".`);
      return favorites[index].id;
    });
    return this.selectGuests(sender, draft.guests!.token, [...new Set(ids)]);
  }
  async tryGuestNumbers(sender: string, numbers: string[]): Promise<Reply | null> {
    const pending = await this.oauth.store.pendingCalendarDraft<Draft>(sender);
    if (pending?.data.guests?.stage !== 'choose') return null;
    return this.selectGuestNames(sender, numbers);
  }
  async selectGuests(sender: string, token: string, input: unknown): Promise<Reply> {
    const ids = z.array(z.string().uuid()).max(20).parse(input);
    if (new Set(ids).size !== ids.length) throw new PublicError('Seleção duplicada. Escolha os convidados novamente.');
    const draft = await this.choosing(sender, token); const guests = draft.guests!;
    const selected = ids.map(id => {
      const f = guests.favorites.find(f => f.id === id);
      if (!f) throw new PublicError('Convidado inválido para este pedido. Abra a seleção novamente.');
      return f;
    });
    const nextToken = randomToken();
    const preview = `${draft.preview}\n\nConvidados: ${selected.length ? '\n' + selected.map(f => `• ${f.name} — ${f.email}`).join('\n') : 'nenhum.'}${selected.length ? '\nAo confirmar, o Google criará o evento e enviará os convites para estes e-mails.' : ''}`;
    try {
      await this.oauth.store.replaceCalendarDraft<Draft>(sender, token, nextToken, current => {
        if (current.guests?.stage !== 'choose') throw new Error('Not selecting');
        return { ...current, guests: { ...guests, token: nextToken, stage: 'review' }, preview,
          patch: { ...current.patch, attendees: selected.map(f => ({ email: f.email })) } };
      });
    } catch { throw new PublicError('A seleção expirou ou foi substituída. Faça o pedido novamente.'); }
    return { text: preview, buttons: [{ id: `hub:calendar:confirm:${nextToken}`, title: selected.length ? 'Criar e convidar' : 'Criar evento' }, { id: `hub:calendar:cancel:${nextToken}`, title: 'Cancelar' }] };
  }
  async confirm(sender: string, token: string, approved: boolean): Promise<Reply> {
    const store = this.oauth.store;
    const draft = await store.claimCalendarDraft<Draft>(sender, token, approved, data => {
      if (data.guests?.stage === 'choose') throw new PublicError('Escolha os convidados ou toque em "Sem convidados" antes de confirmar.');
    });
    if (!draft) {
      const previous = await store.calendarDraftResult(sender, token);
      if (previous?.reply) return previous.reply;
      if (previous?.state === 'uncertain' || previous?.state === 'executing') return { text: 'Esta operação já foi iniciada e o resultado ainda precisa ser conferido. Consulte o Google Calendar antes de repetir o pedido.' };
      throw new PublicError('Esta confirmação expirou, foi substituída/cancelada ou pertence a outra conversa. Faça o pedido novamente.');
    }
    if (!approved) return { text: 'Operação no Calendar cancelada. Nenhum evento foi alterado.' };
    let attempted = false;
    try {
      const c = await this.writable(sender);
      if (c.accountId !== draft.accountId || grant(c) !== draft.grant) throw new PublicError('A conexão do Calendar mudou. Faça o pedido novamente com a conta atual.');
      const path = `/calendars/${encodeURIComponent(draft.calendarId)}/events`;
      attempted = true;
      if (draft.operation === 'create') await this.request(c, `${path}?sendUpdates=all`, { method: 'POST', body: JSON.stringify({ ...draft.patch, id: draft.eventId }) });
      else await this.request(c, `${path}/${encodeURIComponent(draft.eventId)}?sendUpdates=all`, {
        method: draft.operation === 'update' ? 'PATCH' : 'DELETE', headers: { 'If-Match': draft.etag! },
        ...(draft.operation === 'update' ? { body: JSON.stringify(draft.patch) } : {})
      });
      const reply = { text: draft.operation === 'create' ? 'Evento criado no Google Calendar.' : draft.operation === 'update' ? 'Evento alterado no Google Calendar.' : 'Evento excluído desta agenda no Google Calendar.' };
      await store.finishCalendarDraft(sender, token, 'done', reply);
      return reply;
    } catch (error) {
      const uncertain = attempted && (!(error instanceof CalendarError) || error.status >= 500 || error.status === 408 || error.status === 409);
      const reply = { text: uncertain ? 'Não foi possível confirmar o resultado no Google. Não vou repetir a operação automaticamente. Consulte sua agenda antes de fazer outro pedido.'
        : error instanceof PublicError ? error.message : 'Não foi possível executar a operação. Faça uma nova consulta à agenda.' };
      await store.finishCalendarDraft(sender, token, uncertain ? 'uncertain' : 'cancelled', reply);
      return reply;
    }
  }
}
