import { z } from 'zod';
import type { Day } from './connectors/day.js';
import type { NotificationStore } from './notification-store.js';
import { digest } from './security.js';
import { PublicError, type Reply } from './types.js';

export const reminderChoices = z.object({
  purpose: z.enum(['list', 'delete']),
  search: z.string().trim().min(1).max(100).nullable(),
}).strict();
export type ReminderReference = { account: string; revision: number };
type Selection = {
  type: 'reminder_selection';
  account: string;
  purpose: 'list' | 'delete';
  items: { id: string; revision: number }[];
};
const clean = (value: string, max: number) => {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
};
const reopen = 'Envie “remover lembrete” para abrir uma nova lista numerada.';
const numberChoice = /^(?:(excluir|remover|apagar|deletar) (?:o )?(?:lembrete )?)?(?:numero |nº |#)?(\d+)$/;

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
    private prepareDelete: (sender: string, id: string, reference: ReminderReference) => Promise<Reply>,
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
      text: `${purpose === 'delete' ? 'Qual lembrete deseja excluir?' : 'Seus lembretes no Day'}\n\n${items.map((r, i) =>
        `${i + 1}. ${clean(r.title, 170)}\n${r.enabled ? 'Ativo' : 'Pausado'} · ${frequency(r.schedule)}`).join('\n\n')}\n\n${purpose === 'delete'
        ? 'Responda somente com o número. Vou mostrar o lembrete para você confirmar a exclusão.'
        : 'Para excluir, envie “excluir 2”, usando o número desejado.'}\nA numeração vale por 10 minutos, até uma nova lista ou outro assunto.${result.truncated ? '\nHá mais lembretes. Para localizar outro, peça “remover lembrete contendo…” e um trecho do texto.' : ''}`,
      buttons: [{ id: `hub:notify:cancel:${token}`, title: 'Cancelar' }],
    };
  }

  async command(sender: string, command: string, button?: string, originalText = command): Promise<Reply | null> {
    if (!button && /^(?:(?:listar|ver|mostrar) (?:os |meus )?)?(?:meus )?lembretes(?: do day)?$/.test(command))
      return this.listing(sender, { purpose: 'list', search: null });
    if (!button && /^(?:(?:como (?:eu )?(?:(?:faco|posso) (?:para )?)?)|(?:quero |gostaria de ))?(?:remover|excluir|apagar|deletar)(?: (?:um|o|meu))? lembretes?(?: do day)?$/.test(command))
      return this.listing(sender, { purpose: 'delete', search: null });
    const search = !button && /^(?:remover|excluir|apagar|deletar) lembrete contendo (.+)$/i.exec(originalText.trim().replace(/[.!?]+$/, ''));
    if (search) return this.listing(sender, { purpose: 'delete', search: search[1] });

    const choice = !button ? numberChoice.exec(command) : null;
    const pending = await this.db.pending<Selection>(sender, true);
    if (pending?.data.type !== 'reminder_selection')
      return choice?.[1] ? { text: reopen } : null;
    const cancel = /^hub:notify:cancel:([A-Za-z0-9_-]{43})$/.exec(button || '');
    if ((!button && command === 'cancelar') || (cancel && digest(cancel[1]) === pending.hash)) {
      await this.db.cancelPending(sender, pending.hash, true);
      return { text: 'Seleção cancelada. Nenhum lembrete foi excluído.' };
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
      return { text: `Para excluir o lembrete ${index + 1}, envie “excluir ${index + 1}”. Você ainda verá a confirmação antes de apagar.` };
    if (!await this.db.cancelPending(sender, pending.hash)) return { text: `Esta lista foi substituída. ${reopen}` };
    return this.prepareDelete(sender, selected.id, { account: pending.data.account, revision: selected.revision });
  }
}
