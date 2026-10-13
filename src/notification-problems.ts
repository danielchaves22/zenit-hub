export type NotificationProblem = 'connection_changed' | 'day_access' | 'day_consent' | 'day_unavailable';
export type NotificationWarning = { kind: string; revision: number; problem: NotificationProblem; since: number; text: string; detail: string };

export function notificationProblemText(problem: NotificationProblem, daySiteUrl: string): string {
  switch (problem) {
    case 'connection_changed':
      return 'Assinatura pausada porque uma das contas utilizadas mudou ou foi desconectada. Envie “notificações” e confirme novamente as fontes que deseja usar.';
    case 'day_access':
      return 'O Hub perdeu a autorização de acesso ao Day. Os lembretes não estão sendo enviados. Envie “conectar Day” e confirme a mesma conta para manter sua assinatura. Seus lembretes continuam salvos.';
    case 'day_consent':
      return `O Day não está permitindo o acesso aos lembretes. Os avisos não estão sendo enviados. Autorize novamente em ${daySiteUrl}/hub/reminders, na mesma conta conectada. Sua assinatura foi mantida.`;
    case 'day_unavailable':
      return 'Não foi possível consultar os lembretes no Day. O envio está interrompido; o Hub tentará novamente automaticamente. Sua assinatura foi mantida. Não é necessário reconectar por uma indisponibilidade temporária.';
  }
}
