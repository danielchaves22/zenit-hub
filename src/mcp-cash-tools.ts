import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { workspaceSchema, type Cash } from './connectors/cash.js';
import { HttpError } from './http.js';
import type { Store } from './store.js';
import type { CashGrant } from './mcp-grants.js';

interface CashReadServices {
  cash: Pick<Cash, 'status' | 'query'>;
  store: Pick<Store, 'cashDisabled'>;
}

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
const financialDate = z.string().date().describe('Data de calendário no formato YYYY-MM-DD.');
const dueInput = z.object({
  window: z.enum(['TODAY', 'THIS_WEEK', 'NEXT_7_DAYS', 'REST_OF_MONTH', 'CUSTOM']),
  startDate: financialDate.nullish().describe('Início inclusivo para CUSTOM.'),
  endDate: financialDate.nullish().describe('Fim inclusivo para CUSTOM.'),
  limit: z.number().int().min(1).max(20).default(10)
}).strict();
const expensesInput = z.object({
  startDate: financialDate,
  endDate: financialDate,
  category: z.string().trim().min(1).max(160).nullish().describe('Nome ou caminho da categoria. Inclui subcategorias.'),
  fixedExpenses: z.enum(['ALL', 'ONLY_FIXED', 'EXCLUDE_FIXED']).default('ALL'),
  groupByCategory: z.boolean().default(false),
  mode: z.enum(['SUMMARY', 'LIST']).default('SUMMARY'),
  page: z.number().int().min(1).max(10_000).default(1),
  limit: z.number().int().min(1).max(20).default(10)
}).strict();

const cashResponse = z.object({
  workspace: workspaceSchema,
  data: z.object({ ok: z.boolean() }).passthrough()
});

type ReadOperation = 'get_financial_overview' | 'get_due_obligations' | 'get_realized_expenses';

function toolError(code: string, message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }], structuredContent: { code, message } };
}

function accessDenied() {
  return toolError('cash_access_denied', 'O vínculo ou a permissão de leitura desta área do Cash não está disponível.');
}

function monthNumber(date: string) {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7));
}

export function registerCashTools(server: McpServer, { cash, store }: CashReadServices, grant: CashGrant) {
  async function query(tool: ReadOperation, args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      if (await store.cashDisabled(grant.sender)) return accessDenied();

      // "connected" reports the current WhatsApp workspace, which may differ from this grant.
      const status = await cash.status(grant.sender);
      const allowed = status.workspaces.some(workspace => workspace.cash === true &&
        workspace.id === grant.workspaceId && workspace.reference === grant.workspaceReference);
      if (!allowed) return accessDenied();

      const result = cashResponse.parse(await cash.query(grant.sender, tool, args, grant.workspaceId));
      if (result.workspace.id !== grant.workspaceId || result.workspace.reference !== grant.workspaceReference) {
        return accessDenied();
      }

      const { id, name } = result.workspace;
      const value = { source: 'Cash', workspace: { id, name }, data: result.data };
      return {
        isError: !result.data.ok,
        structuredContent: value,
        content: [{ type: 'text', text: JSON.stringify(value) }]
      };
    } catch (error) {
      if (error instanceof HttpError && error.status === 403) return accessDenied();
      return toolError('cash_unavailable', 'Não foi possível obter uma resposta válida do Cash.');
    }
  }

  server.registerTool('cash_overview', {
    title: 'Saldos do Cash',
    description: 'Saldos das contas e utilização dos cartões na área autorizada. O saldo consolidado exclui os limites dos cartões.',
    inputSchema: z.object({}).strict(), annotations
  }, args => query('get_financial_overview', args));

  server.registerTool('cash_due', {
    title: 'Obrigações a vencer',
    description: 'Despesas pendentes por data de vencimento. O Cash calcula o total do período; a lista detalhada tem até 20 itens.',
    inputSchema: dueInput, annotations
  }, args => {
    if (args.window === 'CUSTOM' && (!args.startDate || !args.endDate || args.startDate > args.endDate)) {
      return toolError('invalid_period', 'Informe início e fim em ordem para o período personalizado.');
    }
    if (args.window !== 'CUSTOM' && (args.startDate || args.endDate)) {
      return toolError('invalid_period', 'Use CUSTOM para consultar datas específicas.');
    }
    return query('get_due_obligations', args);
  });

  server.registerTool('cash_expenses', {
    title: 'Gastos realizados',
    description: 'Gastos por compra/competência no período inclusivo, até 60 meses. O total inclui cartão e exclui pagamentos de fatura. A média é mensal. SUMMARY retorna totais; LIST inclui itens paginados. Preserve período e categoria ao avançar a página.',
    inputSchema: expensesInput, annotations
  }, args => {
    if (args.startDate > args.endDate || monthNumber(args.endDate) - monthNumber(args.startDate) >= 60) {
      return toolError('invalid_period', 'Informe um período em ordem de até 60 meses de calendário.');
    }
    return query('get_realized_expenses', args);
  });
}
