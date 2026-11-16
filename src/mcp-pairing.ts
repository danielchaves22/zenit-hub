import { createHmac } from 'node:crypto';
import type { Cash, Workspace } from './connectors/cash.js';
import type { McpGrants } from './mcp-grants.js';
import { equal } from './security.js';
import type { Store } from './store.js';
import { PublicError, type Incoming, type Reply } from './types.js';
import { resolveWorkspace } from './workspaces.js';

type PairingGrants = Pick<McpGrants, 'previewRequest' | 'approveRequest' | 'revokeSender'>;
const usage = 'Copie o comando mostrado pelo Hub no navegador. Para escolher outra área sem mudar o WhatsApp, acrescente o nome dela ao final do comando.';
const unavailable = 'A solicitação expirou ou já foi utilizada. Inicie uma nova conexão no seu cliente MCP.';
const invalidArea = 'Não foi possível confirmar o acesso a essa área do Cash. Confira suas áreas e inicie a conexão novamente.';
const confirmationPrefix = 'hub:mcp:approve:';

// Bind the preview to its sender and Cash binding; a button from before a rebind cannot approve it.
function confirmation(key: string, sender: string, code: string, workspace: Workspace) {
  return createHmac('sha256', Buffer.from(key, 'base64'))
    .update(JSON.stringify(['mcp-cash-pair-v1', sender, code, workspace.id, workspace.reference]))
    .digest('base64url');
}

export async function mcpPairingReply(message: Incoming, key: string, grants: PairingGrants,
  store: Pick<Store, 'cashDisabled'>, cash: Pick<Cash, 'status'>): Promise<Reply | null> {
  if (message.audio || message.flowReply) return null;
  const text = message.text.trim();
  if (!message.button && /^desconectar mcp$/i.test(text)) {
    await grants.revokeSender(message.sender);
    return { text: 'Os acessos MCP autorizados por você foram revogados. A conexão do Cash pelo WhatsApp continua disponível conforme suas permissões.' };
  }
  const isButton = message.button?.startsWith(confirmationPrefix);
  if (message.button ? !isButton : !/^conectar mcp(?:\s|$)/i.test(text)) return null;
  if (await store.cashDisabled(message.sender)) return { text: 'Conecte o Cash no Hub antes de autorizar uma consulta pelo MCP.' };

  if (isButton) {
    const match = /^hub:mcp:approve:([0-9A-F]{16}):(\d+):([\w-]{43})$/.exec(message.button!);
    if (!match) return { text: unavailable };
    const [, code, id, signature] = match;
    const status = await cash.status(message.sender);
    const workspace = status.workspaces.find(w => w.cash === true && w.id === Number(id));
    if (!workspace || !equal(confirmation(key, message.sender, code, workspace), signature)) return { text: invalidArea };
    const approved = await grants.approveRequest(code, {
      sender: message.sender, workspaceId: workspace.id, workspaceReference: workspace.reference,
    });
    return { text: approved ? `Leitura autorizada para Cash · ${workspace.name}. Volte ao navegador para concluir.` : unavailable };
  }

  const command = /^conectar mcp\s+([a-f0-9]{16})(?:\s+(.{1,200}))?$/i.exec(text);
  if (!command) return { text: usage };
  const code = command[1].toUpperCase();
  const request = await grants.previewRequest(code);
  if (!request) return { text: unavailable };
  const status = await cash.status(message.sender);
  let workspace = status.workspace;
  if (command[2]) {
    try { workspace = resolveWorkspace(status, command[2]); }
    catch (error) { if (error instanceof PublicError) return { text: error.message }; throw error; }
  }
  if (!workspace || !status.workspaces.some(w => w.id === workspace.id && w.reference === workspace.reference && w.cash === true)) {
    return { text: `${invalidArea} ${usage}` };
  }
  const clientName = request.clientName.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 90);
  const origin = new URL(request.redirectUri).origin;
  return {
    text: `Autorizar ${clientName} a consultar Cash · ${workspace.name}?\nDestino do cliente: ${origin}\nEle poderá ler saldos, obrigações e despesas desta área. Confirme apenas se você iniciou esta conexão. Para revogar depois, envie “desconectar MCP”.`,
    buttons: [{ id: `${confirmationPrefix}${code}:${workspace.id}:${confirmation(key, message.sender, code, workspace)}`, title: 'Autorizar leitura' }],
  };
}
