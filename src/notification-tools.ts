const tool = (name: string, description: string, properties: Record<string, unknown>) => ({
  type: 'function',
  name,
  description,
  strict: true,
  parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
});
const scheduleProperties = {
  kind: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'interval'] },
  timeZone: { type: 'string' },
  startAt: {
    type: 'string',
    description: 'ISO com offset; início inclusivo. Para agora, use o instante atual informado.',
  },
  endAt: {
    type: ['string', 'null'],
    description: 'Fim EXCLUSIVO. 12 em 12 horas por 7 dias: início + 7 dias; 14 ocorrências.',
  },
  times: {
    type: 'array',
    items: { type: 'string' },
    description: 'HH:MM, inclusive vários horários ao dia. [] para interval.',
  },
  weekDays: {
    type: 'array',
    items: { type: 'integer', minimum: 0, maximum: 6 },
    description: '0 domingo a 6 sábado; [] fora de weekly.',
  },
  monthDay: {
    type: ['integer', 'null'],
    minimum: 1,
    maximum: 31,
    description: 'Mensal; meses menores usam o último dia. null nos outros tipos.',
  },
  intervalMinutes: {
    type: ['integer', 'null'],
    minimum: 1,
    maximum: 10080,
    description: 'Intervalo em minutos. null para daily/weekly/monthly.',
  },
  windowStart: {
    type: ['string', 'null'],
    description:
      'HH:MM para intervalo restrito a uma faixa diária; null para intervalo contínuo inclusive à noite.',
  },
  windowEnd: {
    type: ['string', 'null'],
    description:
      'HH:MM final inclusivo quando coincide com o intervalo; junto com windowStart, ou ambos null.',
  },
};
export const notificationTools = {
  quiet_hours_prepare: tool('quiet_hours_prepare',
    'Prepara o período de silêncio GLOBAL deste usuário no WhatsApp, com confirmação por botão. Bloqueia primeiro aviso e repetições, exceto lembretes configurados para ignorá-lo. Não salva automaticamente. Para consultar ou configurar sem horários, oriente enviar “silêncio” ou “configurar silêncio”. Não invente os horários.', {
      enabled:{type:'boolean'},start:{type:'string',description:'HH:MM de início, informado pelo usuário.'},
      end:{type:'string',description:'HH:MM de fim, diferente do início. Pode atravessar meia-noite.'},
      timeZone:{type:['string','null'],description:'null para preservar o fuso já configurado (ou usar o padrão ao criar). Informe outro fuso IANA apenas se o usuário pedir explicitamente.'}
    }),
  notification_catalog: tool(
    'notification_catalog',
    'Mostra catálogo REAL de notificações WhatsApp e assinaturas. Use para perguntas sobre quais avisos pode receber. A resposta é mostrada diretamente.',
    {},
  ),
  notification_status: tool(
    'notification_status',
    'Lista assinaturas e últimos envios de avisos pelo WhatsApp.',
    {},
  ),
  notification_prepare: tool(
    'notification_prepare',
    'Prepara assinatura ou alteração de notificações. Não ativa até botão Confirmar. Use sozinha. Se faltar horário do resumo, pergunte. Lembretes dependem de autorização específica no Day.',
    {
      kind: { type: 'string', enum: ['daily_summary', 'day_reminders'] },
      time: {
        type: ['string', 'null'],
        description: 'Resumo: HH:MM obrigatório; Day: null, pois cada lembrete tem seu horário.',
      },
      timeZone: { type: 'string', description: 'Fuso IANA, padrão do usuário informado.' },
      sources: {
        type: 'array',
        items: { type: 'string', enum: ['cash', 'day', 'calendar'] },
        description:
          'Resumo: fontes conectadas solicitadas; na ausência de escolha, todas conectadas, explicitadas na prévia. Day reminders: somente day.',
      },
    },
  ),
  notification_pause: tool(
    'notification_pause',
    'Pausa imediatamente o envio pelo WhatsApp solicitado pelo usuário. Não altera lembretes no Day. Use para pedidos de parar/cancelar avisos.',
    {
      kind: { type: 'string', enum: ['daily_summary', 'day_reminders', 'all'] },
    },
  ),
  reminder_list: tool(
    'reminder_list',
    'Consulta dados de lembretes personalizados no Day para análises e alterações por título identificado. Para mostrar uma lista ao usuário ou escolher qual excluir, use reminder_choices, que mantém a numeração no servidor. Use search para encontrar pelo título quando a lista truncar. Precisa de autorização específica. IDs para alterar devem vir desta consulta.',
    {search:{type:['string','null'],description:'Trecho do título; null para todos.'},limit:{type:'integer',minimum:1,maximum:20}},
  ),
  reminder_choices: tool(
    'reminder_choices',
    'Mostra diretamente uma lista numerada dos lembretes do Day. Use sozinha para listar ou escolher qual editar, pausar ou excluir, inclusive perguntas COMO fazer ou nomes ambíguos. O usuário responde com o número; o Hub resolve o ID. Editar pede depois os novos dados; todas as escritas exigem confirmação. Não invente numeração no texto da IA.',
    { purpose: { type: 'string', enum: ['list', 'delete', 'pause', 'update'] },
      search: { type: ['string', 'null'], description: 'Trecho do título fornecido pelo usuário; null para todos. A lista mostra até 10 resultados; refine o trecho se truncar.' } },
  ),
  reminder_prepare: tool(
    'reminder_prepare',
    'Prepara criação, edição, pausa, retomada ou exclusão de UM lembrete no Day, somente após botão Confirmar. Use sozinha. Para alterar consulte reminder_list nesta solicitação e preserve campos não alterados. Não cria evento de Calendar nem assina envio automaticamente.',
    {
      operation: { type: 'string', enum: ['create', 'update', 'pause', 'resume', 'delete'] },
      id: {
        type: ['string', 'null'],
        description: 'null para criar; ID retornado por reminder_list para alterar.',
      },
      title: {
        type: ['string', 'null'],
        description: 'Texto solicitado; obrigatório criar. null para preservar ou pausar/retomar/excluir.',
      },
      requiresConfirmation:{type:['boolean','null'],description:'Deseja repetir até clicar Concluído? null preserva o atual ou usa não ao criar. O Hub fará a pergunta por botões antes de salvar.'},
      repeatMinutes:{type:['integer','null'],minimum:1,maximum:10080,description:'Intervalo inteiro de REPETIÇÃO enquanto pendente, diferente da recorrência do lembrete. null preserva. O Hub solicitará o número se o usuário escolher Sim.'},
      respectQuietHours:{type:['boolean','null'],description:'true respeita o silêncio global; false SOMENTE quando o usuário pedir explicitamente a exceção. null preserva ou usa true ao criar. O Hub confirma essa escolha por botões.'},
      schedule: {
        anyOf: [
          { type: 'null' },
          {
            type: 'object',
            properties: scheduleProperties,
            required: Object.keys(scheduleProperties),
            additionalProperties: false,
          },
        ],
        description:
          'Regra completa ao criar/alterar frequência; null para preservar. Nunca adivinhe horários inválidos como 155h.',
      },
    },
  ),
};

export const reminderEditTool = tool('reminder_edit_selected',
  'Prepara alterações somente do lembrete já escolhido por número e vinculado pelo servidor. Use sozinha. Não recebe ID nem título como identificador: title é apenas o NOVO texto, se solicitado. Preserve com null os campos não alterados. schedule é a regra completa, preservando todos os componentes não solicitados a partir dos dados atuais. Não invente horários; peça esclarecimento se necessário. Continua nas perguntas de opções e na confirmação final; não salva automaticamente.',
  Object.fromEntries(Object.entries(notificationTools.reminder_prepare.parameters.properties).filter(([key]) => !['operation', 'id'].includes(key))),
);
