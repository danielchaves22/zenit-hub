# Conectores do Zenit Hub

Revisão documental: 02/10/2026. Use [.env.example](../.env.example) como referência de variáveis e [Render](RENDER.md) para implantação. Cada conector autoriza sua própria conta; não há SSO entre as aplicações.

### Cash

1. Instale no backend Cash a ponte `POST /api/integrations/hub/bridge` incluída nesta extração.
2. Configure o mesmo `CASH_HUB_SHARED_SECRET` de pelo menos 32 caracteres aleatórios nos dois serviços. Sem ele a ponte fica desabilitada.
3. Aponte `CASH_API_URL` para a origem HTTPS do Cash. `CASH_CONNECT_URL` é opcional e aponta ao perfil/integrações do Cash.
4. Mantenha `CASH_BINDING_PREFIX` igual ao `WHATSAPP_BINDING_MESSAGE_PREFIX` do Cash (padrão `VINCULAR ZENIT`).

A ponte é uma integração interna de primeira parte, com assinatura HMAC, timestamp, nonce e deduplicação por ID de mensagem. Não é um servidor OAuth público nem um acesso administrativo ao banco. Cash resolve o remetente pelo vínculo validado por QR Code e verifica usuário/workspace, acesso aos aplicativos e permissões financeiras em cada execução. Hub nunca fornece `userId`, `companyId` ou `role`.

O registro de mensagens já existente no Cash é reutilizado, sem nova migração. Os endpoints e o assistente web/mobile continuam disponíveis. A compatibilidade inicial da ponte Cash usa remetentes numéricos do fluxo existente; suportar outros identificadores do WhatsApp requer evoluir também o vínculo do Cash.

Mensagens de voz são baixadas e transcritas **no Hub**, usando `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `OPENAI_API_KEY` e `WHATSAPP_TRANSCRIPTION_MODEL` (padrão `gpt-transcribe`) do Hub. O contexto da transcrição é neutro, sem presumir um domínio financeiro. Depois da transcrição, o mesmo fluxo usado para texto escolhe Cash, Day ou Calendar e trata comandos de conexão. Áudio para Day/Calendar funciona sem vínculo Cash. Somente pedidos financeiros chegam ao Cash, como texto, com o mesmo remetente e ID da mensagem; não há segunda transcrição.

O Hub aceita até 16 MB, valida tipo, tamanho, hash quando fornecido e destino HTTPS da mídia Meta, bloqueando redirecionamentos. O arquivo fica apenas em memória. A fila mantém a referência cifrada; o texto transcrito e a resposta entram no histórico curto cifrado (até 12 mensagens e 24 horas), permitindo continuar por voz ou texto sem perder datas e outros detalhes. O modelo de interpretação não recebe URLs de mídia nem credenciais. A transcrição limita cada pedido a 6.000 caracteres e falha antes de chamar qualquer aplicação quando não consegue processar a fala.

Para usar voz, o remetente precisa ter ao menos uma conexão ativa. Sem conexões, o Hub orienta enviar `conexões` por texto e não inicia uma transcrição paga. A primeira conexão continua disponível por texto/QR Code.

O Hub assume o envio das respostas e do indicador de digitação. Correções usam a sessão e o rascunho existentes do Cash. Somente o botão Confirmar atual grava um lançamento; texto, voz e botões de revisões anteriores não confirmam. Falhas de transcrição retornam orientação sem executar uma operação financeira. A fila persiste a referência cifrada, sem guardar o arquivo de áudio.

A ponte aguarda até 240 segundos para respostas do assistente Cash, sem repetir automaticamente uma chamada cujo resultado seja incerto. Configure o proxy do Cash para comportar essa duração e permita até 300 segundos para encerramento do Hub durante uma atualização. No Hub, os limites são 15 segundos para metadados de mídia, 30 para download e 60 para transcrição, sem repetição automática. Consultas curtas continuam com limite de 45 segundos.

### Day

Siga a [preparação do Day](https://github.com/danielchaves22/zenit-day/blob/master/docs/ZENIT_HUB.md).

É preciso aplicar a migração local de proteção OAuth, publicar a página `/oauth/consent` do Day e habilitar o servidor OAuth no projeto Supabase. Registre o Hub como cliente confidencial (`client_secret_basic`) com callback exato `HUB_PUBLIC_URL/oauth/day/callback`.

Configure `DAY_SUPABASE_URL`, `DAY_SITE_URL` (origem HTTPS da tela de consentimento), chave **publicável**, `DAY_CLIENT_ID` e `DAY_CLIENT_SECRET` no Hub. A senha do usuário é enviada pelo navegador diretamente ao Auth do Day. O Hub recebe somente a autorização OAuth. Não use `service_role` ou chave secreta administrativa. O Hub testa a capacidade `zenit_day_hub_connection_check` antes de aceitar a conexão.

As consultas retornam somente dados sincronizados; alterações offline ainda não enviadas pelo Day não aparecem.

Assuntos continuam somente leitura. Para consultar/gerenciar lembretes, a página `/hub/reminders` do Day concede autorização específica e revogável; o cliente deve estar permitido na configuração privada do Day. Essa autorização é independente da assinatura de envio no WhatsApp. Os escopos de identidade OAuth não liberam tabelas: as políticas RLS e as RPCs verificam o usuário, o cliente OAuth e o consentimento aplicável. Consulte [Lembretes](https://github.com/danielchaves22/zenit-day/blob/master/docs/LEMBRETES.md) e a [segurança de tokens do Supabase](https://supabase.com/docs/guides/auth/oauth-server/token-security).

### Calendar

Registre um cliente OAuth web no Google Cloud com callback exato `HUB_PUBLIC_URL/oauth/calendar/callback`, habilite Calendar API e configure a tela de consentimento e os usuários de teste ou publicação conforme o ambiente. Configure `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` no Hub.

Escopos: `openid`, `email`, `https://www.googleapis.com/auth/calendar.events` e `https://www.googleapis.com/auth/calendar.calendarlist.readonly`. A agenda padrão é `primary`; o assistente pode listar outras agendas autorizadas, respeitando o papel de leitor/editor no Google. Autorizações antigas de somente leitura precisam ser refeitas com `conectar Calendar`.

Criação, alteração e exclusão de eventos comuns exigem uma prévia determinística com conta, agenda, título e horário, seguida do botão **Confirmar** no WhatsApp. Texto ou voz não confirmam. Os rascunhos ficam cifrados no PostgreSQL, expiram em dez minutos e são vinculados à conexão e ao remetente. Uma nova prévia substitui a anterior; reconectar ou desconectar invalida as pendências. O botão é consumido atomicamente e não repete a operação, inclusive após reinício. O Hub usa um ID próprio ao criar e `If-Match` ao alterar/excluir: mudanças feitas no Google após a prévia exigem nova revisão. Timeouts ficam em `uncertain`, sem repetição automática.

São aceitos eventos com horário ou de dia inteiro, título, descrição, local e lembretes popup do Google (não notificações proativas no WhatsApp). Datas ambíguas e horários incompletos devem ser esclarecidos. Alterar/excluir exige consultar o ID do evento na mesma solicitação. É possível editar uma ocorrência recorrente individual; criação/edição da série inteira, convidados, Google Meet e tipos especiais de evento ainda ficam no Google Calendar. Ao editar/excluir um evento que já possui convidados, a prévia informa os participantes e o possível envio de notificações pelo Google (`sendUpdates=all`).

### IA e WhatsApp

Configure `OPENAI_API_KEY` e `OPENAI_MODEL` para consultas entre aplicações. Os comandos de conexão não usam IA. Se somente Cash estiver conectado, usa-se a configuração de IA já existente no Cash.

No piloto, configure `HUB_ALLOWED_SENDERS` com os identificadores permitidos. Defina no Hub as credenciais do número WhatsApp, App Secret e token de verificação. A versão da Graph API é configurável e deve ser a mesma validada no ambiente. A migração não modifica a configuração da Meta automaticamente.

## Notificações

Conectar aplicações não autoriza envios proativos. Veja [assinaturas, lembretes e templates](NOTIFICACOES.md).
