import type { Cash, CashStatus, Workspace } from './connectors/cash.js';
import { PublicError, type Reply } from './types.js';

export const normalizeWorkspace = (text: string) => text.trim().toLocaleLowerCase('pt-BR')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[.!?]+$/, '');
const label = (w: Workspace) => `${w.name}${w.personal ? ' (pessoal)' : ''}`;
export const workspaceScope = (w: Workspace | null | undefined) => w ? `cash:${w.reference}` : '';
export function resolveWorkspace(status: CashStatus, target: string) {
  let normalized = normalizeWorkspace(target);
  let exact = status.workspaces.filter(w => normalizeWorkspace(w.name) === normalized);
  while (!exact.length) {
    const stripped = normalized.replace(/^(?:o |a |area de trabalho |area |workspace |empresa )/, '');
    if (stripped === normalized) break;
    normalized = stripped;
    exact = status.workspaces.filter(w => normalizeWorkspace(w.name) === normalized);
  }
  const matches = exact.length ? exact : ['pessoal', 'casa', 'meu pessoal', 'minha casa'].includes(normalized)
    ? status.workspaces.filter(w => w.personal) : status.workspaces.filter(w => String(w.id) === normalized);
  if (matches.length !== 1) throw new PublicError(matches.length
    ? 'Há mais de uma área de trabalho com esse nome. Envie “minhas áreas” e escolha na lista.'
    : 'Não encontrei essa área de trabalho entre seus acessos autorizados. Envie “minhas áreas” para escolher.');
  return matches[0];
}

export function workspaceMenu(status: CashStatus, page = 0): Reply {
  const items = status.workspaces.slice(page * 9, page * 9 + 9);
  if (!items.length) return { text: 'Nenhuma área de trabalho disponível nesta página. Envie “minhas áreas”. Se ainda não conectou, envie “conectar Cash”. O acesso depende das permissões do usuário e da habilitação do WhatsApp na empresa.' };
  const rows = items.map(w => ({ id: `hub:workspace:select:${w.id}`, title: `${w.id}. ${label(w)}`.slice(0, 24),
    description: `${w.id === status.workspace?.id ? 'Atual · ' : ''}${label(w)} · ${w.cash ? 'Cash' : 'Sem Cash'}${w.bizz ? ' · Bizz (consultas ainda não integradas)' : ''}`.slice(0, 72) }));
  if (status.workspaces.length > (page + 1) * 9) rows.push({ id: `hub:workspace:page:${page + 1}`, title: 'Mais áreas', description: 'Abrir a próxima página' });
  return { text: `Área atual: ${status.workspace ? label(status.workspace) : 'nenhuma com acesso válido'}.\n\nEscolha a área de trabalho para as próximas consultas e lançamentos do Cash. Também pode enviar “usar Nome da área” ou “voltar para o pessoal”.\nDay e Calendar continuam usando suas próprias contas conectadas.`,
    list: { button: 'Escolher área', rows } };
}

export async function workspaceCommand(cash: Cash, sender: string, command: string, button?: string, knownStatus?: CashStatus): Promise<Reply | null> {
  command = normalizeWorkspace(command);
  const page = /^hub:workspace:page:(\d+)$/.exec(button || '');
  const selection = /^hub:workspace:select:([1-9]\d*)$/.exec(button || '');
  const select = /^(?:usar|selecionar|alternar para|trocar para|mudar para|voltar para|voltar ao) (.+)$/.exec(command);
  const listing = ['area', 'areas', 'area de trabalho', 'areas de trabalho', 'minhas areas', 'minhas areas de trabalho',
    'trocar area', 'trocar area de trabalho', 'selecionar area', 'selecionar area de trabalho',
    'workspace', 'workspaces', 'meus workspaces', 'empresas', 'minhas empresas', 'trocar workspace', 'trocar empresa', 'selecionar workspace'].includes(command);
  const current = ['area atual', 'area de trabalho atual', 'qual area', 'qual area de trabalho',
    'workspace atual', 'contexto atual', 'empresa atual', 'qual workspace', 'qual empresa'].includes(command);
  if (!page && !selection && !select && !listing && !current) return null;
  const status = knownStatus ?? await cash.status(sender);
  if (page || listing) return workspaceMenu(status, page ? Number(page[1]) : 0);
  if (current) return { text: `Área atual: ${status.workspace ? label(status.workspace) : 'nenhuma com acesso válido'}. Envie “minhas áreas” para escolher. Day e Calendar mantêm suas contas conectadas.` };
  const w = selection ? status.workspaces.find(w => w.id === Number(selection[1])) : resolveWorkspace(status, select![1]);
  if (!w) throw new PublicError('Esta área de trabalho não está mais disponível. Envie “minhas áreas” para atualizar a lista.');
  const chosen = await cash.selectWorkspace(sender, w.id);
  return { text: `Área de trabalho alterada para ${label(chosen)}.\n${chosen.cash ? 'As próximas consultas e lançamentos do Cash serão feitos nessa área.' : 'O Cash não está autorizado nessa área de trabalho. As consultas do Bizz ainda não estão integradas ao Hub.'}\nRascunhos e resumos diários já configurados permanecem na área de origem. Day e Calendar mantêm suas contas conectadas.` };
}
