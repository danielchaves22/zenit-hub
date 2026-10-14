# Workspaces pelo WhatsApp

O mesmo número pode acessar os workspaces autorizados para seu usuário no Zenit. A seleção define o contexto financeiro do Cash; não troca as contas conectadas do Day ou do Google Calendar.

## Comandos

- `workspaces` ou `minhas empresas`: abre uma lista, com paginação quando necessário.
- `workspace atual`: mostra o contexto selecionado.
- `usar Empresa X`: seleciona o nome exato para as próximas mensagens.
- `voltar para o pessoal`: seleciona o único workspace pessoal autorizado.
- `Qual é o saldo da Empresa X?`: permite consultar explicitamente outro workspace somente nesse pedido. A seleção padrão permanece igual.

Nomes repetidos exigem a escolha pela lista. Um workspace sem acesso ao Cash não libera consultas financeiras. O acesso ao Bizz é identificado separadamente; suas operações comerciais ainda não estão integradas às ferramentas do Hub.

As respostas financeiras e revisões de lançamentos exibem `Cash · Nome do workspace`. O botão de um rascunho continua vinculado ao workspace, usuário, sessão e revisão originais, mesmo depois de trocar o contexto. A confirmação verifica novamente o acesso; ela não troca a seleção atual. Uma consulta ou alteração por mensagem; consolidação entre empresas não está disponível.

## Contrato e isolamento

A ponte assinada do Cash aceita `workspaces` e `select_workspace`. Consultas e mensagens recebem `workspaceId` como seletor, nunca como autorização. O backend resolve a identidade pelo vínculo do número e verifica associação à empresa, acesso ao canal, acesso ao Cash e permissões financeiras. Seleções inválidas não caem no primeiro workspace disponível. Respostas incluem o workspace efetivamente usado.

O Hub fixa o workspace no início de cada solicitação e envia esse seletor nas chamadas financeiras. A ferramenta `workspace_use` reinicia a interpretação somente com o histórico do destino antes de qualquer consulta; `workspace_select` retorna a troca sem executar operações financeiras na mesma chamada. Comandos e listas não precisam de IA. Consultas conversacionais passam pela interpretação do Hub; escritas continuam no assistente do Cash e exigem botão.

O histórico curto é cifrado e separado por remetente e referência do vínculo/workspace, com até 12 registros e 24 horas por contexto. Uma referência inclui o vínculo do Cash, evitando reutilizar conversas de outro usuário depois de uma reconexão. A revogação do Cash impede carregar o histórico financeiro daquele contexto. A migração 7 mantém os registros antigos numa partição `legacy` que não é fornecida ao modelo; eles expiram pela retenção normal, pois não é possível inferir seu workspace com segurança.

## Resumo diário

A prévia da assinatura mostra e fixa o workspace do Cash. Trocar o contexto da conversa não altera uma assinatura ou prévia já preparada. A confirmação revalida o vínculo e a permissão do workspace original. A entrega consulta esse workspace e identifica seu nome. Se perder acesso, a seção financeira informa indisponibilidade e não substitui a empresa.

Assinaturas anteriores à migração, que guardavam apenas `cash: connected`, não identificam a empresa autorizada: a seção Cash orienta selecionar o workspace e configurar novamente o resumo. As demais fontes continuam sendo consultadas. Não é necessário recriar os lembretes do Day.

## Implantação e verificação

1. Publicar primeiro o backend compartilhado com o novo contrato da ponte. Não há migração Prisma nesta mudança.
2. Publicar o Hub e executar sua migração 7 antes de iniciar o processo, pelo pre-deploy já configurado.
3. Pelo WhatsApp, listar os workspaces, alternar, consultar e verificar o nome exibido. Preparar um rascunho, alternar e confirmar somente se desejar efetivamente gravá-lo no workspace indicado na prévia.

Os testes locais usam serviços simulados e PostgreSQL de teste; não enviam WhatsApp nem criam lançamentos de produção. A aprovação de templates de lembretes é independente desta funcionalidade.
