# Notificações pelo WhatsApp

O catálogo é fornecido diretamente pelo Hub, sem depender da IA nem de respostas antigas no histórico. `notificações` e `Quais notificações posso receber?` mostram resumo diário, lembretes do Day, assinatura e disponibilidade do envio. O serviço não oferece uma opção como pronta sem o template configurado e aprovado na Meta.

## Uso

- `Quero o resumo diário às 7h com Cash, Day e Calendar`: prévia com horário, fuso e fontes; botão Confirmar ativa. Pedir outro horário/fontes substitui a assinatura após confirmação.
- `Ativar lembretes do Day`: verifica conexão e consentimento específico no Day. Se necessário, abre `DAY_SITE_URL/hub/reminders`. Autorizar a conta nessa página não assina o envio; volte ao WhatsApp e confirme a assinatura pelo botão.
- `Meus lembretes`, `Lembre-me toda quinta às 6h30 de levar o livro`, `Pause o lembrete do livro`: consulta/gestão pela IA com ferramentas do Day. Escritas exigem prévia e botão. Horários inválidos ou ausentes exigem esclarecimento.
- `Minhas assinaturas`: estado e últimos avisos. Aceito pelo WhatsApp não significa entregue; o webhook atualiza entregue/lido/falhou.
- `Cancelar resumo diário`, `cancelar lembretes do Day`, `parar notificações`: interrompem imediatamente o envio correspondente, invalidando prévias pendentes. Preservam os lembretes no Day. Pedir nova assinatura permite retomar.

O resumo usa a agenda principal do Calendar, contas pendentes vencendo na data local (total calculado pelo Cash) e assuntos do Day com prazo/retomada até hoje ou planejamento para hoje. Inclui indicação de prazos atrasados do Day. As seções são curtas; textos maiores indicam consultar os demais itens. Fonte indisponível é identificada, nunca interpretada como ausência de dados. Não usa IA a cada disparo. Alertas individuais de tarefas/eventos, adiamento de ocorrências e resumo semanal não fazem parte desta entrega.

## Persistência e autorização

Day mantém regras, texto, vínculo com assunto, estado e revisão dos lembretes. A migração `hub_reminder_consent` acrescenta consentimento revogável por usuário/cliente OAuth. Apenas sessão direta do Day pode conceder esse consentimento; JWT OAuth não pode se autoconceder permissão. A autorização antiga de assuntos não se expande. Assuntos e atualizações continuam somente para leitura. Dados offline aparecem depois da sincronização.

Hub mantém assinaturas, consentimento de envio, prévias e entregas em PostgreSQL (migração 3). Conteúdo e preferências são cifrados; índices operacionais usam remetente, tipo, estado e datas. Confirmações são vinculadas ao remetente e ao acesso vigente, com validade de dez minutos. A troca ou remoção de uma conexão pausa assinaturas desse remetente e invalida prévias, exigindo revisão das fontes antes de retomar.

O worker único existente consulta assinaturas a cada 30 segundos. O cálculo canônico de recorrência fica no Day. Cada entrega tem chave única por remetente, tipo e ocorrência; reinícios não repetem envios. Lembretes atrasados por mais de cinco minutos e resumos atrasados por mais de uma hora não são enviados. Atrasos nunca mudam a âncora da recorrência. Edição/pausa/revogação são revalidadas antes do envio. Quando não se sabe se a Meta aceitou uma mensagem, o estado fica incerto, sem reenvio automático. O usuário vê o resultado em `minhas assinaturas`.

## Configuração

1. Aplicar a migração do Day e cadastrar o `DAY_CLIENT_ID` existente em `zenit_day_private.reminder_clients` (configuração por ambiente; não é consentimento de usuário). Publicar a tela web do Day com `VITE_HUB_CLIENT_ID` já existente.
2. Publicar Hub; o pre-deploy executa `npm run db:migrate`. Manter uma instância paga sempre ativa; não há cron externo ou serviço novo.
3. Cadastrar **somente** os modelos descritos em `config/whatsapp-notifications.json` na conta que contém o número do Hub. A categoria solicitada é UTILITY, sujeita à avaliação da Meta.
4. Depois da aprovação, configurar `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_SUMMARY_TEMPLATE=zenit_resumo_diario_v1` e `WHATSAPP_REMINDER_TEMPLATE=zenit_lembrete_day_v1` no Hub. Idioma `pt_BR`. A credencial precisa de `whatsapp_business_management` para verificar aprovação e `whatsapp_business_messaging` para enviar.
5. Usuário autoriza Day e assina pelo WhatsApp. Nenhuma assinatura é criada durante instalação/deploy.

Os envios proativos usam sempre templates aprovados, inclusive quando a janela de atendimento estiver aberta. Isso evita depender de uma mensagem recente do usuário. A Meta pode cobrar, recategorizar, pausar ou rejeitar templates. O catálogo consulta o estado; falhas de configuração/aprovação impedem ativação, e o agendador revalida antes do envio. Referência: [Política WhatsApp](https://whatsappbusiness.com/policy/).

Testes cobrem catálogo da captura de tela, consentimento, troca de conta, idempotência, cancelamento, recorrência no Day, isolamento de dados, templates e recibos. Testes locais com conectores simulados não comprovam uma entrega real da Meta; o piloto só se completa após assinatura do usuário e uma ocorrência real.

As tabelas privadas de clientes/consentimentos têm RLS ativado e nenhum acesso direto concedido. O aviso informativo [RLS Enabled No Policy](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) é intencional nesse caso: somente as funções privadas com verificação explícita de identidade as acessam. Os endpoints públicos usam SECURITY INVOKER. A revisão após migração não acrescentou alertas de nível WARN.
