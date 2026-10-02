# Publicação do Zenit Hub no Render

## Registro da implantação inicial (30/09/2026)

Os parágrafos desta seção registram verificações feitas naquela implantação; não equivalem a uma nova checagem de saúde. Configuração revisada documentalmente em 02/10/2026. O serviço está publicado em `https://zenit-hub.onrender.com`, no plano `0.5c-512mb` (US$ 7/mês), na região Oregon. Naquela implantação, a base `zenit_hub` estava na versão 2, incluindo `calendar_drafts`. O pre-deploy, `/health`, a ponte assinada com o Cash (`9ddc456`) e a autenticação do webhook foram validados no ambiente publicado. O callback WhatsApp do app Meta foi alterado para `https://zenit-hub.onrender.com/webhooks/whatsapp`; a Meta aceitou a verificação e a assinatura de `messages` foi preservada na versão v25.0.

O serviço foi criado pelo formulário, sem associação a Blueprint. O prazo de encerramento de 300 segundos foi aplicado e confirmado pelo CLI oficial do Render. Auto-deploy permanece desabilitado. Calendar e IA de consolidação estão configurados; o fluxo Cash mantém sua IA existente. O usuário confirmou o funcionamento da conexão Calendar e do teste de evento pelo WhatsApp. A página de autorização do Day está publicada, o cliente OAuth foi cadastrado e as quatro variáveis do conector foram salvas no Hub. A proteção de somente leitura foi aplicada e testada no Supabase; a conexão pessoal do Day ainda aguarda validação pelo WhatsApp.

Existe também um callback específico da conta WhatsApp (WABA), que prevalece sobre o endereço geral do app. Ambos foram atualizados para o Hub. A consulta `GET /PHONE_NUMBER_ID?fields=webhook_configuration` confirmou os campos `application` e `whatsapp_business_account` com o endereço do Hub.

O teste real de `conexões` passou após essa correção: uma entrada `done`, uma saída `sent`, menu Zenit Hub com os três botões e Cash conectado pelo vínculo existente. O usuário confirmou o recebimento e depois validou consultas financeiras e novos lançamentos. O Hub agora transcreve áudios antes de selecionar o conector; voz e texto usam o mesmo contexto e as mesmas capacidades.

Para rollback do canal, restaure **nos dois níveis, app e WABA**, o callback anterior `https://zenit-esmn.onrender.com/api/webhooks/whatsapp`, usando o mesmo token de verificação já existente. O callback WABA é configurado por `POST /WABA_ID/subscribed_apps`, com `override_callback_uri` e `verify_token`, autenticado pelo token do próprio app. Preserve a base e a chave do Hub. O Cash mantém seu endpoint anterior ativo.

## Configuração de referência

Para novas implantações, siga as seções abaixo e o [Blueprint](../render.yaml). O valor do plano e o estado descritos no registro inicial são históricos; confira a configuração e o preço no painel antes de criar recursos. Para habilitar notificações, configure também os [templates e consentimentos](NOTIFICACOES.md).

## Serviço e armazenamento

O Hub é um **Web Service Node**, com uma única instância. Não é um Static Site. O worker roda no mesmo processo e o estado fica na base PostgreSQL `zenit_hub`, separada da base `zenit` do Cash.

Use o PostgreSQL já existente no Render, na região Oregon. Não é necessário disco persistente no Web Service nem outra instância de PostgreSQL. Compartilhar a instância mantém CPU, memória, armazenamento e limite de conexões compartilhados; as tabelas ficam separadas.

| Campo              | Valor                                                                   |
| ------------------ | ----------------------------------------------------------------------- |
| Nome               | `zenit-hub`                                                             |
| Runtime            | Node                                                                    |
| Node               | `>=22.14.0 <23`                                                         |
| Plano              | Pago de `0.5 CPU / 512 MB` (`0.5c-512mb`) como ponto de partida         |
| Região             | Oregon, mesma região da instância PostgreSQL                            |
| Root Directory     | Raiz do repositório do Hub                                              |
| Build Command      | `npm ci --include=dev && npm run typecheck && npm run build`            |
| Pre-Deploy Command | `npm run db:migrate`                                                    |
| Start Command      | `npm start`                                                             |
| Health Check Path  | `/health`                                                               |
| Instâncias         | `1`                                                                     |
| Disco              | Nenhum                                                                  |
| Auto Deploy        | Desabilitado durante o piloto                                           |
| Encerramento       | `maxShutdownDelaySeconds: 300`, aplicado pelo CLI/API ou pelo Blueprint |

O Render fornece `PORT`; não copie `PORT=3210` do arquivo local. O servidor usa `HUB_HOST=0.0.0.0` para aceitar o tráfego da plataforma. A base PostgreSQL já deve existir. O pre-deploy aplica as migrações versionadas; `npm start` apenas verifica a versão e inicia. Se a migração falhar, o deploy deve parar. O build não acessa o banco.

Mantenha uma instância. Um bloqueio de sessão no PostgreSQL permite que apenas um worker processe a fila, inclusive durante a sobreposição de processos no deploy. A nova versão recebe webhooks e espera a anterior liberar o bloqueio. Não use PgBouncer em modo transaction para essa conexão. Operações interrompidas e envios incertos não são repetidos automaticamente.

## Criar pelo Blueprint ou manualmente

1. Publique os arquivos do projeto em um repositório Git acessível pelo Render, incluindo `package-lock.json` e `render.yaml`, sem `.env`, banco ou credenciais. Este guia não pressupõe um remote existente.
2. Para usar `render.yaml`, escolha **New > Blueprint** e selecione o repositório/branch. O arquivo propõe um serviço pago e reutiliza a base existente; revise os recursos e custos antes de aplicar. O Blueprint já usa `region: oregon`, a região do banco existente.
3. Preencha os campos solicitados. O Blueprint gera `HUB_ENCRYPTION_KEY`, `CASH_HUB_SHARED_SECRET` e `WHATSAPP_WEBHOOK_VERIFY_TOKEN` automaticamente. Preserve os valores gerados. Configure as variáveis dos conectores adicionais depois, em **Environment**.
4. Alternativamente, escolha **New > Web Service**, selecione o repositório, reproduza a tabela acima e adicione as variáveis abaixo manualmente. Não crie um serviço por cada método.
   Na criação manual, o `render.yaml` não é aplicado automaticamente. Configure o encerramento pelo CLI oficial já autenticado: `render services update SEU_SERVICE_ID --max-shutdown-delay 300 --output json`, ou pelo endpoint Update Service da API. Esse ajuste dá tempo para concluir uma mensagem de áudio durante atualizações.
5. Use a URL HTTPS efetivamente atribuída pelo Render em `HUB_PUBLIC_URL`. O nome escolhido pode não resultar exatamente em `https://zenit-hub.onrender.com`. Se o endereço atribuído for diferente do informado inicialmente, corrija Environment e faça novo deploy antes de usar os links OAuth.
6. Confira `https://SEU_HUB/health`: deve retornar `{"application":"zenit-hub","status":"ok"}`. Esse endpoint verifica processo e PostgreSQL; não testa as credenciais dos conectores.

## Conexão com a base existente

No painel da instância PostgreSQL, copie **Internal Database URL** para o `DATABASE_URL` do Hub. Troque somente o nome da base no caminho por `/zenit_hub`, preservando usuário, senha, host, porta e parâmetros. O painel pode mostrar a base original da instância; não use `/zenit` nem `/zenit_ycub` para o Hub. Não cole a URL com senha no Git ou no chat.

Exemplo apenas estrutural: `postgresql://USUARIO:SENHA@HOST_INTERNO:5432/zenit_hub`. Para acesso fora do Render, use a **External Database URL** apontando para `/zenit_hub` e TLS com `sslmode=verify-full`. A URL interna é para serviços na mesma região e rede privada.

O comando `npm run db:migrate` aplica as migrações versionadas registradas em `hub_schema_migrations`, em transação. A sequência atual inclui a base operacional, os rascunhos do Calendar e as notificações (versão 3). É seguro repeti-lo. Na primeira execução, recusa um schema com tabelas preexistentes. Nenhum dado do Cash é importado. Faça backup específico da base `zenit_hub` e preserve `HUB_ENCRYPTION_KEY`; não há migração automática de um SQLite anterior.

## Variáveis no serviço Hub

### Base

| Variável                | Valor / origem                                                                                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_VERSION`          | `>=22.14.0 <23`                                                                                                                                                                  |
| `NODE_ENV`              | `production`                                                                                                                                                                     |
| `HUB_HOST`              | `0.0.0.0`                                                                                                                                                                        |
| `HUB_PUBLIC_URL`        | Origem HTTPS pública, sem caminho; exemplo ilustrativo `https://zenit-hub.onrender.com`                                                                                          |
| `DATABASE_URL`          | Internal Database URL da instância existente, com o nome da base substituído por `zenit_hub`                                                                                     |
| `HUB_DATABASE_POOL_MAX` | `5` por processo; inclui a sessão reservada ao worker                                                                                                                            |
| `HUB_ENCRYPTION_KEY`    | 32 bytes aleatórios codificados em base64; gerada pelo Blueprint ou pelo comando abaixo                                                                                          |
| `HUB_TIME_ZONE`         | `America/Sao_Paulo`                                                                                                                                                              |
| `HUB_ALLOWED_SENDERS`   | Seu identificador WhatsApp, só dígitos, com DDI/DDD, conforme o remetente recebido pela Meta. Vários separados por vírgula. Vazio libera qualquer remetente que chegue ao número |

Para a criação manual, execute **localmente** o comando a seguir uma vez para cada segredo novo. Cada execução produz um valor diferente; cole diretamente no campo correspondente do Render e guarde em local seguro. Não coloque os valores no Git ou no chat.

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Não troque `HUB_ENCRYPTION_KEY` a cada deploy. A mesma chave é necessária para abrir as conexões já salvas e restaurar backups. O mecanismo de geração do Blueprint só gera um valor quando a variável ainda não existe.

### Cash e WhatsApp

| Variável                        | Valor / origem                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------- |
| `CASH_API_URL`                  | Origem HTTPS do **backend** Cash, sem `/api`; a ponte já acrescenta `/api/integrations/hub/bridge` |
| `CASH_HUB_SHARED_SECRET`        | Segredo de pelo menos 32 caracteres, **idêntico no Hub e no backend Cash**                         |
| `CASH_BINDING_PREFIX`           | Mesmo valor do `WHATSAPP_BINDING_MESSAGE_PREFIX` do Cash; padrão `VINCULAR ZENIT`                  |
| `CASH_CONNECT_URL`              | Opcional: página do Cash onde o usuário gera o QR Code                                             |
| `WHATSAPP_API_VERSION`          | Mesma versão da Graph API já validada no Cash                                                      |
| `WHATSAPP_PHONE_NUMBER_ID`      | ID do número na Meta; não é o telefone em formato `+55...`                                         |
| `WHATSAPP_ACCESS_TOKEN`         | Token Meta válido com acesso ao mesmo número usado pelo Cash                                       |
| `WHATSAPP_APP_SECRET`           | App Secret do app Meta que assina o webhook                                                        |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Segredo escolhido/gerado para verificar o novo callback; informar o mesmo na Meta                  |

Publique a versão do backend Cash que contém a ponte do Hub. O deploy de áudio isolado não contém essa ponte. Adicione `CASH_HUB_SHARED_SECRET` no serviço **Cash** e mantenha suas credenciais Meta/OpenAI para o assistente financeiro e o caminho direto de compatibilidade. No ingresso atual, o Hub baixa e transcreve o áudio uma única vez e envia texto ao Cash. Hub e Cash podem compartilhar as credenciais Meta do mesmo app/número. Não use a chave de criptografia do Hub como segredo da ponte.

O código aceita apenas HTTPS para um backend Cash remoto. Portanto, nesta versão, use a origem pública HTTPS do Cash, mesmo se ambos estiverem no Render. A chamada de uma mensagem aguarda até 240 segundos; confira também qualquer proxy adicional na frente do Cash.

### IA para consultas entre aplicações

| Variável                  | Valor / origem                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`          | Chave de um projeto OpenAI com acesso à API                                                                 |
| `OPENAI_MODEL`            | ID explícito de um modelo disponível na sua conta, compatível com Responses API e function calling          |
| `OPENAI_REASONING_EFFORT` | Opcional, deve ser suportado pelo modelo; `none` preserva a configuração econômica do Cash com `gpt-6-luna` |

Essas variáveis habilitam interpretação e consolidação no Hub. Com somente Cash conectado, mensagens financeiras usam o assistente do Cash. Para áudio, configure também `WHATSAPP_TRANSCRIPTION_MODEL` (opcional, padrão `gpt-transcribe`). A transcrição usa `OPENAI_API_KEY` e as credenciais Meta **do Hub**; a chave precisa ter acesso ao endpoint de transcrição. O Hub não importa automaticamente as configurações de IA armazenadas no Cash. Não há migração de banco nem alteração no webhook para ativar esse fluxo. Referência: [transcrição de arquivos na OpenAI](https://developers.openai.com/api/docs/guides/speech-to-text).

Após publicar, teste uma pergunta de agenda por áudio, um complemento por voz e uma continuação digitada. Teste também áudio com apenas Day ou Calendar conectado, rascunho financeiro e correção por voz, e preparação de evento seguida de confirmação **pelo botão**. Uma falha de transcrição deve orientar nova tentativa/texto sem encaminhar a mensagem ao Cash nem executar operações. Nunca reenvie automaticamente áudios antigos para validar uma implantação.

### Google Calendar

No Google Cloud, habilite a Google Calendar API, configure a tela de consentimento e crie um cliente OAuth **Web application**. Cadastre exatamente o callback `https://SEU_HUB/oauth/calendar/callback`. Use como `SEU_HUB` a origem escolhida em `HUB_PUBLIC_URL`.

Configure no Render do Hub:

| Variável               | Valor / origem                 |
| ---------------------- | ------------------------------ |
| `GOOGLE_CLIENT_ID`     | Client ID do cliente OAuth web |
| `GOOGLE_CLIENT_SECRET` | Secret desse cliente           |

O Hub solicita `openid`, `email`, `calendar.events` (consulta, criação, alteração e exclusão de eventos) e `calendar.calendarlist.readonly`. Não solicita administração nem compartilhamento de agendas. Em modo de teste, inclua sua conta entre os usuários de teste. Para aplicativos externos em status Testing, o Google emite refresh tokens que expiram em sete dias com esses escopos; trate esse modo como piloto, não como configuração definitiva de uso diário. A publicação/verificação da tela de consentimento depende da configuração do projeto Google.

#### Uso contínuo do Calendar

- Em **Google Auth Platform > Público-alvo**, mantenha o tipo **Externo** e publique o aplicativo para mudar de **Em teste** para **Em produção**. Contas Gmail pessoais não podem usar um aplicativo restrito à organização Workspace.
- Em **Acesso a dados**, declare somente `openid`, `https://www.googleapis.com/auth/userinfo.email`, `https://www.googleapis.com/auth/calendar.events` e `https://www.googleapis.com/auth/calendar.calendarlist.readonly`. `userinfo.email` é a representação do escopo `email` usado pelo Hub. O Hub não usa Gmail, `calendar.readonly` nem `calendar.freebusy`.
- Mantenha a apresentação pública em `https://zenitapp.net/hub` e a política em `https://zenitapp.net/privacy`. A página de conexão informa o uso de dados de agenda pela OpenAI e pelo WhatsApp antes da autorização.
- O modo de produção remove a regra de sete dias para novas autorizações. Após publicar, cada usuário deve enviar **conectar Calendar**, autorizar novamente no Google e confirmar **Conectar** no WhatsApp. Não é preciso desconectar antes: a conexão anterior é substituída apenas após a confirmação. Tokens emitidos durante o teste não devem ser considerados convertidos automaticamente.
- O Hub já solicita `access_type=offline`, guarda o refresh token criptografado e renova o access token antes do vencimento durante o uso. Não se deve criar um cron para renovar consentimentos nem alterar `HUB_ENCRYPTION_KEY` ou o client ID nessa transição.
- Produção não equivale a verificação pelo Google. Para uso pessoal por um grupo limitado, a exceção de verificação permite continuar com o aviso de aplicativo não verificado e o limite aplicável de usuários. Uma distribuição pública ampla exige a verificação de marca, dos escopos e dos domínios; isso pode exigir demonstração do fluxo e domínio próprio para o callback.
- Publicar permite autorizações além da antiga lista de usuários de teste. Se for necessário limitar quem inicia conversas no Hub, configure `HUB_ALLOWED_SENDERS` explicitamente; a lista de teste do Google deixa de ser esse controle.
- A autorização ainda pode ser revogada pelo usuário ou expirar por outras políticas do Google, inatividade ou limites de tokens. Nesses casos, o usuário precisa reconectar; “uso contínuo” não significa acesso irrevogável.

Referências: [público e status de publicação](https://support.google.com/cloud/answer/15549945?hl=en), [exceção para uso pessoal](https://support.google.com/cloud/answer/13464323?hl=en) e [expiração de refresh tokens](https://developers.google.com/identity/protocols/oauth2#expiration).

A migração 2 cria `calendar_drafts`, sem alterar dados das aplicações de origem. O pre-deploy já executa `npm run db:migrate`; não é preciso aplicar SQL manualmente. Preserve `HUB_ENCRYPTION_KEY`. Após atualizar, conexões antigas de Calendar devem ser autorizadas novamente para conceder escrita. No piloto, valide leitura, criação, edição e exclusão de um evento de teste, sempre revisando a prévia e usando o botão. Confira também cancelamento e clique repetido. Não use compromissos reais de terceiros para esses testes.

### Zenit Day

O conector usa o Supabase já existente do Day. Ele não cria um novo banco para tarefas.

1. Aplique no projeto Day a migração `20260930171741_hub_oauth_read_only.sql`, após as migrações anteriores. Ela impede escritas com tokens OAuth de terceiros. Já foi aplicada e validada no projeto hospedado em 30/09/2026; a versão do arquivo local acompanha o histórico remoto. Não habilite o conector sem essa proteção.
2. Publique o frontend web do Day em HTTPS com acesso a `/oauth/consent`. Se o Day estiver apenas em Tauri, essa página ainda precisará de hospedagem web; ela pode usar um **Static Site** separado no Render.
3. No Supabase do Day, habilite **Authentication > OAuth Server**. Configure **Site URL** para a origem web do Day e **Authorization Path** como `/oauth/consent`. Mantenha registro dinâmico desabilitado no piloto.
4. Registre o Hub como cliente **Confidential**, com autenticação `client_secret_basic` e callback exato `https://SEU_HUB/oauth/day/callback`.
5. Antes de gerar o frontend web do Day, configure `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_HUB_CLIENT_ID` e `VITE_HUB_PUBLIC_URL`. O `VITE_HUB_CLIENT_ID` é o mesmo `DAY_CLIENT_ID` do Hub. Não inclua o secret no frontend.
6. No Hub, configure os cinco valores abaixo. Em seguida, faça novo deploy.

| Variável                       | Valor / origem                                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `DAY_SUPABASE_URL`             | `https://SEU_PROJETO.supabase.co`                                                                                      |
| `DAY_SITE_URL`                 | Origem HTTPS da tela de consentimento, igual ao Site URL do Supabase; neste ambiente, `https://zenit-day.onrender.com` |
| `DAY_SUPABASE_PUBLISHABLE_KEY` | Chave pública `sb_publishable_...`; não usar `service_role` ou chave secreta administrativa                            |
| `DAY_CLIENT_ID`                | Client ID do Hub registrado no OAuth Server do Day                                                                     |
| `DAY_CLIENT_SECRET`            | Secret desse cliente confidencial, somente no backend Hub                                                              |

O Static Site do Day está em `https://zenit-day.onrender.com` (`srv-dauke459fdbs739acepg`): build `npm ci --include=dev && npm run build`, diretório publicado `dist`, rewrites `/oauth/consent` → `/index.html` e `/hub/reminders` → `/index.html`, e cabeçalho `Referrer-Policy: no-referrer` em `/*`. Usa Node 22, `SKIP_INSTALL_DEPS=true` e auto-deploy desabilitado. As variáveis públicas foram definidas **no build** desse site. O cliente OAuth confidencial usa `client_secret_basic`, callback exato `https://zenit-hub.onrender.com/oauth/day/callback` e registro dinâmico desabilitado. Os detalhes de autorização e validação estão em `zenit-day/docs/ZENIT_HUB.md`.

O Hub precisa permitir as duas origens do Day na política `form-action`: Supabase e site de consentimento. O navegador valida toda a sequência de redirecionamentos após o botão **Continuar**. Sem `DAY_SITE_URL`, o Chromium pode bloquear a navegação antes do login. Use a origem exata, sem caminhos nem curingas.

Você pode ativar os conectores gradualmente. Para deixar Day desabilitado, omita suas cinco variáveis, em vez de cadastrar URLs/chaves fictícias. O mesmo vale para as credenciais Google e de IA.

## Ordem de ativação do canal

1. Publique a ponte Cash e configure o segredo compartilhado, mantendo o callback Meta atual.
2. Publique o Hub com `DATABASE_URL` apontando para `zenit_hub`, pre-deploy `npm run db:migrate`, chave estável e allowlist do piloto. Valide `/health`.
3. Configure os clientes OAuth e publique a tela de consentimento do Day. Confira que cada callback usa exatamente o mesmo domínio de `HUB_PUBLIC_URL`.
4. Valide a nova rota com ambiente/número de teste e credenciais correspondentes. Se houver apenas o número atual, faça uma troca controlada e tenha o callback anterior disponível para retornar.
5. Na configuração do webhook WhatsApp do app Meta, use `https://SEU_HUB/webhooks/whatsapp` e o valor de `WHATSAPP_WEBHOOK_VERIFY_TOKEN` do Hub; mantenha a assinatura do campo `messages`. Não altere callbacks de outros produtos do app Meta.
   Confira também `webhook_configuration` do número. Se houver callback específico da conta (`whatsapp_business_account`) ou do número (`phone_number`), ele prevalece sobre o callback do app e também precisa apontar para o destino correto. Atualize somente a assinatura correspondente ao app/número em migração, sem remover as demais.
6. Envie `conexões`; teste Cash, áudio, correção e botão revisado. Envie `conectar Day`/`conectar Calendar`; autorize no navegador e confirme a conta no WhatsApp. Teste consultas e desconexão.
7. Reinicie o Hub em um momento sem operações pendentes e confira que as conexões persistem. Em falha do piloto, volte o callback ao Cash; preserve a base PostgreSQL e a chave do Hub.

O número WhatsApp e os vínculos Cash existentes são reutilizados. Não mantenha os dois serviços processando os mesmos eventos. Nenhuma configuração acima migra dados financeiros ou tarefas para o Hub.

## Referências

- [Render: Web Services e porta pública](https://render.com/docs/web-services)
- [Render: PostgreSQL e bases adicionais](https://render.com/docs/postgresql-creating-connecting#adding-multiple-databases-to-a-single-instance)
- [Render: comando pre-deploy](https://render.com/docs/deploys#pre-deploy-command)
- [Render: Blueprint e segredos gerados](https://render.com/docs/blueprint-spec)
- [Render: versão do Node](https://render.com/docs/node-version)
- [Render: variáveis e segredos](https://render.com/docs/configure-environment-variables)
- [Google: OAuth e expiração de refresh tokens](https://developers.google.com/identity/protocols/oauth2)
- [Supabase: configurar OAuth Server](https://supabase.com/docs/guides/auth/oauth-server/getting-started)
- [OpenAI: configuração de chave da API](https://developers.openai.com/api/docs/quickstart)
