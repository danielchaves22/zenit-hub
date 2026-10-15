# Áreas de trabalho pelo WhatsApp

O mesmo número pode acessar as áreas de trabalho autorizadas para seu usuário no Zenit. A seleção define o contexto financeiro do Cash; não troca as contas conectadas do Day ou do Google Calendar. “Workspace” continua sendo aceito como comando alternativo. Os identificadores técnicos e os botões de mensagens anteriores são preservados.

## Comandos

- `minhas áreas`, `áreas de trabalho` ou `trocar área`: abre uma lista, com paginação quando necessário. Também aceita `workspace`, `workspaces`, `meus workspaces` e `minhas empresas`.
- `área atual` ou `área de trabalho atual`: mostra o contexto selecionado. `workspace atual` continua válido.
- `usar Empresa X` ou `usar a área de trabalho Empresa X`: seleciona o nome exato para as próximas mensagens.
- `voltar para o pessoal` ou `voltar para Casa`: seleciona a área pessoal autorizada, sem escolher entre nomes ambíguos.
- `Qual é o saldo da Empresa X?`: permite consultar explicitamente outra área de trabalho somente nesse pedido. A seleção padrão permanece igual.

Os comandos aceitam maiúsculas e minúsculas, com ou sem acentos. O menu mostra `Área atual` e o botão `Escolher área`, abreviado para respeitar o limite de 20 caracteres do WhatsApp.

Nomes repetidos exigem a escolha pela lista. Uma área de trabalho sem acesso ao Cash não libera consultas financeiras. O acesso ao Bizz é identificado separadamente; suas operações comerciais ainda não estão integradas às ferramentas do Hub.

As respostas financeiras e revisões de lançamentos exibem `Cash · Nome da área`. O botão de um rascunho continua vinculado à área de trabalho, usuário, sessão e revisão originais, mesmo depois de trocar o contexto. A confirmação verifica novamente o acesso; ela não troca a seleção atual. Uma consulta ou alteração por mensagem; consolidação entre empresas não está disponível.

## Contrato e isolamento

A ponte assinada do Cash aceita `workspaces` e `select_workspace`. Consultas e mensagens recebem `workspaceId` como seletor, nunca como autorização. O backend resolve a identidade pelo vínculo do número e verifica associação à empresa, acesso ao canal, acesso ao Cash e permissões financeiras. Seleções inválidas não caem no primeiro workspace disponível. Respostas incluem o workspace efetivamente usado.

O Hub fixa o workspace no início de cada solicitação e envia esse seletor nas chamadas financeiras. A ferramenta `workspace_use` reinicia a interpretação somente com o histórico do destino antes de qualquer consulta; `workspace_select` retorna a troca sem executar operações financeiras na mesma chamada. Comandos e listas não precisam de IA. Consultas conversacionais passam pela interpretação do Hub; escritas continuam no assistente do Cash e exigem botão.

O histórico curto é cifrado e separado por remetente e referência do vínculo/workspace, com até 12 registros e 24 horas por contexto. Uma referência inclui o vínculo do Cash, evitando reutilizar conversas de outro usuário depois de uma reconexão. A revogação do Cash impede carregar o histórico financeiro daquele contexto. A migração 7 mantém os registros antigos numa partição `legacy` que não é fornecida ao modelo; eles expiram pela retenção normal, pois não é possível inferir seu workspace com segurança.

## Resumo diário

A prévia da assinatura mostra e fixa a área de trabalho do Cash. Trocar o contexto da conversa não altera uma assinatura ou prévia já preparada. A confirmação revalida o vínculo e a permissão da área original. A entrega consulta essa área e identifica seu nome. Se perder acesso, a seção financeira informa indisponibilidade e não substitui a empresa.

Assinaturas anteriores à migração, que guardavam apenas `cash: connected`, não identificam a empresa autorizada: a seção Cash orienta selecionar a área de trabalho e configurar novamente o resumo. As demais fontes continuam sendo consultadas. Não é necessário recriar os lembretes do Day.

## Implantação e verificação

1. Publicar primeiro o backend compartilhado com o novo contrato da ponte. Não há migração Prisma nesta mudança.
2. Publicar o Hub e executar sua migração 7 antes de iniciar o processo, pelo pre-deploy já configurado.
3. Pelo WhatsApp, listar as áreas de trabalho, alternar, consultar e verificar o nome exibido. Preparar um rascunho, alternar e confirmar somente se desejar efetivamente gravá-lo na área indicada na prévia.

A atualização de terminologia para “área de trabalho” altera apenas o Hub e não exige nova migração nem mudanças no Cash.

Os testes locais usam serviços simulados e PostgreSQL de teste; não enviam WhatsApp nem criam lançamentos de produção. A aprovação de templates de lembretes é independente desta funcionalidade.
