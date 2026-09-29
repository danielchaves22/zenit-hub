# Zenit Hub

Backend pessoal de conexões para conversar com Cash, Day e Google Calendar pelo WhatsApp. Cada aplicação mantém seus dados e suas regras. O Hub guarda somente conexões, mensagens recentes e estado operacional.

## Versão 0.1

- Entrada única pela WhatsApp Cloud API, validada por assinatura e identificação do número de destino.
- Cash: preserva QR Code, vínculo existente, assistente financeiro, mensagens de voz e confirmações por botão. Com somente Cash conectado, o texto vai diretamente ao assistente atual; áudios e `cash: ...` seguem esse caminho mesmo com outras conexões, sem uma chamada adicional de IA no Hub.
- Day e Calendar: autorização pelo navegador, seguida de confirmação da conta na conversa que originou o pedido. Contas independentes, sem SSO ou senha própria do Hub.
- Consultas consolidadas por ferramentas. O Day e o Calendar são **somente leitura** nesta versão; alterações financeiras seguem o fluxo existente do Cash.
- SQLite com credenciais e conteúdo de mensagens cifrados por AES-256-GCM; contexto limitado a 12 mensagens por pessoa e 24 horas.
- Webhook persistido antes de retornar 202. IDs impedem processamento repetido; o worker é serial e pode ser retomado após reiniciar.

```text
WhatsApp → Hub → ponte autenticada do Cash → serviços financeiros
              → API do Day (Supabase OAuth + RLS)
              → API do Google Calendar (OAuth)
```

## Execução local

Node 22.14+ (usa `node:sqlite`, experimental no Node 22). Uma instância do processo por banco SQLite.

```powershell
npm ci
Copy-Item .env.example .env
# Edite .env sem compartilhar valores de credenciais.
npm run check
npm run build
npm start
```

`GET /health` confirma que o processo iniciou. `HUB_ENCRYPTION_KEY` deve conter 32 bytes aleatórios em base64 e deve ser mantida estável e protegida junto aos backups. Perdê-la impede decifrar conexões existentes. Não use chave do JWT do Cash ou segredos dos provedores como chave do Hub.

O servidor escuta em `127.0.0.1:3210`. Para publicar, coloque um proxy HTTPS nesse host e configure `HUB_PUBLIC_URL` com a origem pública exata. Defina limites de requisições no proxy. Não registre URLs de callback, cabeçalhos Authorization, corpo de mensagens ou parâmetros OAuth nos logs. Faça backup do SQLite usando uma cópia consistente com seu WAL e proteja os arquivos: IDs operacionais de remetentes permanecem visíveis no índice, embora tokens e conteúdo sejam cifrados.

## Configuração dos conectores

### Cash

1. Instale no backend Cash a ponte `POST /api/integrations/hub/bridge` incluída nesta extração.
2. Configure o mesmo `CASH_HUB_SHARED_SECRET` de pelo menos 32 caracteres aleatórios nos dois serviços. Sem ele a ponte fica desabilitada.
3. Aponte `CASH_API_URL` para a origem HTTPS do Cash. `CASH_CONNECT_URL` é opcional e aponta ao perfil/integrações do Cash.
4. Mantenha `CASH_BINDING_PREFIX` igual ao `WHATSAPP_BINDING_MESSAGE_PREFIX` do Cash (padrão `VINCULAR ZENIT`).

A ponte é uma integração interna de primeira parte, com assinatura HMAC, timestamp, nonce e deduplicação por ID de mensagem. Não é um servidor OAuth público nem um acesso administrativo ao banco. Cash resolve o remetente pelo vínculo validado por QR Code e verifica usuário/workspace, acesso aos aplicativos e permissões financeiras em cada execução. Hub nunca fornece `userId`, `companyId` ou `role`.

O registro de mensagens já existente no Cash é reutilizado, sem nova migração. Os endpoints e o assistente web/mobile continuam disponíveis. A compatibilidade inicial da ponte Cash usa remetentes numéricos do fluxo existente; suportar outros identificadores do WhatsApp requer evoluir também o vínculo do Cash.

Mensagens de voz seguem para o Cash como uma referência de mídia assinada. O Cash valida o vínculo e as permissões antes de baixar/transcrever, usando as credenciais Meta e OpenAI já cadastradas. Mantenha no Cash o acesso Meta ao mesmo número atendido pelo Hub, mesmo após mudar o webhook. O Hub não baixa nem transcreve a mídia. O texto da resposta visível entra no contexto curto para orientar uma correção posterior por texto, sem fornecer ao modelo de consolidação a referência ou o arquivo de áudio. Day, Calendar e comandos de conexão continuam por texto nesta versão.

O Hub assume o envio das respostas e do indicador de digitação. Correções usam a sessão e o rascunho existentes do Cash. Somente o botão Confirmar atual grava um lançamento; texto, voz e botões de revisões anteriores não confirmam. Falhas de transcrição retornam orientação sem executar uma operação financeira. A fila persiste a referência cifrada, sem guardar o arquivo de áudio.

A ponte aguarda até 240 segundos para mensagens (download, transcrição e assistente), sem repetir automaticamente uma chamada cujo resultado seja incerto. Configure o proxy do Cash para comportar essa duração e permita até 300 segundos para encerramento do Hub durante uma atualização. Consultas curtas continuam com limite de 45 segundos.

### Day

Siga `C:\dev\equinox\zenit-day\docs\ZENIT_HUB.md`.

É preciso aplicar a migração local de proteção OAuth, publicar a página `/oauth/consent` do Day e habilitar o servidor OAuth no projeto Supabase. Registre o Hub como cliente confidencial (`client_secret_basic`) com callback exato `HUB_PUBLIC_URL/oauth/day/callback`.

Configure `DAY_SUPABASE_URL`, chave **publicável**, `DAY_CLIENT_ID` e `DAY_CLIENT_SECRET` no Hub. A senha do usuário é enviada pelo navegador diretamente ao Auth do Day. O Hub recebe somente a autorização OAuth. Não use `service_role` ou chave secreta administrativa. O Hub testa a capacidade `zenit_day_hub_connection_check` antes de aceitar a conexão.

As consultas retornam somente dados sincronizados; alterações offline ainda não enviadas pelo Day não aparecem.

### Calendar

Registre um cliente OAuth web no Google Cloud com callback exato `HUB_PUBLIC_URL/oauth/calendar/callback`, habilite Calendar API e configure a tela de consentimento e os usuários de teste ou publicação conforme o ambiente. Configure `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` no Hub.

Escopos: identidade/e-mail, leitura dos eventos e da lista de agendas. A agenda padrão é `primary`; o assistente pode listar outras agendas autorizadas. As consultas exigem datas ISO com fuso e sinalizam resultados limitados. Eventos ainda não podem ser criados nesta versão.

### IA e WhatsApp

Configure `OPENAI_API_KEY` e `OPENAI_MODEL` para consultas entre aplicações. Os comandos de conexão não usam IA. Se somente Cash estiver conectado, usa-se a configuração de IA já existente no Cash.

No piloto, configure `HUB_ALLOWED_SENDERS` com os identificadores permitidos. Defina no Hub as credenciais do número WhatsApp, App Secret e token de verificação. A versão da Graph API é configurável e deve ser a mesma validada no ambiente. A migração não modifica a configuração da Meta automaticamente.

## Uso

- `conexões`: lista as conexões e apresenta botões.
- `conectar Day`, `conectar Calendar`: link temporário; login/autorização no provedor; confirmação final na conversa.
- `conectar Cash`: orienta a usar o vínculo do Cash. O QR Code existente já pode ser enviado ao número que o Hub atende.
- `desconectar Day`, `desconectar Calendar`: elimina os tokens locais, os links pendentes e o histórico do Hub. A autorização concedida no provedor pode ser revogada também na conta de origem.
- `desconectar Cash`: remove o vínculo no Cash e desabilita seu uso no Hub.
- `cash: ...`: encaminha explicitamente ao assistente financeiro.
- Perguntas como “Quais contas vencem nesta semana?”, “Quais tarefas estão pendentes?” e “Tenho compromissos amanhã?” usam as conexões autorizadas.
- Áudio: inicia ou corrige pedidos financeiros no Cash. Respostas e confirmação continuam por texto/botões; perguntas ao Day e Calendar devem ser digitadas.

## Migração e operação

O código da ponte incorpora a funcionalidade de áudio do Cash (`8aa502a`). A junção é local; a versão publicada somente com áudio ainda não inclui a ponte do Hub. Mantenha o webhook no Cash até publicar a ponte e concluir o piloto abaixo.

1. Publique o código da ponte Cash mantendo o webhook atual e configure os conectores em ambiente de teste.
2. Valide com um número de teste: QR/vínculo Cash, consulta, áudio inicial, correção por novo áudio, rejeição de confirmação por voz/texto e por botão antigo, confirmação pelo botão revisado e reentrega sem duplicação; conecte Day/Google com contas próprias; teste desconexão e permissões.
3. Depois da validação, troque o callback Meta para `HUB_PUBLIC_URL/webhooks/whatsapp`. Um único serviço deve receber cada evento. O número e os vínculos Cash existentes são preservados.
4. Em rollback, volte o callback ao Cash. Day/Calendar ficam indisponíveis naquele canal, e o fluxo financeiro continua no backend anterior. Preserve o banco e a chave do Hub.

O Hub não repete automaticamente uma operação interrompida nem um envio cujo resultado seja incerto. Registros `uncertain` exigem conferência operacional para evitar duplicar efeitos. Uma operação aceita remotamente antes de um timeout pode ter sido concluída. IDs e erros genéricos permitem diagnosticar sem imprimir credenciais. Mídias diferentes de áudio e notificações proativas não fazem parte desta versão. Confirmações de entrega não são sincronizadas de volta aos registros antigos do Cash.

## Validação

`npm run check` testa assinatura, destino do webhook, fila, repetição, criptografia, isolamento por remetente, OAuth/PKCE, CSRF, confirmação final, renovação de tokens, consultas entre domínios, encaminhamento de áudio, indicador de digitação e ingressos HTTP reais com serviços externos simulados. O teste de integração `assistant-runtime` no Cash percorre os dois caminhos (webhook anterior e ponte Hub), incluindo correção por áudio e exatamente um lançamento após o botão revisado.

Os testes não equivalem à validação com credenciais Google/Meta/Supabase reais. A ativação exige configurar os serviços acima e executar o piloto antes de trocar o webhook de produção.

## Referências do protocolo

- [Google OAuth web server](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Supabase OAuth server](https://supabase.com/docs/guides/auth/oauth-server/getting-started)
- [Supabase token security](https://supabase.com/docs/guides/auth/oauth-server/token-security)
- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)
