import { PublicError } from './types.js';

type EventTime = { date?: string | null; dateTime?: string | null; timeZone?: string | null };
const day = 86400_000;
function dateStamp(value: string) {
  const stamp = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== value)
    throw new PublicError('Informe uma data válida, com ano, para mover o evento.');
  return stamp;
}

// A UTC-shaped timestamp of the wall clock displayed to the user (not an instant).
function wallStamp(instant: number, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(instant)).map(p => [p.type, p.value]));
  return Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.000Z`) + new Date(instant).getUTCMilliseconds();
}

function instantForWall(stamp: number, timeZone: string) {
  // Use offsets around the target date, never the event's old offset. Reject
  // nonexistent or ambiguous DST times instead of silently shifting the clock.
  const offsets = new Set([-2, -1, 0, 1, 2].map(n => {
    const sample = stamp + n * day;
    return wallStamp(sample, timeZone) - sample;
  }));
  const candidates = [...offsets].map(offset => stamp - offset)
    .filter(instant => wallStamp(instant, timeZone) === stamp);
  if (candidates.length !== 1) throw new PublicError('O horário original é inexistente ou ambíguo nessa data por mudança de fuso. Informe novos horários com o fuso ou ajuste no Google Calendar.');
  return new Date(candidates[0]).toISOString();
}

export function rescheduleEvent(event: { start: EventTime; end: EventTime }, date: string, timeZone: string) {
  const target = dateStamp(date);
  if (event.start.date && event.end.date) {
    const span = dateStamp(event.end.date) - dateStamp(event.start.date);
    if (span <= 0) throw new PublicError('O evento possui datas inválidas. Confira no Google Calendar.');
    const end = new Date(target + span).toISOString().slice(0, 10);
    dateStamp(end);
    return { start: { date }, end: { date: end } };
  }
  const start = Date.parse(event.start.dateTime || ''), end = Date.parse(event.end.dateTime || '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    throw new PublicError('Não foi possível conferir os horários originais. Consulte o evento no Google Calendar.');
  const startWall = wallStamp(start, timeZone), endWall = wallStamp(end, timeZone);
  const shift = target - dateStamp(new Date(startWall).toISOString().slice(0, 10));
  const nextStart = instantForWall(startWall + shift, timeZone), nextEnd = instantForWall(endWall + shift, timeZone);
  if (Date.parse(nextEnd) <= Date.parse(nextStart)) throw new PublicError('A mudança de data produziu um intervalo inválido. Informe novos horários.');
  return { start: { dateTime: nextStart, timeZone }, end: { dateTime: nextEnd, timeZone } };
}
