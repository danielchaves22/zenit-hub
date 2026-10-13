# Notificações pelo WhatsApp

O catálogo é fornecido diretamente pelo Hub, sem depender da IA nem de respostas antigas no histórico. `notificações` e `Quais notificações posso receber?` mostram resumo diário, lembretes do Day, assinatura e disponibilidade do envio. O serviço não oferece uma opção como pronta sem o template configurado e aprovado na Meta.

## Uso

- `Quero o resumo diário às 7h com Cash, Day e Calendar`: prévia com horário, fuso e fontes; botão Confirmar ativa. Pedir outro horário/fontes substitui a assinatura após confirmação.
- `Ativar lembretes do Day`: verifica conexão e consentimento específico no Day. Se necessário, abre `DAY_SITE_URL/hub/reminders`. Autorizar a conta nessa página não assina o envio; volte ao WhatsApp e confirme a assinatura pelo botão.
- `Meus lembretes`, `Lembre-me toda quinta às 6h30 de levar o livro`, `Pause o lembrete do livro`: consulta/gestão pela IA com ferramentas do Day. Escritas exigem prévia e botão. Horários inválidos ou ausentes exigem esclarecimento.
- `Minhas assinaturas`: estado, problemas de acesso e últimos avisos, incluindo o motivo de um envio não realizado. Aceito pelo WhatsApp não significa entregue; o webhook atualiza entregue/lido/falhou.
- `Cancelar resumo diário`, `cancelar lembretes do Day`, `parar notificações`: interrompem imediatamente o envio correspondente, invalidando prévias pendentes. Preservam os lembretes no Day. Pedir nova assinatura permite retomar.

O resumo usa a agenda principal do Calendar, contas pendentes vencendo na data local (total calculado pelo Cash) e assuntos do Day com prazo/retomada até hoje ou planejamento para hoje. Inclui indicação de prazos atrasados do Day. As seções são curtas; textos maiores indicam consultar os demais itens. Fonte indisponível é identificada, nunca interpretada como ausência de dados. Não usa IA a cada disparo. Alertas individuais de tarefas/eventos, adiamento de ocorrências e resumo semanal não fazem parte desta entrega.

## Persistência e autorização

Day mantém regras, texto, vínculo com assunto, estado e revisão dos lembretes. A migração `hub_reminder_consent` acrescenta consentimento revogável por usuário/cliente OAuth. Apenas sessão direta do Day pode conceder esse consentimento; JWT OAuth não pode se autoconceder permissão. A autorização antiga de assuntos não se expande. Assuntos e atualizações continuam somente para leitura. Dados offline aparecem depois da sincronização.

Hub mantém assinaturas, consentimento de envio, prévias e entregas em PostgreSQL (migração 3), além do estado de problemas de acesso (migração 5). Conteúdo e preferências são cifrados; os problemas guardam somente códigos operacionais e datas, sem respostas dos provedores ou credenciais. Confirmações são vinculadas ao remetente e ao acesso vigente, com validade de dez minutos.

O acesso OAuth é renovado automaticamente, sem pausar assinaturas. Se for necessário enviar `conectar Day` novamente, confirmar **a mesma conta** preserva assinaturas, consentimento, horários, pausas voluntárias e a identificação das ocorrências já enviadas. A identidade é o ID da conta no provedor; mudanças de e-mail não são tratadas como troca de conta. Não é necessário desconectar primeiro. Trocar de conta ou desconectar pausa **apenas as assinaturas que usam aquela fonte**, exige nova confirmação para elas e mantém as demais. Reconectar não reativa uma assinatura já pausada. Prévias de alterações pendentes continuam sendo invalidadas pela reconexão.

## Problemas de acesso

O Hub verifica também o consentimento específico do Day antes de consultar ocorrências, inclusive quando não há lembretes no horário. Uma assinatura pode continuar autorizada pelo usuário e estar com o **envio interrompido**:

- Acesso expirado ou revogado: o chat orienta `conectar Day` e confirmar a mesma conta, mantendo a assinatura.
- Consentimento dos lembretes ausente: o chat mostra a página `/hub/reminders` do Day para autorizar novamente. Não confunda esse consentimento com a assinatura de envio.
- Indisponibilidade temporária: o Hub tenta novamente automaticamente, sem pedir uma reconexão desnecessária.

`notificações` e `minhas assinaturas` mostram o problema e como resolvê-lo. O Hub também inclui um aviso na próxima interação do usuário, uma vez por episódio de falha, sem depender da IA. Esse aviso é enfileirado junto à resposta da conversa, com deduplicação persistida; não é um novo disparo proativo fora da janela de atendimento. A retomada só aparece após uma consulta autenticada bem-sucedida. A reconexão sozinha não apaga o diagnóstico. Os limites de atraso abaixo continuam valendo; recuperar o acesso não reenvia todos os avisos perdidos.

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
