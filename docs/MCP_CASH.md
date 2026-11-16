# Consultar o Cash por MCP

O cliente MCP conversa com o Hub por Streamable HTTP em `/mcp`. Cada autorização dá acesso de leitura a uma única área do Cash. Os resultados vêm da mesma ponte financeira que atende o assistente do WhatsApp.

## Conectar

1. No cliente MCP, adicione um servidor remoto usando a origem pública do Hub seguida de `/mcp`. Escolha OAuth e inicie a conexão. O cliente descobre os endpoints e pode se registrar automaticamente.
2. O navegador mostra o comando `conectar MCP <código>`. Envie-o na sua conversa com o Zenit Hub pelo WhatsApp. Para escolher outra área, acrescente o nome ou o ID ao final, por exemplo `conectar MCP <código> Pessoal`. O comando simples usa a área selecionada no WhatsApp.
3. Confira a origem do cliente e a área exibidas pelo Hub antes de tocar em **Autorizar leitura**. Volte à mesma página do navegador e clique em **Concluir conexão**. O código de vinculação vale por dez minutos.
4. No chat, pergunte, por exemplo, “Quais categorias mais pesaram nos meus gastos dos últimos três meses completos?” ou “Quais obrigações vencem nos próximos sete dias?”.

A escolha da área para o MCP vale para essa conexão. Você pode continuar usando outra área no WhatsApp. O cliente pode renovar o acesso por até 30 dias a partir da aprovação. Depois desse período, é preciso autorizar novamente. Para revogar todos os clientes MCP que autorizou, envie **desconectar MCP** ao Hub pelo WhatsApp. A revogação individual também está disponível para clientes que usam o endpoint OAuth de revogação.

## Consultas disponíveis

| Ferramenta | Resultado |
| --- | --- |
| `cash_overview` | Saldos das contas e utilização dos cartões. O total dos saldos exclui o limite dos cartões. |
| `cash_due` | Obrigações pendentes por vencimento. O total cobre todo o intervalo. A lista detalha até 20 itens e informa a quantidade total. |
| `cash_expenses` | Gastos realizados por compra ou competência, com os totais calculados pelo Cash. Aceita intervalo, categoria, filtro de despesas fixas, agrupamento, resumo ou lista paginada. |

Cada consulta verifica o vínculo e a área na ponte do Cash e devolve a área efetivamente utilizada. Se o vínculo mudar ou a pessoa perder acesso, a consulta é recusada. A IA do cliente recebe os dados para análise. O fluxo de consultas MCP funciona independentemente da configuração de IA do Hub.

## Disponibilizar o endpoint

O Hub usa o `HUB_PUBLIC_URL` já configurado como origem OAuth e a conexão já existente com o Cash e o WhatsApp. Em uma implantação do Hub, execute o build e aplique a migração 11 com `npm run db:migrate` antes de iniciar a versão nova. A configuração do Render já executa a migração em pre-deploy. Para uma instância local, a URL padrão é `http://localhost:3210/mcp`; clientes remotos precisam alcançar a origem HTTPS publicada.
