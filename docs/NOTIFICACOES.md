# Notificações pelo WhatsApp

O catálogo é fornecido diretamente pelo Hub, sem depender da IA nem de respostas antigas no histórico. `notificações` e `Quais notificações posso receber?` mostram resumo diário, lembretes do Day, assinatura e disponibilidade do envio. O serviço não oferece uma opção como pronta sem o template configurado e aprovado na Meta.

## Uso

- `Quero o resumo diário às 7h com Cash, Day e Calendar`: prévia com horário, fuso e fontes; botão Confirmar ativa. Pedir outro horário/fontes substitui a assinatura após confirmação.
- `Ativar lembretes do Day`: verifica conexão e consentimento específico no Day. Se necessário, abre `DAY_SITE_URL/hub/reminders`. Autorizar a conta nessa página não assina o envio; volte ao WhatsApp e confirme a assinatura pelo botão.
- `Meus lembretes`, `Lembre-me toda quinta às 6h30 de levar o livro`, `Pause o lembrete do livro`: consulta/gestão pela IA com ferramentas do Day. Escritas exigem prévia e botão. Horários inválidos ou ausentes exigem esclarecimento.
- `Minhas assinaturas`: estado, problemas de acesso e últimos avisos, incluindo o motivo de um envio não realizado. Aceito pelo WhatsApp não significa entregue; o webhook atualiza entregue/lido/falhou.
- `Cancelar resumo diário`, `cancelar lembretes do Day`, `parar notificações`: interrompem imediatamente o envio correspondente, invalidando prévias pendentes. Preservam os lembretes no Day. Pedir nova assinatura permite retomar.
- `Configurar silêncio`: pergunta início e fim (por exemplo, `22:00 às 07:00`) e mostra uma revisão antes de salvar. `Silêncio` consulta a configuração; `desativar silêncio` prepara sua desativação por botão. Também aceita pedidos com os horários em linguagem natural. O silêncio começa desativado, até o usuário escolher os horários.

## Confirmação e período de silêncio

Ao criar ou editar pelo chat, o Hub pergunta **Repetir até marcar como concluído?**, com Sim/Não. Se Sim, pede um número inteiro de minutos (1 a 10080). Depois pergunta **Respeitar silêncio / Ignorar silêncio**. A revisão final mostra frequência, repetição e exceção; somente **Confirmar** grava no Day. Pausar, retomar e excluir preservam essas opções. No Day os mesmos campos ficam no formulário de lembrete, inclusive offline.

A frequência original (por exemplo, diariamente às 20h30) é independente da repetição enquanto pendente (por exemplo, a cada 5 minutos). O botão **Concluído** encerra somente a ocorrência vigente daquele lembrete; não cancela seus próximos horários. Uma nova ocorrência do mesmo lembrete substitui a anterior. Outros lembretes continuam independentes. Botões antigos, de outra conta ou anteriores a uma edição não concluem a ocorrência atual. Os botões das várias repetições da mesma ocorrência confirmam essa mesma pendência.

O silêncio é global **por usuário do WhatsApp**, com fuso IANA, início inclusivo e fim exclusivo; pode atravessar meia-noite. Bloqueia o primeiro aviso e as repetições de todos os lembretes que o respeitam. O resumo diário mantém seu horário próprio. Ignorar o silêncio exige escolha explícita por lembrete, independentemente do texto ou assunto. Os lembretes existentes começam sem confirmação e respeitando o silêncio. Ao sair do silêncio, há no máximo um aviso da ocorrência ainda vigente, nunca uma rajada das repetições suspensas. Se o lembrete terminou, foi editado/pausado ou tem uma ocorrência posterior, a anterior é descartada. Mudar o silêncio reavalia as pendências bloqueadas sem alterar suas regras no Day.

Repetições usam o agendador determinístico, sem chamadas à IA a cada envio. A próxima tentativa é calculada a partir da tentativa atual, com a precisão de processamento do worker (normalmente até cerca de 30 segundos, além de rede/fila). Ao clicar Concluído, o Hub interrompe localmente e persiste a conclusão para sincronizar com o Day; uma indisponibilidade do Day não reativa os avisos já concluídos.

O resumo usa a agenda principal do Calendar, contas pendentes vencendo na data local (total calculado pelo Cash) e assuntos do Day com prazo/retomada até hoje ou planejamento para hoje. Inclui indicação de prazos atrasados do Day. As seções são curtas; textos maiores indicam consultar os demais itens. Fonte indisponível é identificada, nunca interpretada como ausência de dados. Não usa IA a cada disparo. Alertas individuais de tarefas/eventos, adiamento de ocorrências e resumo semanal não fazem parte desta entrega.

## Persistência e autorização

Day mantém regras, texto, vínculo com assunto, estado e revisão dos lembretes. A migração `hub_reminder_consent` acrescenta consentimento revogável por usuário/cliente OAuth. Apenas sessão direta do Day pode conceder esse consentimento; JWT OAuth não pode se autoconceder permissão. A autorização antiga de assuntos não se expande. Assuntos e atualizações continuam somente para leitura. Dados offline aparecem depois da sincronização.

Hub mantém assinaturas, consentimento de envio, prévias e entregas em PostgreSQL (migração 3), além do estado de problemas de acesso (migração 5). Conteúdo e preferências são cifrados; os problemas guardam somente códigos operacionais e datas, sem respostas dos provedores ou credenciais. Confirmações são vinculadas ao remetente e ao acesso vigente, com validade de dez minutos.

A migração 6 acrescenta `notification_settings` e `reminder_occurrences`: silêncio por usuário, pendência por lembrete/conta/ocorrência, repetição, token opaco do botão e sincronização de conclusão. Opções, título e token são cifrados; a busca usa o hash do token e o remetente. Prévia de configuração expira em dez minutos; Concluído vale enquanto a ocorrência estiver vigente. Registros encerrados do Hub são removidos após 30 dias. No Day, `reminder_confirmation` acrescenta `requires_confirmation`, `repeat_minutes`, `respect_quiet_hours`, o histórico de conclusões e RPCs autenticadas que validam proprietário, consentimento, revisão e ocorrência canônica. Clientes antigos que omitam as novas opções preservam os valores existentes.

O acesso OAuth é renovado automaticamente, sem pausar assinaturas. Se for necessário enviar `conectar Day` novamente, confirmar **a mesma conta** preserva assinaturas, consentimento, horários, pausas voluntárias e a identificação das ocorrências já enviadas. A identidade é o ID da conta no provedor; mudanças de e-mail não são tratadas como troca de conta. Não é necessário desconectar primeiro. Trocar de conta ou desconectar pausa **apenas as assinaturas que usam aquela fonte**, exige nova confirmação para elas e mantém as demais. Reconectar não reativa uma assinatura já pausada. Prévias de alterações pendentes continuam sendo invalidadas pela reconexão.

## Problemas de acesso

O Hub verifica também o consentimento específico do Day antes de consultar ocorrências, inclusive quando não há lembretes no horário. Uma assinatura pode continuar autorizada pelo usuário e estar com o **envio interrompido**:

- Acesso expirado ou revogado: o chat orienta `conectar Day` e confirmar a mesma conta, mantendo a assinatura.
- Consentimento dos lembretes ausente: o chat mostra a página `/hub/reminders` do Day para autorizar novamente. Não confunda esse consentimento com a assinatura de envio.
- Indisponibilidade temporária: o Hub tenta novamente automaticamente, sem pedir uma reconexão desnecessária.

`notificações` e `minhas assinaturas` mostram o problema e como resolvê-lo. O Hub também inclui um aviso na próxima interação do usuário, uma vez por episódio de falha, sem depender da IA. Esse aviso é enfileirado junto à resposta da conversa, com deduplicação persistida; não é um novo disparo proativo fora da janela de atendimento. A retomada só aparece após uma consulta autenticada bem-sucedida. A reconexão sozinha não apaga o diagnóstico. Os limites de atraso abaixo continuam valendo; recuperar o acesso não reenvia todos os avisos perdidos.

O worker único consulta assinaturas a cada 30 segundos e recupera ocorrências novas numa janela de até cinco minutos; uma indisponibilidade maior não reconstrói todos os horários perdidos. Depois de identificada, uma ocorrência fica persistida até seu envio, conclusão ou substituição; pode aguardar o fim do silêncio. Resumos têm validade de uma hora. Atrasos nunca mudam a âncora da recorrência. Edição, pausa, consentimento e ocorrência vigente são revalidados no Day antes do envio. Cada tentativa é reservada antes do HTTP; reinício não a executa novamente. Resultado incerto da Meta não é repetido imediatamente; quando o usuário pediu repetição até concluir, a próxima tentativa segue o intervalo escolhido. Lembretes sem confirmação têm apenas uma tentativa. `Minhas assinaturas` mostra silêncio, pendências e os estados de entrega, sem afirmar que uma mensagem aceita foi entregue.

## Configuração

1. Aplicar a migração do Day e cadastrar o `DAY_CLIENT_ID` existente em `zenit_day_private.reminder_clients` (configuração por ambiente; não é consentimento de usuário). Publicar a tela web do Day com `VITE_HUB_CLIENT_ID` já existente.
2. Publicar Hub; o pre-deploy executa `npm run db:migrate`. Manter uma instância paga sempre ativa; não há cron externo ou serviço novo.
3. Cadastrar **somente** os modelos descritos em `config/whatsapp-notifications.json` na conta que contém o número do Hub. A categoria solicitada é UTILITY, sujeita à avaliação da Meta.
4. Depois da aprovação, configurar `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_SUMMARY_TEMPLATE=zenit_resumo_diario_v1`, `WHATSAPP_REMINDER_TEMPLATE=zenit_lembrete_day_v1` e `WHATSAPP_REMINDER_CONFIRM_TEMPLATE=zenit_lembrete_confirmar_v1` no Hub. O último modelo inclui um botão QUICK_REPLY `Concluído`; não usa Flow. Idioma `pt_BR`. A credencial precisa de `whatsapp_business_management` para verificar aprovação e `whatsapp_business_messaging` para enviar. O modelo com confirmação é verificado separadamente e precisa estar aprovado para permitir a configuração pelo chat e os disparos correspondentes.
5. Usuário autoriza Day e assina pelo WhatsApp. Nenhuma assinatura é criada durante instalação/deploy.

Os envios proativos usam sempre templates aprovados, inclusive quando a janela de atendimento estiver aberta. Isso evita depender de uma mensagem recente do usuário. A Meta pode cobrar, recategorizar, pausar ou rejeitar templates. O catálogo consulta o estado; falhas de configuração/aprovação impedem ativação, e o agendador revalida antes do envio. Referência: [Política WhatsApp](https://whatsappbusiness.com/policy/).

Testes cobrem catálogo da captura de tela, consentimento, troca de conta, idempotência, cancelamento, recorrência no Day, isolamento de dados, templates e recibos. Testes locais com conectores simulados não comprovam uma entrega real da Meta; o piloto só se completa após assinatura do usuário e uma ocorrência real.

As tabelas privadas de clientes/consentimentos têm RLS ativado e nenhum acesso direto concedido. O aviso informativo [RLS Enabled No Policy](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) é intencional nesse caso: somente as funções privadas com verificação explícita de identidade as acessam. Os endpoints públicos usam SECURITY INVOKER. A revisão após migração não acrescentou alertas de nível WARN.

## Registro de implantação — 14/10/2026

Hub `4324600` e Day `c2d5dc3` publicados no Render; schema 6 do Hub confirmado. No Day foram aplicadas `20261014040541_reminder_confirmation` e `20261014040803_reminder_confirmation_policy`. A consulta autenticada a partir do Hub confirmou os novos campos e a RPC de estado de ocorrência. `/health` respondeu `ok`. Não foram alterados horários, opções ou assinaturas existentes para realizar testes.

O modelo `zenit_lembrete_confirmar_v1` foi cadastrado como UTILITY/pt_BR com botão Concluído (ID `1622731926057463`). Na checagem desta implantação estava **PENDING**; o modelo comum continuava aprovado. `WHATSAPP_REMINDER_CONFIRM_TEMPLATE` assume esse nome quando não configurado. O Hub consulta a aprovação com cache de até um minuto: depois de aprovado, não exige novo deploy para habilitar esse modelo. Nenhuma entrega real com esse botão foi validada nesta implantação. A interface publicada no Render foi atualizada; instaladores desktop/Android não foram gerados nesta rodada.

Validação: suíte de 103 testes do Hub, verificações focadas posteriores, cinco testes unitários de lembretes do Day, integração PostgreSQL/PGlite com regras de acesso e compatibilidade de clientes antigos, dois cenários E2E de lembretes/consentimento, tipos e builds. A auditoria de segurança do Supabase manteve os avisos preexistentes. O linter de desempenho ainda apontou `auth_rls_initplan` na política de conclusões após a correção; `EXPLAIN` como authenticated confirmou três InitPlans e uso do índice por usuário, sem reavaliação da identidade por linha. Referência do diagnóstico: [Auth RLS Initialization Plan](https://supabase.com/docs/guides/database/database-linter?lint=0003_auth_rls_initplan).
