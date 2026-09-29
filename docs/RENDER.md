# Publicação do Zenit Hub no Render

Configuração verificada em 29/09/2026. Este guia prepara a publicação; nenhuma conta ou configuração de produção é modificada automaticamente pelos arquivos locais.

## Serviço e armazenamento

O Hub é um **Web Service Node**, com uma única instância. Não é um Static Site. O worker roda no mesmo processo e o estado fica na base PostgreSQL `zenit_hub`, separada da base `zenit` do Cash.

Use o PostgreSQL já existente no Render, na região Oregon. Não é necessário disco persistente no Web Service nem outra instância de PostgreSQL. Compartilhar a instância mantém CPU, memória, armazenamento e limite de conexões compartilhados; as tabelas ficam separadas.

| Campo | Valor |
| --- | --- |
| Nome | `zenit-hub` |
| Runtime | Node |
| Node | `>=22.14.0 <23` |
| Plano | Pago de `0.5 CPU / 512 MB` (`0.5c-512mb`) como ponto de partida |
| Região | Oregon, mesma região da instância PostgreSQL |
| Root Directory | Raiz do repositório do Hub |
| Build Command | `npm ci --include=dev && npm run typecheck && npm run build` |
| Pre-Deploy Command | `npm run db:migrate` |
| Start Command | `npm start` |
| Health Check Path | `/health` |
| Instâncias | `1` |
| Disco | Nenhum |
| Auto Deploy | Desabilitado durante o piloto |
| Encerramento | `maxShutdownDelaySeconds: 300` no Blueprint |

O Render fornece `PORT`; não copie `PORT=3210` do arquivo local. O servidor usa `HUB_HOST=0.0.0.0` para aceitar o tráfego da plataforma. A base PostgreSQL já deve existir. O pre-deploy aplica as migrações versionadas; `npm start` apenas verifica a versão e inicia. Se a migração falhar, o deploy deve parar. O build não acessa o banco.

Mantenha uma instância. Um bloqueio de sessão no PostgreSQL permite que apenas um worker processe a fila, inclusive durante a sobreposição de processos no deploy. A nova versão recebe webhooks e espera a anterior liberar o bloqueio. Não use PgBouncer em modo transaction para essa conexão. Operações interrompidas e envios incertos não são repetidos automaticamente.

## Criar pelo Blueprint ou manualmente

1. Publique os arquivos do projeto em um repositório Git acessível pelo Render, incluindo `package-lock.json` e `render.yaml`, sem `.env`, banco ou credenciais. Este guia não pressupõe um remote existente.
2. Para usar `render.yaml`, escolha **New > Blueprint** e selecione o repositório/branch. O arquivo propõe um serviço pago e reutiliza a base existente; revise os recursos e custos antes de aplicar. O Blueprint já usa `region: oregon`, a região do banco existente.
3. Preencha os campos solicitados. O Blueprint gera `HUB_ENCRYPTION_KEY`, `CASH_HUB_SHARED_SECRET` e `WHATSAPP_WEBHOOK_VERIFY_TOKEN` automaticamente. Preserve os valores gerados. Configure as variáveis dos conectores adicionais depois, em **Environment**.
4. Alternativamente, escolha **New > Web Service**, selecione o repositório, reproduza a tabela acima e adicione as variáveis abaixo manualmente. Não crie um serviço por cada método.
5. Use a URL HTTPS efetivamente atribuída pelo Render em `HUB_PUBLIC_URL`. O nome escolhido pode não resultar exatamente em `https://zenit-hub.onrender.com`. Se o endereço atribuído for diferente do informado inicialmente, corrija Environment e faça novo deploy antes de usar os links OAuth.
6. Confira `https://SEU_HUB/health`: deve retornar `{"application":"zenit-hub","status":"ok"}`. Esse endpoint verifica processo e PostgreSQL; não testa as credenciais dos conectores.

## Conexão com a base existente

No painel da instância PostgreSQL, copie **Internal Database URL** para o `DATABASE_URL` do Hub. Troque somente o nome da base no caminho por `/zenit_hub`, preservando usuário, senha, host, porta e parâmetros. O painel pode mostrar a base original da instância; não use `/zenit` nem `/zenit_ycub` para o Hub. Não cole a URL com senha no Git ou no chat.

Exemplo apenas estrutural: `postgresql://USUARIO:SENHA@HOST_INTERNO:5432/zenit_hub`. Para acesso fora do Render, use a **External Database URL** apontando para `/zenit_hub` e TLS com `sslmode=verify-full`. A URL interna é para serviços na mesma região e rede privada.

O comando `npm run db:migrate` cria as seis tabelas operacionais e o controle `hub_schema_migrations` em uma transação. É seguro repeti-lo. Na primeira execução, recusa um schema com tabelas preexistentes. Nenhum dado do Cash é importado. Faça backup específico da base `zenit_hub` e preserve `HUB_ENCRYPTION_KEY`; não há migração automática de um SQLite anterior.

## Variáveis no serviço Hub

### Base

| Variável | Valor / origem |
| --- | --- |
| `NODE_VERSION` | `>=22.14.0 <23` |
| `NODE_ENV` | `production` |
| `HUB_HOST` | `0.0.0.0` |
| `HUB_PUBLIC_URL` | Origem HTTPS pública, sem caminho; exemplo ilustrativo `https://zenit-hub.onrender.com` |
| `DATABASE_URL` | Internal Database URL da instância existente, com o nome da base substituído por `zenit_hub` |
| `HUB_DATABASE_POOL_MAX` | `5` por processo; inclui a sessão reservada ao worker |
| `HUB_ENCRYPTION_KEY` | 32 bytes aleatórios codificados em base64; gerada pelo Blueprint ou pelo comando abaixo |
| `HUB_TIME_ZONE` | `America/Sao_Paulo` |
| `HUB_ALLOWED_SENDERS` | Seu identificador WhatsApp, só dígitos, com DDI/DDD, conforme o remetente recebido pela Meta. Vários separados por vírgula. Vazio libera qualquer remetente que chegue ao número |

Para a criação manual, execute **localmente** o comando a seguir uma vez para cada segredo novo. Cada execução produz um valor diferente; cole diretamente no campo correspondente do Render e guarde em local seguro. Não coloque os valores no Git ou no chat.

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Não troque `HUB_ENCRYPTION_KEY` a cada deploy. A mesma chave é necessária para abrir as conexões já salvas e restaurar backups. O mecanismo de geração do Blueprint só gera um valor quando a variável ainda não existe.

### Cash e WhatsApp

| Variável | Valor / origem |
| --- | --- |
| `CASH_API_URL` | Origem HTTPS do **backend** Cash, sem `/api`; a ponte já acrescenta `/api/integrations/hub/bridge` |
| `CASH_HUB_SHARED_SECRET` | Segredo de pelo menos 32 caracteres, **idêntico no Hub e no backend Cash** |
| `CASH_BINDING_PREFIX` | Mesmo valor do `WHATSAPP_BINDING_MESSAGE_PREFIX` do Cash; padrão `VINCULAR ZENIT` |
| `CASH_CONNECT_URL` | Opcional: página do Cash onde o usuário gera o QR Code |
| `WHATSAPP_API_VERSION` | Mesma versão da Graph API já validada no Cash |
| `WHATSAPP_PHONE_NUMBER_ID` | ID do número na Meta; não é o telefone em formato `+55...` |
| `WHATSAPP_ACCESS_TOKEN` | Token Meta válido com acesso ao mesmo número usado pelo Cash |
| `WHATSAPP_APP_SECRET` | App Secret do app Meta que assina o webhook |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Segredo escolhido/gerado para verificar o novo callback; informar o mesmo na Meta |

Publique a versão do backend Cash que contém a ponte do Hub. O deploy de áudio isolado não contém essa ponte. Adicione `CASH_HUB_SHARED_SECRET` no serviço **Cash**, e mantenha lá as credenciais Meta/OpenAI existentes: ele ainda baixa e transcreve os áudios. Hub e Cash podem compartilhar as credenciais Meta do mesmo app/número. Não use a chave de criptografia do Hub como segredo da ponte.

O código aceita apenas HTTPS para um backend Cash remoto. Portanto, nesta versão, use a origem pública HTTPS do Cash, mesmo se ambos estiverem no Render. A chamada de uma mensagem aguarda até 240 segundos; confira também qualquer proxy adicional na frente do Cash.

### IA para consultas entre aplicações

| Variável | Valor / origem |
| --- | --- |
| `OPENAI_API_KEY` | Chave de um projeto OpenAI com acesso à API |
| `OPENAI_MODEL` | ID explícito de um modelo disponível na sua conta, compatível com Responses API e function calling |

Essas variáveis habilitam interpretação e consolidação no Hub. Com somente Cash conectado, mensagens financeiras usam o assistente do Cash. Áudios continuam usando as credenciais/modelo de transcrição configurados no Cash. O Hub não importa automaticamente as configurações de IA armazenadas no Cash.

### Google Calendar

No Google Cloud, habilite a Google Calendar API, configure a tela de consentimento e crie um cliente OAuth **Web application**. Cadastre exatamente o callback `https://SEU_HUB/oauth/calendar/callback`. Use como `SEU_HUB` a origem escolhida em `HUB_PUBLIC_URL`.

Configure no Render do Hub:

| Variável | Valor / origem |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Client ID do cliente OAuth web |
| `GOOGLE_CLIENT_SECRET` | Secret desse cliente |

O Hub solicita `openid`, `email`, `calendar.events.readonly` e `calendar.calendarlist.readonly`. Em modo de teste, inclua sua conta entre os usuários de teste. Para aplicativos externos em status Testing, o Google emite refresh tokens que expiram em sete dias com esses escopos; trate esse modo como piloto, não como configuração definitiva de uso diário. A publicação/verificação da tela de consentimento depende da configuração do projeto Google.

### Zenit Day

O conector usa o Supabase já existente do Day. Ele não cria um novo banco para tarefas.

1. Aplique no projeto Day a migração `20260929162635_hub_oauth_read_only.sql`, após as migrações anteriores. Ela impede escritas com tokens OAuth de terceiros. Não habilite o conector sem essa proteção.
2. Publique o frontend web do Day em HTTPS com acesso a `/oauth/consent`. Se o Day estiver apenas em Tauri, essa página ainda precisará de hospedagem web; ela pode usar um **Static Site** separado no Render.
3. No Supabase do Day, habilite **Authentication > OAuth Server**. Configure **Site URL** para a origem web do Day e **Authorization Path** como `/oauth/consent`. Mantenha registro dinâmico desabilitado no piloto.
4. Registre o Hub como cliente **Confidential**, com autenticação `client_secret_basic` e callback exato `https://SEU_HUB/oauth/day/callback`.
5. Antes de gerar o frontend web do Day, configure `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_HUB_CLIENT_ID` e `VITE_HUB_PUBLIC_URL`. O `VITE_HUB_CLIENT_ID` é o mesmo `DAY_CLIENT_ID` do Hub. Não inclua o secret no frontend.
6. No Hub, configure os quatro valores abaixo. Em seguida, faça novo deploy.

| Variável | Valor / origem |
| --- | --- |
| `DAY_SUPABASE_URL` | `https://SEU_PROJETO.supabase.co` |
| `DAY_SUPABASE_PUBLISHABLE_KEY` | Chave pública `sb_publishable_...`; não usar `service_role` ou chave secreta administrativa |
| `DAY_CLIENT_ID` | Client ID do Hub registrado no OAuth Server do Day |
| `DAY_CLIENT_SECRET` | Secret desse cliente confidencial, somente no backend Hub |

Para um Static Site do Day: build `npm ci && npm run build`, diretório publicado `dist`, e rewrite `/*` → `/index.html` para servir `/oauth/consent`. Confirme que as variáveis públicas foram definidas **no build** desse site. Os detalhes de autorização e validação estão em `zenit-day/docs/ZENIT_HUB.md`.

Você pode ativar os conectores gradualmente. Para deixar Day desabilitado, omita suas quatro variáveis, em vez de cadastrar URLs/chaves fictícias. O mesmo vale para as credenciais Google e de IA.

## Ordem de ativação do canal

1. Publique a ponte Cash e configure o segredo compartilhado, mantendo o callback Meta atual.
2. Publique o Hub com `DATABASE_URL` apontando para `zenit_hub`, pre-deploy `npm run db:migrate`, chave estável e allowlist do piloto. Valide `/health`.
3. Configure os clientes OAuth e publique a tela de consentimento do Day. Confira que cada callback usa exatamente o mesmo domínio de `HUB_PUBLIC_URL`.
4. Valide a nova rota com ambiente/número de teste e credenciais correspondentes. Se houver apenas o número atual, faça uma troca controlada e tenha o callback anterior disponível para retornar.
5. Na configuração do webhook WhatsApp do app Meta, use `https://SEU_HUB/webhooks/whatsapp` e o valor de `WHATSAPP_WEBHOOK_VERIFY_TOKEN` do Hub; mantenha a assinatura do campo `messages`. Não altere callbacks de outros produtos do app Meta.
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
