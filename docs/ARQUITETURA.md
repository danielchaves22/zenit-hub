# Arquitetura do Zenit Hub

Revisão documental: 02/10/2026. O Hub coordena o canal e as conexões; os dados de domínio permanecem nas aplicações de origem.

```text
WhatsApp → webhook Hub → fila PostgreSQL → interpretação/roteamento
                                         ├─ Cash: ponte assinada
                                         ├─ Day: OAuth, RLS e RPCs
                                         └─ Google Calendar: OAuth
                                     → resposta persistida → WhatsApp

Worker → assinaturas e ocorrências autorizadas → template Meta → entrega
```

## Quem faz o quê

| Componente | Responsabilidade                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| Hub        | Canal, conexão de contas, contexto curto, escolha de ferramentas, prévias de Calendar/lembretes, assinaturas e entrega |
| Cash       | Identidade vinculada ao WhatsApp, permissões financeiras, cálculos, lançamentos e assistente financeiro                |
| Day        | Assuntos, regras de lembretes, recorrência, sincronização e autorização delegada                                       |
| Calendar   | Calendários, eventos e permissões de leitura/escrita concedidas pela conta Google                                      |
| Meta       | Transporte WhatsApp, aprovação de templates e estados de entrega                                                       |

Cada conta é autorizada separadamente. O Hub não ganha acesso ao Cash por receber um número de telefone: a ponte verifica o vínculo criado no Cash e suas permissões em cada operação. No Day, assuntos são somente leitura e lembretes exigem consentimento adicional. No Calendar, a autorização OAuth continua limitada às agendas e aos papéis da conta.

## Conversa e IA

Comandos de conexão e catálogo de notificações têm tratamento próprio. O áudio é transcrito uma vez no Hub com contexto neutro; o texto resultante entra no mesmo fluxo das mensagens digitadas. A seleção de ferramentas entre domínios ocorre no Hub. O caminho somente Cash e o prefixo cash: preservam o assistente financeiro do Cash, que ainda usa sua própria IA. Portanto, a inteligência financeira ainda não foi inteiramente extraída para o Hub.

Consultas de gastos realizados recebem totais calculados no Cash; a IA não precisa somar lançamentos paginados. Período, categorias e origem fixa são filtros explícitos. Escritas financeiras seguem o rascunho e o botão atual do Cash. Calendar e gestão de lembretes têm prévias próprias; texto/voz não substituem os botões de confirmação de operações.

## Persistência e execução

PostgreSQL guarda conexões, vínculos temporários, filas, histórico curto, rascunhos e estado de notificações. Credenciais e conteúdo sensível usam AES-256-GCM. Não há cópia integral das bases financeiras, dos assuntos ou da agenda. A chave HUB_ENCRYPTION_KEY deve permanecer recuperável junto ao backup do banco.

As migrações SQL são controladas pelo próprio projeto em [src/migrations.ts](../src/migrations.ts), com registro em hub_schema_migrations; o Hub não usa Prisma. A sequência atual inclui base operacional (1), calendar_drafts (2) e notificações (3). npm run db:migrate aplica as versões; a inicialização apenas verifica a compatibilidade. A primeira migração recusa schema já ocupado.

O webhook valida assinatura/destino e persiste antes de responder 202. Um worker serial usa bloqueio de sessão PostgreSQL para evitar concorrência entre processos durante deploys. A entrega de notificações usa esse mesmo processo; não exige cron separado no Day ou no Render. IDs de mensagens e ocorrências impedem repetição. Operações com resultado incerto não são reenviadas automaticamente.

O histórico conversacional fica limitado a 12 mensagens por pessoa e 24 horas. Isso não é uma promessa de retenção universal para todas as tabelas: filas, rascunhos, assinaturas e recibos têm finalidades próprias. Veja o código e [Operação](OPERACAO.md) antes de alterar a limpeza de dados.

## Onde manter os detalhes

- [Conectores](CONECTORES.md): autorização, credenciais, limites e confirmação.
- [Notificações](NOTIFICACOES.md): assinatura, recorrência, resumo diário, idempotência e templates.
- [Render](RENDER.md): configuração e publicação.
- [Operação](OPERACAO.md): migração, rollback e validação.
