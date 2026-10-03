# Verificação do Google — Zenit Hub

Preparação revisada em 02/10/2026. A publicação OAuth em **Produção**, a verificação da marca e a aprovação dos escopos são etapas distintas. Não volte o aplicativo para Teste para gravar a demonstração.

## Situação e identificação

- Projeto: `iron-bedrock-494003-d3`, nome **Zenit**.
- Único cliente listado no console nesta revisão: **Zenit Hub**, aplicativo da Web.
- Callback: `https://zenit-hub.onrender.com/oauth/calendar/callback`.
- Apresentação: [Zenit Hub](https://zenitapp.net/hub).
- [Política de Privacidade](https://zenitapp.net/privacy) e [Termos](https://zenitapp.net/terms).
- [Guia de uso](https://zenitapp.net/docs/help/zenit-hub/getting-started/).
- A justificativa dos escopos foi salva no Google Cloud. O vídeo ainda precisa ser gravado e informado.
- O Google havia apontado conteúdo insuficiente na política de privacidade. A revisão detalha dados, finalidade, provedores, segurança, retenção e exclusão, conforme o código. Foi publicada no site em 02/10/2026 (commit `11eab40` do monorepo Zenit) e confirmada no domínio oficial.
- **Marca verificada e publicada em 02/10/2026.** Após a nova análise e a ação “Publicar branding”, o console confirmou: “Sua marca foi verificada e está aparecendo para os usuários.”
- **Acesso aos dados ainda não verificado.** A aprovação da marca não aprova automaticamente o escopo `calendar.events`; faltam o vídeo real, o envio e a análise dessa etapa.

## Roteiro de gravação

Planeje cerca de 4 a 6 minutos, sem pressa nas telas de consentimento. Use uma conta sua e eventos fictícios, sem convidados. Deixe o WhatsApp e o Google Calendar abertos. A gravação precisa mostrar o fluxo real; não substitua telas por slides ou simulações.

O Google pede a tela de consentimento completa em **inglês**, incluindo todos os acessos solicitados. Você pode manter os comandos do WhatsApp em português e usar as frases em inglês abaixo como narração ou legendas. O aviso de aplicativo não verificado, se aparecer, deve constar da gravação. Não grave senhas, códigos de autenticação, segredos do cliente OAuth ou conversas pessoais alheias à demonstração.

### 1. Apresentar o produto e a política

Abra `https://zenitapp.net/hub` e o link da política. Mostre brevemente as seções Google APIs, compartilhamento e retenção.

Narração sugerida: “Zenit Hub is a personal assistant accessed through WhatsApp. Users independently connect the services they want to use. This demonstration shows the Google Calendar integration.”

### 2. Conectar a conta Google

No WhatsApp, envie:

> conectar Calendar

Abra o link, prossiga e selecione a conta de demonstração. Na autorização do Google, selecione inglês no controle de idioma. Mostre o nome **Zenit**, a conta e a lista completa de permissões, abrindo os detalhes quando necessário. Autorize os acessos solicitados. Volte ao WhatsApp e confirme a conta pelo botão **Conectar**.

O fluxo usa `prompt=consent`, portanto reconectar solicita consentimento novamente. Reconectar invalida prévias de alterações antigas; faça a gravação sem operações pendentes. Não é necessário começar desconectando a conta, pois a desconexão também desativa assinaturas de notificações.

Narração: “The user selects a Google account and grants access to identify the account, list calendars, and read and manage events. The account is also confirmed in the same WhatsApp conversation.”

### 3. Mostrar a conta e listar agendas

Envie:

> conexões

> Liste minhas agendas do Google Calendar.

Mostre o e-mail conectado e a resposta com as agendas. Isso demonstra a finalidade de identidade/e-mail e `calendar.calendarlist.readonly`.

Narração: “The assistant identifies the connected account and lists its calendars. Each operation respects the account's permissions on the selected calendar.”

### 4. Criar um evento fictício

Escolha uma data futura completa, com ano, e use o mesmo dia em todos os passos. Exemplo, substituindo a data se necessário:

> Crie na minha agenda principal um evento chamado Demonstração Zenit Hub em 10/10/2026, das 14h às 14h30, horário de São Paulo, sem convidados.

Mostre a prévia, clique no botão **Confirmar** e aguarde a resposta de sucesso. Abra a mesma data no Google Calendar e mostre o evento criado.

Narração: “Write access is needed to create events requested by the user. The event is created only after the user reviews the preview and clicks the confirmation button.”

### 5. Consultar o evento

> Quais compromissos tenho em 10/10/2026 na agenda principal?

Mostre a resposta com o evento e o horário. Se aparecerem eventos particulares, use uma agenda ou conta de demonstração com dados fictícios, mantendo a mesma escolha nos demais passos.

Narração: “Calendar event details are used to answer scheduling questions. Availability-only access would not provide the title and details shown here.”

### 6. Alterar o horário

> Altere o evento Demonstração Zenit Hub de 10/10/2026 para começar às 15h e terminar às 15h30, horário de São Paulo.

Se houver pedido de esclarecimento, responda. Mostre a nova prévia e clique no botão atual **Confirmar**. Mostre no Google Calendar o horário atualizado.

Narração: “The integration also edits existing events. Read-only access cannot support this action. Each change needs a new preview and confirmation.”

### 7. Excluir apenas o evento demonstrativo

> Exclua o evento Demonstração Zenit Hub de 10/10/2026 da agenda principal.

Mostre a prévia de exclusão, confirme pelo botão e mostre o resultado no Calendar. Confira título, data e agenda antes de confirmar para não excluir outro evento.

Narração: “The user can request deletion of an event and explicitly confirm it. The app does not request access to Gmail, calendar administration, or calendar sharing.”

### 8. Encerrar com privacidade e disponibilizar o vídeo

Mostre na política como desconectar e solicitar exclusão. Não precisa desconectar de fato, para preservar as assinaturas de notificações.

Narração: “Users can disconnect Calendar in WhatsApp or revoke access in their Google Account. The privacy policy explains processing providers, retention, and data deletion requests.”

Publique no YouTube como **não listado**, acessível a qualquer pessoa com o link. Não use vídeo privado que exija convite. Título sugerido: **Zenit Hub — Google Calendar OAuth demonstration**. Abra o link sem estar autenticado para confirmar que o avaliador consegue assistir. Depois informe o link para preenchermos o campo de demonstração no Google Cloud.

Se outro cliente OAuth for acrescentado ao projeto, a demonstração e a justificativa precisarão cobrir também esse cliente. O roteiro atual corresponde ao cliente Web **Zenit Hub** listado no console.

## Justificativa salva no console

Texto em inglês, 858 caracteres, para o campo “Como os escopos serão usados?”:

> Zenit Hub is a personal assistant accessed through WhatsApp. After a user connects a Google account, it lists authorized calendars and searches events to answer scheduling questions and prepare optional daily summaries. calendar.events is required to read existing events and create, update or delete events requested by that user. Every write is previewed and executed only after the user clicks the current confirmation button in WhatsApp. Read-only scopes cannot perform these writes; availability-only access cannot provide event details. Access limited to app-created calendars would not support users managing events already in their own calendars. calendar.calendarlist.readonly identifies available calendars and access roles. openid and email identify the connected account. No Gmail, calendar administration or calendar sharing access is requested.

Escopos atuais: `openid`, `https://www.googleapis.com/auth/userinfo.email`, `https://www.googleapis.com/auth/calendar.calendarlist.readonly` e `https://www.googleapis.com/auth/calendar.events`. No pedido OAuth, `email` corresponde ao acesso de e-mail exibido no console. Somente `calendar.events` aparece como sensível; não há escopos restritos cadastrados.

## Evidências técnicas da política

| Informação                                                        | Implementação                                                                                 |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Consentimento, conta e tokens                                     | [oauth.ts](../src/oauth.ts), [store.ts](../src/store.ts)                                      |
| Campos lidos nas listas de agendas e eventos                      | [calendar.ts](../src/connectors/calendar.ts)                                                  |
| Leitura de evento específico, prévia, participantes e confirmação | [calendar-writes.ts](../src/connectors/calendar-writes.ts)                                    |
| Histórico e resultados enviados à IA; `store: false`              | [assistant.ts](../src/assistant.ts)                                                           |
| Arquivo de áudio apenas em memória                                | [audio.ts](../src/audio.ts)                                                                   |
| Criptografia, limpeza, desconexão                                 | [security.ts](../src/security.ts), [store.ts](../src/store.ts), [worker.ts](../src/worker.ts) |

Regras de retenção da base operacional, verificadas em `Store.prune()`:

| Registro                                              | Regra                                                                                          |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `oauth_links`                                         | Remove depois de expirar.                                                                      |
| `history`                                             | Remove após 24 horas; leitura e limite por remetente mantêm até 12 mensagens.                  |
| `inbox`                                               | Remove depois de 30 dias da criação **apenas** se `done`.                                      |
| `outbox`                                              | Remove depois de 30 dias da criação **apenas** se `sent`.                                      |
| `calendar_drafts` / `notification_drafts`             | Remove 30 dias após expirar, exceto `executing`.                                               |
| `notification_deliveries`                             | Remove depois de 30 dias da criação, exceto `pending` e `sending`.                             |
| Conexões e tokens                                     | `disconnect()` remove a conexão solicitada e os tokens.                                        |
| Preferências, assinaturas e falhas fora dessas regras | Não têm limpeza universal de 30 dias; exigem resolução operacional ou atendimento de exclusão. |

O worker tenta a limpeza em intervalos de pelo menos um minuto quando está em funcionamento. Desconectar também limpa o histórico do remetente, desativa suas assinaturas e cancela prévias pendentes; não apaga todos os registros operacionais nem os dados dos aplicativos conectados. A retenção de backups e de cada provedor não foi auditada nesta revisão. `store: false` não comprova Zero Data Retention nem ausência de registros de prevenção de abuso na OpenAI.

## Etapas da verificação

1. **Concluído:** política publicada, correção informada em Branding e nova verificação solicitada.
2. **Concluído:** marca aprovada pelo Google e publicada no console.
3. Informar o vídeo real em **Acesso a dados**, salvar e abrir a Central de verificação.
4. Revisar a solicitação e enviar a verificação dos escopos sensíveis. Esse envio e a aprovação são separados da verificação da marca.
5. Acompanhar os e-mails de contato do projeto e responder a exigências concretas do avaliador. Não alterar escopos ou clientes sem necessidade durante a análise.

Nenhuma aprovação do Google é garantida por esta preparação. Manter a aplicação em Produção não significa que marca e escopos já estejam verificados.

Referências oficiais: [verificação de marca](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification), [requisitos da demonstração](https://support.google.com/cloud/answer/13804565?hl=en), [política de privacidade na verificação](https://support.google.com/cloud/answer/13806988?hl=en) e [controles de dados da API OpenAI](https://developers.openai.com/api/docs/guides/your-data).
