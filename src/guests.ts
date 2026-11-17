import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction } from './database.js';
import { digest, randomToken } from './security.js';
import { Store } from './store.js';
import { PublicError, type Reply } from './types.js';

export type AutomaticAgenda = { accountId: string; calendarId: string; label: string; accountLabel: string };
export type Favorite = { id: string; name: string; email: string; automatic?: AutomaticAgenda[] };
export function isAutomatic(f: Favorite, accountId: string, calendarId: string) {
  return f.automatic?.some(a => a.accountId === accountId && a.calendarId === calendarId) ?? false;
}
type Collection = { revision: number; items: Favorite[] };
type Change = { revision: number; items: Favorite[] };
const name = z.string().trim().min(1).max(60).regex(/^[^\p{Cc}]+$/u);
const email = z.string().trim().toLowerCase().email().max(254);
export const favoriteChange = z.object({ operation: z.enum(['add', 'update', 'remove']),
  target: z.string().trim().min(1).max(254).nullable(), name: name.nullable(), email: email.nullable(),
  automatic: z.boolean().nullable().default(null), calendarId: z.string().min(1).max(512).nullable().default(null) }).strict();
const normalize = (s: string) => s.trim().toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
export function resolveFavorite(items: Favorite[], target: string) {
  const found = items.filter(f => normalize(f.name) === normalize(target) || f.email === target.trim().toLowerCase());
  if (found.length !== 1) throw new PublicError(found.length ? 'Há mais de um favorito com esse nome. Informe o e-mail para identificar qual.' : `Não encontrei o favorito "${target}". Envie "meus convidados" para consultar.`);
  return found[0];
}

// Accept only standalone choices; dates, amounts and sentences stay in normal routing.
export function guestNumberChoices(text: string): string[] | null {
  const value = text.trim();
  if (!/^\d+(?:(?:\s*[,;]\s*|\s+e\s+|\s+)\d+)*$/i.test(value)) return null;
  return value.match(/\d+/g)!;
}

export class Guests {
  constructor(private store: Store) {}
  async list(sender: string): Promise<Collection> {
    const { rows } = await this.store.db.query('SELECT revision,data FROM guest_favorites WHERE sender=$1', [sender]);
    return rows[0] ? { revision: rows[0].revision, items: this.store.vault.open<Favorite[]>(rows[0].data, `guests:${sender}`) } : { revision: 0, items: [] };
  }
  async listing(sender: string): Promise<Reply> {
    const { items } = await this.list(sender);
    return { text: `Convidados favoritos do Hub${items.length ? '\n' + items.map((f, i) => `${i + 1}. ${f.name} — ${f.email}${f.automatic?.length ? '\n   Automático em: ' + f.automatic.map(a => `${a.label} (${a.accountLabel})`).join('; ') : '\n   Convite manual'}`).join('\n') : '\nVocê ainda não tem favoritos.'}\n\nPara cadastrar: "Salve Ana, ana@example.com, como convidada favorita". Para convidar automaticamente: "Sempre convide Ana na minha agenda principal". Para parar, mantendo o favorito: "Pare de convidar Ana automaticamente na agenda principal". Você também pode pedir para alterar ou remover um favorito. Até 20 favoritos; nenhum convite é enviado ao cadastrar.` };
  }
  async prepare(sender: string, input: unknown, agenda?: AutomaticAgenda): Promise<Reply> {
    const q = favoriteChange.parse(input); const current = await this.list(sender);
    if (q.automatic !== null && (!agenda || q.operation === 'remove')) throw new PublicError('Conecte o Calendar e identifique a agenda para configurar os convites automáticos.');
    if (q.calendarId !== null && q.automatic === null) throw new PublicError('Informe se deseja ativar ou desativar o convite automático nessa agenda.');
    const items = [...current.items]; let selected: Favorite;
    if (q.operation === 'add') {
      if (q.target !== null || !q.name || !q.email) throw new PublicError('Informe nome e e-mail do novo favorito.');
      if (items.length >= 20) throw new PublicError('Você já tem 20 favoritos. Remova um antes de cadastrar outro.');
      selected = { id: randomUUID(), name: q.name, email: q.email }; items.push(selected);
    } else {
      if (!q.target) throw new PublicError('Informe o nome ou e-mail do favorito.');
      const old = resolveFavorite(items, q.target); const index = items.indexOf(old);
      if (q.operation === 'remove') {
        if (q.name !== null || q.email !== null) throw new PublicError('Para remover, informe somente o favorito.');
        selected = old; items.splice(index, 1);
      } else {
        if (!q.name && !q.email && q.automatic === null) throw new PublicError('Informe o novo nome, e-mail ou a preferência de convite automático.');
        selected = { ...old, name: q.name ?? old.name, email: q.email ?? old.email }; items[index] = selected;
      }
    }
    if (q.automatic !== null) {
      const automatic = (selected.automatic || []).filter(a => a.accountId !== agenda!.accountId || a.calendarId !== agenda!.calendarId);
      if (q.automatic) automatic.push(agenda!);
      if (automatic.length > 100) throw new PublicError('Limite de agendas automáticas atingido para este favorito.');
      selected = { ...selected, automatic };
      items[items.findIndex(f => f.id === selected.id)] = selected;
    }
    if (new Set(items.map(f => f.email)).size !== items.length) throw new PublicError('Este e-mail já está nos seus favoritos.');
    const token = randomToken(); const hash = digest(token);
    await transaction(this.store.db, async tx => {
      // The per-sender row serializes both first use and concurrent confirmations.
      await tx.query('INSERT INTO guest_favorites(sender,revision,data) VALUES($1,0,$2) ON CONFLICT DO NOTHING', [sender, this.store.vault.seal([], `guests:${sender}`)]);
      const { rows } = await tx.query('SELECT revision FROM guest_favorites WHERE sender=$1 FOR UPDATE', [sender]);
      if (rows[0].revision !== current.revision) throw new PublicError('Seus favoritos mudaram. Consulte novamente e refaça o pedido.');
      await tx.query("UPDATE guest_favorite_drafts SET state='cancelled' WHERE sender=$1 AND state='pending'", [sender]);
      await tx.query('INSERT INTO guest_favorite_drafts(hash,sender,data,expires) VALUES($1,$2,$3,$4)',
        [hash, sender, this.store.vault.seal({ revision: current.revision, items } satisfies Change, `guest-draft:${hash}:${sender}`), Date.now() + 600_000]);
    });
    return { text: `${q.operation === 'add' ? 'Adicionar' : q.operation === 'update' ? 'Alterar' : 'Remover'} favorito do Hub\n${selected.name} — ${selected.email}${q.automatic === null ? '' : `\nConvite automático: ${q.automatic ? 'ativar' : 'desativar'}\nAgenda: ${agenda!.label}\nConta Google: ${agenda!.accountLabel}`}\n\nIsso não altera eventos existentes nem envia convites. Confirme em até 10 minutos.`,
      buttons: [{ id: `hub:favorite:confirm:${token}`, title: 'Confirmar' }, { id: `hub:favorite:cancel:${token}`, title: 'Cancelar' }] };
  }
  async confirm(sender: string, token: string, approved: boolean): Promise<Reply> {
    return transaction(this.store.db, async tx => {
      const { rows: favorites } = await tx.query('SELECT revision FROM guest_favorites WHERE sender=$1 FOR UPDATE', [sender]);
      const hash = digest(token);
      const { rows } = await tx.query("SELECT data FROM guest_favorite_drafts WHERE hash=$1 AND sender=$2 AND state='pending' AND expires>$3 FOR UPDATE", [hash, sender, Date.now()]);
      if (!rows[0]) throw new PublicError('Esta confirmação expirou ou já foi usada/substituída. Consulte seus favoritos.');
      const change = this.store.vault.open<Change>(rows[0].data, `guest-draft:${hash}:${sender}`);
      if (approved && favorites[0]?.revision !== change.revision) throw new PublicError('Seus favoritos mudaram. Faça o pedido novamente.');
      if (approved) await tx.query('UPDATE guest_favorites SET revision=revision+1,data=$2 WHERE sender=$1', [sender, this.store.vault.seal(change.items, `guests:${sender}`)]);
      await tx.query('UPDATE guest_favorite_drafts SET state=$1 WHERE hash=$2', [approved ? 'done' : 'cancelled', hash]);
      return { text: approved ? 'Favoritos do Hub atualizados. Nenhum evento foi alterado ou convite enviado.' : 'Alteração dos favoritos cancelada.' };
    });
  }
}
