import { z } from 'zod';
import type { Day } from './connectors/day.js';
import type { NotificationStore } from './notification-store.js';
import { digest } from './security.js';
import { PublicError, type Reply } from './types.js';

export const reminderChoices = z.object({
  purpose: z.enum(['list', 'delete', 'pause', 'update']),
  search: z.string().trim().min(1).max(100).nullable(),
}).strict();
export type ReminderReference = { account: string; revision: number };
export type ReminderSelectionAction = 'delete' | 'pause' | 'update';
type Selection = {
  type: 'reminder_selection';
  account: string;
  purpose: 'list' | ReminderSelectionAction;
  items: { id: string; revision: number }[];
};
type EditSelection = ReminderReference & { type: 'reminder_edit'; id: string };
const clean = (value: string, max: number) => {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
};
const reopen = 'Envie “meus lembretes” para abrir uma nova lista numerada.';
const verbs = 'excluir|remover|apagar|deletar|pausar|editar|alterar';
const action = (verb: string): ReminderSelectionAction => verb === 'pausar' ? 'pause' : ['editar', 'alterar'].includes(verb) ? 'update' : 'delete';
const labels = { delete: 'excluir', pause: 'pausar', update: 'editar' } as const;
const numberChoice = new RegExp(`^(?:(${verbs}) (?:o )?(?:lembrete )?)?(?:numero |nº |#)?(\\d+)$`);
const openChoices = new RegExp(`^(?:(?:como (?:eu )?(?:(?:faco|posso) (?:para )?)?)|(?:quero |gostaria de ))?(${verbs})(?: (?:um|o|meu))? lembretes?(?: do day)?$`);
const searchChoices = new RegExp(`^(${verbs}) lembrete contendo (.+)$`, 'i');

function frequency(schedule: any): string {
  if (!schedule) return '';
  const days = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  const rule = schedule.kind === 'daily' ? 'Diariamente'
    : schedule.kind === 'weekly' ? (schedule.weekDays ?? []).map((d: number) => days[d]).join(', ')
    : schedule.kind === 'monthly' ? `Dia ${schedule.monthDay}`
    : `A cada ${schedule.intervalMinutes} min`;
  return clean(`${rule}${schedule.times?.length ? ` às ${schedule.times.join(', ')}` : ''}`, 120);
}

/** Numbers belong to a short-lived snapshot, never to the current sort order. */
export class ReminderSelection {
  constructor(
    private db: NotificationStore,
    private day: Day,
    private prepare: (sender: string, action: 'delete' | 'pause', id: string, reference: ReminderReference) => Promise<Reply>,
  ) {}

  private async account(sender: string) {
    const c = await this.db.store.connection(sender, 'day');
    if (!c) throw new PublicError('Envie “conectar Day” para consultar seus lembretes.');
    return JSON.stringify([c.accountId, c.grantId]);
  }

  async listing(sender: string, input: unknown): Promise<Reply> {
    const { purpose, search } = reminderChoices.parse(input);
    const account = await this.account(sender);
    const result = await this.day.reminders(sender, undefined, { search, limit: 10 });
    if (await this.account(sender) !== account)
      throw new PublicError(`A conta do Day mudou. ${reopen}`);
    const items = result.items.filter(r => !r.deleted);
    // An empty replacement must also invalidate the previous numbering.
    const token = await this.db.draft(sender, {
      type: 'reminder_selection', account, purpose,
      items: items.map(r => ({ id: r.id, revision: r.revision })),
    } satisfies Selection);
    if (!items.length) {
      await this.db.cancelPending(sender, digest(token));
      return { text: search ? 'Não encontrei lembretes com esse trecho no Day.' : 'Você não tem lembretes salvos no Day.' };
    }
    return {
      text: `${purpose !== 'list' ? `Qual lembrete deseja ${labels[purpose]}?` : 'Seus lembretes no Day'}\n\n${items.map((r, i) =>
        `${i + 1}. ${clean(r.title, 170)}\n${r.enabled ? 'Ativo' : 'Pausado'} · ${frequency(r.schedule)}`).join('\n\n')}\n\n${purpose === 'update'
        ? 'Responda somente com o número. Depois, diga o que deseja alterar.'
        : purpose !== 'list' ? `Responda somente com o número. Vou mostrar o lembrete para você confirmar ${purpose === 'delete' ? 'a exclusão' : 'a pausa'}.`
        : 'Envie “editar 2”, “pausar 2” ou “excluir 2”, usando o número desejado.'}\nA numeração vale por 10 minutos, até uma nova lista ou outro assunto.${result.truncated ? `\nHá mais lembretes. Para localizar outro, peça “${purpose === 'list' ? 'editar' : labels[purpose]} lembrete contendo…” e um trecho do texto.` : ''}`,
      buttons: [{ id: `hub:notify:cancel:${token}`, title: 'Cancelar' }],
    };
  }

  private async current(sender: string, selected: EditSelection) {
    if (await this.account(sender) !== selected.account)
      throw new PublicError(`A conta do Day mudou. ${reopen}`);
    const reminder = (await this.day.reminders(sender, selected.id)).items[0];
    if (!reminder || reminder.deleted) throw new PublicError(`Lembrete não encontrado. ${reopen}`);
    if (reminder.revision !== selected.revision)
      throw new PublicError(`O lembrete mudou desde a seleção. ${reopen}`);
    return reminder;
  }

  private async beginEdit(sender: string, id: string, reference: ReminderReference): Promise<Reply> {
    const selected: EditSelection = { type: 'reminder_edit', id, ...reference };
    const reminder = await this.current(sender, selected);
    const token = await this.db.draft(sender, selected);
    return { text: `Editar lembrete\n${reminder.title}\n${frequency(reminder.schedule)}\n\nO que deseja alterar? Por exemplo: “mude o horário para 21h” ou “troque o texto para levar o livro”. Vou preservar os demais campos e mostrar a revisão antes de salvar.\nEsta seleção vale por 10 minutos. Para desistir, envie “cancelar”.`,
      buttons: [{id:`hub:notify:cancel:${token}`,title:'Cancelar'}] };
  }

  async isEditing(sender: string) {
    return (await this.db.pending<EditSelection>(sender, true))?.data.type === 'reminder_edit';
  }

  async editContext(sender: string) {
    const pending = await this.db.pending<EditSelection>(sender, true);
    if (pending?.data.type !== 'reminder_edit') return null;
    if (pending.expires <= Date.now()) {
      await this.db.cancelPending(sender, pending.hash, true);
      throw new PublicError(`Esta seleção para editar expirou. ${reopen}`);
    }
    try { return { ...pending.data, reminder: await this.current(sender, pending.data) }; }
    catch (error) {
      await this.db.cancelPending(sender, pending.hash, true);
      throw error;
    }
  }

  async cancelEdit(sender: string) {
    const pending = await this.db.pending<EditSelection>(sender, true);
    if (pending?.data.type === 'reminder_edit') await this.db.cancelPending(sender, pending.hash, true);
  }

  async command(sender: string, command: string, button?: string, originalText = command): Promise<Reply | null> {
    // This existing plural command pauses the WhatsApp subscription, not a Day item.
    if (!button && /^pausar (?:os )?lembretes do day$/.test(command)) return null;
    if (!button && /^(?:(?:listar|ver|mostrar) (?:os |meus )?)?(?:meus )?lembretes(?: do day)?$/.test(command))
      return this.listing(sender, { purpose: 'list', search: null });
    const opening = !button && openChoices.exec(command);
    if (opening) return this.listing(sender, { purpose: action(opening[1]), search: null });
    const search = !button && searchChoices.exec(originalText.trim().replace(/[.!?]+$/, ''));
    if (search) return this.listing(sender, { purpose: action(search[1].toLowerCase()), search: search[2] });

    const choice = !button ? numberChoice.exec(command) : null;
    const pending = await this.db.pending<Selection | EditSelection>(sender, true);
    if (!pending || !['reminder_selection', 'reminder_edit'].includes(pending.data.type))
      return choice?.[1] ? { text: reopen } : null;
    const cancel = /^hub:notify:cancel:([A-Za-z0-9_-]{43})$/.exec(button || '');
    if ((!button && command === 'cancelar') || (cancel && digest(cancel[1]) === pending.hash)) {
      await this.db.cancelPending(sender, pending.hash, true);
      return { text: 'Seleção cancelada. Nenhum lembrete foi alterado.' };
    }
    if (pending.data.type === 'reminder_edit') {
      const notificationNavigation = /^(?:minhas (?:assinaturas|notificacoes)|status das notificacoes|notificacoes|avisos|quais (?:sao as )?notificacoes (?:posso receber|estao disponiveis|disponiveis)|listar notificacoes|silencio|(?:meu )?periodo de silencio)$/.test(command);
      if (button || !command || choice?.[1] || notificationNavigation) await this.db.cancelPending(sender, pending.hash, true);
      return choice?.[1] ? {text:reopen} : null;
    }
    if (!choice) {
      if (!button && /^-?\d+(?:[.,;\s]+(?:e\s+)?\d+)*$/.test(command))
        return { text: 'Escolha um único número inteiro da lista, ou envie “cancelar”.' };
      // Do not let a stale reminder list capture a later Calendar/other choice.
      await this.db.cancelPending(sender, pending.hash, true);
      return null;
    }
    if (pending.expires <= Date.now()) return { text: `Esta lista expirou. ${reopen}` };
    const index = Number(choice[2]) - 1;
    const selected = Number.isSafeInteger(index) && index >= 0 ? pending.data.items[index] : undefined;
    if (!selected) return { text: `Escolha um único número de 1 a ${pending.data.items.length}, ou envie “cancelar”.` };
    if (pending.data.purpose === 'list' && !choice[1])
      return { text: `Para o lembrete ${index + 1}, envie “editar ${index + 1}”, “pausar ${index + 1}” ou “excluir ${index + 1}”. Você verá a revisão antes de salvar.` };
    if (!await this.db.cancelPending(sender, pending.hash)) return { text: `Esta lista foi substituída. ${reopen}` };
    const operation = choice[1] ? action(choice[1]) : pending.data.purpose;
    const reference = { account: pending.data.account, revision: selected.revision };
    if (operation === 'update') return this.beginEdit(sender, selected.id, reference);
    if (operation === 'list') return {text:reopen};
    return this.prepare(sender, operation, selected.id, reference);
  }
}
