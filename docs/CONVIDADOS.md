# Favoritos e convidados pelo WhatsApp

Favoritos pertencem ao usuário do Hub identificado pelo remetente autenticado do WhatsApp. São nome e e-mail, não contatos no Google. Cash e Day não são alterados.

## Como usar

- `Meus convidados`: lista os favoritos e identifica as agendas com convite automático, sem usar IA.
- `Salve Ana, ana@example.com, como convidada favorita`: prepara o cadastro; confirme pelo botão.
- `Sempre convide Ana na minha agenda principal`: ativa o convite automático. Revise a conta Google e a agenda e confirme pelo botão.
- `Cadastre João, joao@example.com, e sempre o convide na agenda principal`: cadastra e prepara a preferência na mesma confirmação.
- `Pare de convidar Ana automaticamente na agenda principal`: desativa o automático nessa agenda, mantendo o favorito para seleção manual.
- `Altere o e-mail da favorita Ana para ana.nova@example.com`: revisa e confirma a edição.
- `Remova a favorita Ana`: revisa e confirma a remoção. Nomes repetidos exigem o e-mail para identificar a pessoa.

Há um limite de 20 favoritos por usuário, sem e-mails duplicados (comparação sem diferenciar maiúsculas). Cadastro e remoção não enviam convites nem alteram eventos anteriores. Desconectar Calendar não apaga os favoritos do Hub.

Ao criar um evento, o Hub inclui os automáticos daquela conta Google e agenda na primeira prévia, mostrando nomes e e-mails. A prévia tem **Confirmar**, **Convidados** e **Cancelar**, inclusive quando a seleção está vazia. **Confirmar** cria exatamente o evento revisado; não é preciso abrir a escolha antes.

**Convidados** abre a lista para substituir a seleção ou escolher **Sem convidados**. A seleção vazia remove todos do rascunho, inclusive os automáticos, e retorna à prévia para confirmação. Não modifica as preferências dos próximos eventos. É possível reabrir a seleção várias vezes.

As preferências são por remetente, conta Google e ID real da agenda (o alias `primary` é resolvido no Google). Sem indicar outra agenda, a configuração usa a principal e mostra essa escolha antes de confirmar. Agendas diferentes podem ter padrões diferentes; conectar outra conta não transfere as preferências. Eventos criados fora do Hub e eventos já existentes não recebem esses convidados automaticamente.

Com o Flow publicado/configurado e seleção vazia, **Convidados** pode abrir checkboxes dentro do WhatsApp. **Revisar evento** devolve a seleção ao Hub. Sem Flow, ou quando já existem convidados selecionados, aparece uma lista numerada com os favoritos e a seleção atual. O Flow legado inicia desmarcado; não é usado para substituir silenciosamente uma seleção existente. O usuário pode responder `1`, `1 e 3`, `1, 2, 3`, nomes (por exemplo, `Ana e João`), e-mails ou `sem convidados`.

Respostas contendo apenas números separados por vírgula, ponto e vírgula, espaços ou `e` são tratadas diretamente pelo Hub, sem chamada à IA, enquanto o evento aguarda convidados. Os números correspondem à cópia da lista guardada nesse rascunho, não à ordem de contatos inferida pelo modelo. Números fora da lista são rejeitados sem mudar o rascunho; escolhas repetidas são consideradas uma única vez. As opções continuam sujeitas à revisão dos favoritos e ao prazo do evento. Isso não é uma lista interativa de múltipla seleção da Meta: são números enviados como texto na conversa.

Nos dois caminhos, uma nova prévia mostra os e-mails escolhidos; somente **Confirmar** grava o evento e solicita ao Google o envio dos convites (`sendUpdates=all`). Não há garantia de entrega do e-mail pela API. Com seleção vazia, **Confirmar** cria sem convidados. Texto ou voz nunca substituem o botão final. E-mails explicitamente informados podem ser usados sem cadastrar favoritos; nunca são extraídos automaticamente de documentos ou eventos.

## Adicionar convidados a eventos existentes

- `Adicione Ana à reunião de amanhã`: consulta o evento e resolve Ana pelos favoritos; nomes ou eventos ambíguos exigem esclarecimento.
- `Inclua bruno@example.com no Show Crossroads de 23/12/2026`: aceita um e-mail explícito, sem cadastrá-lo automaticamente como favorito.
- `Quero adicionar convidados à reunião de amanhã`: identifica o evento e abre a escolha. Toque em **Convidados** para ver a lista e responder, por exemplo, `1 e 3`.

A prévia identifica o evento, a data, a agenda, os participantes atuais e os novos convidados. Somente **Adicionar e convidar** aplica a inclusão. E-mails já presentes são ignorados sem diferenciar maiúsculas; se todos já participam, nenhum convite é enviado e o Hub pede outra seleção ou cancelamento. Seleção vazia/`sem convidados` cancela a inclusão, sem remover participantes.

Nesta etapa, a inclusão é permitida somente na cópia da agenda organizadora, com permissão de edição e lista completa de participantes. Pode ser usada em uma ocorrência recorrente com data específica; a série inteira, eventos especiais, remoção/substituição de participantes e eventos de outro organizador continuam no Google Calendar. Não há novos escopos OAuth, alteração na Meta ou migração de banco para esta ampliação.

`calendar_add_guests` exige um ID consultado por `calendar_events` na mesma solicitação. O rascunho guarda a lista completa de participantes, suas respostas e o ETag do evento. Na confirmação, o PATCH inclui os participantes anteriores mais os novos e-mails, preservando os demais campos do evento. `If-Match` impede sobrescrever alterações posteriores à prévia. `sendUpdates=all` solicita os convites e pode notificar também os convidados atuais; o Hub não promete entrega individual. Uma resposta incerta não é repetida automaticamente.

## Persistência e segurança

A migração 4 adiciona `guest_favorites` (uma coleção cifrada por remetente, com revisão) e `guest_favorite_drafts` (confirmações cifradas de gestão). Usa AES-256-GCM com o `HUB_ENCRYPTION_KEY` existente, contexto vinculado ao dono, consultas parametrizadas e transações curtas. Nenhuma chamada externa é feita mantendo locks de favoritos.

As preferências automáticas usam o campo opcional `automatic` na coleção cifrada de favoritos: `{accountId, calendarId, label, accountLabel}[]`. Favoritos antigos sem esse campo continuam manuais; não é necessária migração de schema nem alteração na Meta. `guest_favorite_prepare` recebe `automatic` (true/false/null) e `calendarId`. O servidor valida a conta e a permissão da agenda antes de preparar a confirmação.

O rascunho Calendar guarda uma cópia cifrada dos favoritos exibidos e sua revisão. Abrir e concluir a seleção substitui atomicamente o token anterior, preservando o prazo original de dez minutos e o ID do evento. `calendar_revise_draft` corrige uma prévia de criação sem reiniciar o prazo ou recalcular convidados. A seleção explícita, inclusive vazia, prevalece sobre os padrões durante todo o rascunho. Um novo pedido independente aplica novamente os padrões.

Confirmar um rascunho que ainda aguarda convidados é bloqueado também no servidor. Tokens são vinculados ao remetente e à autorização Calendar; expiração, substituição, desconexão e reconexão invalidam a seleção. Se os favoritos mudarem antes da seleção, é necessário preparar novamente. A prévia final mantém exatamente os e-mails revisados, mesmo se o cadastro mudar depois.

Respostas `interactive.nfm_reply.response_json` passam pela assinatura do webhook e aceitam somente `flow_token` e até 20 UUIDs únicos em `guest_ids`. E-mails e nomes vêm do rascunho do servidor. Nenhum conteúdo do formulário é interpretado como comando da IA. Histórico e filas continuam cifrados. Rascunhos expirados são removidos após 30 dias; favoritos ficam até remoção pelo usuário.

## Ativação do Flow

1. No Gerenciador do WhatsApp, escolha a mesma WABA do número usado pelo Hub.
2. Crie um Flow sem endpoint, categoria Outro, com o conteúdo de [`flows/calendar-guests.json`](../flows/calendar-guests.json).
3. Execute, confira a prévia e salve. A definição contém apenas dados fictícios de exemplo; a lista real é fornecida individualmente na mensagem.
4. Publique quando a Meta liberar a conta. Configure `WHATSAPP_GUESTS_FLOW_ID` no Render somente depois de publicado. Sem essa variável, o caminho por nomes permanece disponível.
5. Faça deploy do Hub com `npm run db:migrate` no predeploy e teste a conversa real. O evento e os convites do teste final devem ser aprovados pelo usuário.

Não é necessário novo endpoint, troca de token, criptografia de data exchange ou inscrição no campo webhook `flows`. As conclusões chegam pela assinatura `messages` existente. O Flow usa `navigate`, tela `GUESTS`, `data.favorites` e a ação `complete`.

Em 07/10/2026, o Flow `zenit_hub_calendar_guests_v1`, ID `2420131695459275`, foi salvo na WABA Zenit Agente e validado no editor com zero erros. A Meta bloqueou a publicação com a exigência de verificar a empresa **ou** atender ao critério de mensagens de alta qualidade. Não configure esse rascunho como ativo. A evidência fica no registro da implementação; o estado da conta deve ser conferido novamente antes da ativação.

## Testes e operação

`npm run check` usa PostgreSQL local e APIs simuladas. Cobre isolamento, cifragem, capacidade, duplicidade, ambiguidades, confirmações concorrentes, tokens expirados/substituídos, troca de conta, seleção vazia, convidados desconhecidos, webhook assinado e ausência de escrita antes da confirmação. A inclusão em eventos existentes também cobre preservação de RSVP/metadados, deduplicação com convidados atuais, lista incompleta, permissão de organizador, conflito de ETag, resposta incerta e exigência de consulta atual do evento. `npm run build` verifica a compilação de produção.

Após a migração 4, versões anteriores que exigem exatamente schema 3 não iniciam. Para desativar somente o Flow, remova a variável e faça novo deploy; não reverta o banco nem remova favoritos. Um rollback de código precisa continuar aceitando schema 4 ou usar restauração planejada do banco.

Referências: [Flows da Meta](https://developers.facebook.com/docs/whatsapp/flows/), [criação de eventos Google](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert), [PATCH e envio de atualizações](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch), [campos de participantes](https://developers.google.com/workspace/calendar/api/v3/reference/events).
