import type { Cash, CashStatus, Workspace } from './connectors/cash.js';
import { PublicError, type Reply } from './types.js';

export const normalizeWorkspace = (text: string) => text.trim().toLocaleLowerCase('pt-BR')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[.!?]+$/, '');
const label = (w: Workspace) => `${w.name}${w.personal ? ' (pessoal)' : ''}`;
export const workspaceScope = (w: Workspace | null | undefined) => w ? `cash:${w.reference}` : '';
export function resolveWorkspace(status: CashStatus, target: string) {
  const normalized = normalizeWorkspace(target).replace(/^(?:o |a |workspace |empresa )+/, '');
  const exact = status.workspaces.filter(w => normalizeWorkspace(w.name) === normalizeWorkspace(target) || normalizeWorkspace(w.name) === normalized);
  const matches = exact.length ? exact : ['pessoal', 'casa', 'meu pessoal', 'minha casa'].includes(normalized)
    ? status.workspaces.filter(w => w.personal) : status.workspaces.filter(w => String(w.id) === normalized);
  if (matches.length !== 1) throw new PublicError(matches.length
    ? 'Há mais de um workspace com esse nome. Envie “workspaces” e escolha na lista.'
    : 'Não encontrei esse workspace entre seus acessos autorizados. Envie “workspaces” para escolher.');
  return matches[0];
}

export function workspaceMenu(status: CashStatus, page = 0): Reply {
  const items = status.workspaces.slice(page * 9, page * 9 + 9);
  if (!items.length) return { text: 'Nenhum workspace disponível nesta página. Envie “workspaces”. Se ainda não conectou, envie “conectar Cash”. O acesso depende das permissões do usuário e da habilitação do WhatsApp na empresa.' };
  const rows = items.map(w => ({ id: `hub:workspace:select:${w.id}`, title: `${w.id}. ${label(w)}`.slice(0, 24),
    description: `${w.id === status.workspace?.id ? 'Atual · ' : ''}${label(w)} · ${w.cash ? 'Cash' : 'Sem Cash'}${w.bizz ? ' · Bizz (consultas ainda não integradas)' : ''}`.slice(0, 72) }));
  if (status.workspaces.length > (page + 1) * 9) rows.push({ id: `hub:workspace:page:${page + 1}`, title: 'Mais workspaces', description: 'Abrir a próxima página' });
  return { text: `Workspace atual: ${status.workspace ? label(status.workspace) : 'nenhum com acesso válido'}.\n\nEscolha o workspace para as próximas consultas e lançamentos do Cash. Também pode enviar “usar Nome do workspace” ou “voltar para o pessoal”.\nDay e Calendar continuam usando suas próprias contas conectadas.`,
    list: { button: 'Escolher workspace', rows } };
}

export async function workspaceCommand(cash: Cash, sender: string, command: string, button?: string, knownStatus?: CashStatus): Promise<Reply | null> {
  const page = /^hub:workspace:page:(\d+)$/.exec(button || '');
  const selection = /^hub:workspace:select:([1-9]\d*)$/.exec(button || '');
  const select = /^(?:usar|selecionar|alternar para|trocar para|mudar para|voltar para|voltar ao) (.+)$/.exec(command);
  const listing = ['workspaces', 'meus workspaces', 'empresas', 'minhas empresas', 'trocar workspace', 'trocar empresa', 'selecionar workspace'].includes(command);
  const current = ['workspace atual', 'contexto atual', 'empresa atual', 'qual workspace', 'qual empresa'].includes(command);
  if (!page && !selection && !select && !listing && !current) return null;
  const status = knownStatus ?? await cash.status(sender);
  if (page || listing) return workspaceMenu(status, page ? Number(page[1]) : 0);
  if (current) return { text: `Workspace atual: ${status.workspace ? label(status.workspace) : 'nenhum com acesso válido'}. Envie “workspaces” para escolher. Day e Calendar mantêm suas contas conectadas.` };
  const w = selection ? status.workspaces.find(w => w.id === Number(selection[1])) : resolveWorkspace(status, select![1]);
  if (!w) throw new PublicError('Este workspace não está mais disponível. Envie “workspaces” para atualizar a lista.');
  const chosen = await cash.selectWorkspace(sender, w.id);
  return { text: `Workspace selecionado: ${label(chosen)}.\n${chosen.cash ? 'As próximas consultas e lançamentos do Cash usarão esse workspace.' : 'O Cash não está autorizado neste workspace. As consultas do Bizz ainda não estão integradas ao Hub.'}\nRascunhos e resumos diários já configurados permanecem no workspace de origem. Day e Calendar mantêm suas contas conectadas.` };
}
