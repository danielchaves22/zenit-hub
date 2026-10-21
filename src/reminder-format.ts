/** Keep the scheduled time (not the retry time), using the reminder's own zone. */
export function reminderTime(due: number, timeZone: string, now = Date.now()) {
  const localDate = new Intl.DateTimeFormat('sv-SE', { timeZone, dateStyle: 'short' });
  const day = localDate.format(due) === localDate.format(now)
    ? 'Hoje'
    : new Intl.DateTimeFormat('pt-BR', { timeZone, dateStyle: 'short' }).format(due);
  const time = new Intl.DateTimeFormat('pt-BR', {
    timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(due).replace(':', 'h');
  return `${day} às ${time}`;
}
