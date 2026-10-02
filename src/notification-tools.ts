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
    'Consulta lembretes personalizados no Day. Use search para encontrar pelo título quando a lista truncar. Precisa de autorização específica; a conexão antiga só de assuntos não basta. IDs para alterar devem vir desta consulta.',
    {search:{type:['string','null'],description:'Trecho do título; null para todos.'},limit:{type:'integer',minimum:1,maximum:20}},
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
