# Zenit Hub

Backend de conexões para conversar com Cash, Day e Google Calendar pelo WhatsApp. Cada aplicação mantém seus dados e suas regras. O Hub coordena o canal, as autorizações independentes, as consultas e a entrega das notificações assinadas.

## Capacidades

- Consultas financeiras, inclusive gastos realizados com filtros, totais e média mensal; escritas continuam no fluxo confirmado do Cash.
- Consulta de assuntos do Day e gestão de lembretes com autorização adicional.
- Consulta, criação, alteração e exclusão de eventos comuns no Calendar, com prévia e confirmação.
- Texto e voz pelo mesmo fluxo; transcrição única no Hub.
- Catálogo de notificações, resumo diário e lembretes do Day, com assinatura explícita e templates configurados/aprovados.

Veja os [guias públicos](https://zenitapp.net/docs/help/zenit-hub/getting-started/) para uso. Conectar uma aplicação não ativa notificações automaticamente.

## Desenvolvimento local

Requer Node.js >=22.14 e <23 e PostgreSQL 14+. Use uma base exclusiva zenit_hub e uma instância do processo.

```powershell
npm ci
Copy-Item .env.example .env
# Preencha configurações locais e credenciais sem compartilhá-las.
npm run build
npm run db:migrate
npm start
```

DATABASE_URL é obrigatória; não aponte para a base do Cash. HUB_ENCRYPTION_KEY contém 32 bytes aleatórios em base64 e precisa permanecer estável, protegida junto aos backups. A primeira migração exige schema vazio. O servidor verifica a versão ao iniciar, sem aplicar migrações automaticamente.

Localmente, o endereço padrão é http://127.0.0.1:3210. GET /health verifica processo e PostgreSQL; não comprova que os provedores externos estão autorizados.

## Verificação

```powershell
docker compose -f compose.test.yaml up -d --wait
Copy-Item .env.test.example .env.test
npm run check
```

Os testes usam PostgreSQL local em base terminada em \_test, com schemas descartáveis. Nunca use a base do Render. OAuth, mensagens reais e aprovação/entrega de templates exigem validação separada.

## Documentação técnica

- [Arquitetura e responsabilidades](docs/ARQUITETURA.md)
- [Conectores e permissões](docs/CONECTORES.md)
- [Verificação Google e roteiro de demonstração](docs/GOOGLE_VERIFICATION.md)
- [Notificações e assinaturas](docs/NOTIFICACOES.md)
- [Publicação no Render](docs/RENDER.md) e [Blueprint](render.yaml)
- [Operação, rollback e testes](docs/OPERACAO.md)

Para consultar conexões no WhatsApp, envie conexões. Para o catálogo de assinaturas, envie notificações. Os detalhes de instalação de cada conector estão nos guias acima; nenhum segredo deve ir para o cliente, para a IA ou para o Git.
