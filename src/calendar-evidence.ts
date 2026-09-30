import { PublicError } from './types.js';

type Timing = { operation: string; start: string | null; end: string | null; allDay: boolean | null; timingEvidence: string | null };
export class CalendarTimingError extends PublicError {}
// A model may propose parameters, but cannot supply a missing user time itself.
export function checkCalendarTiming(change: Timing, userMessages: string[], timeZone: string) {
  if (change.operation === 'delete' || (change.start === null && change.end === null && change.allDay === null)) return;
  const evidence = change.timingEvidence?.trim();
  if (!evidence || !userMessages.some(text => text.includes(evidence))) {
    throw new CalendarTimingError('Qual é o horário de início e de fim? Informe em HH:mm, ou diga "dia inteiro". Ainda não preparei nenhum evento para gravar.');
  }
  const text = evidence.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (change.allDay) {
    if (!/\b(dia inteiro|dia todo|todo o dia|sem horario)\b/.test(text)) throw new CalendarTimingError('Esse compromisso é de dia inteiro ou tem horário? Ainda não preparei nenhum evento para gravar.');
    return;
  }
  const found = new Set<string>();
  const add = (h: string, m = '00') => found.add(`${h.padStart(2, '0')}:${m || '00'}`);
  for (const match of text.matchAll(/\b([01]?\d|2[0-3])(?:h([0-5]\d)?|:([0-5]\d))(?!\d)/g)) add(match[1], match[2] || match[3]);
  for (const match of text.matchAll(/\b([01]?\d|2[0-3])\s+(?:as|a|ate)\s+([01]?\d|2[0-3])\b/g)) { add(match[1]); add(match[2]); }
  const clock = (value: string | null) => value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value)) : '';
  if (!found.has(clock(change.start)) || !found.has(clock(change.end))) {
    throw new CalendarTimingError('Qual é o horário de início e de fim? Informe em HH:mm, ou diga "dia inteiro". Ainda não preparei nenhum evento para gravar.');
  }
}
