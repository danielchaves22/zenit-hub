import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rescheduleEvent } from '../src/calendar-reschedule.js';

const zone = 'America/Sao_Paulo';
const timed = (start: string, end: string) => ({ start: { dateTime: start }, end: { dateTime: end } });
test('move only the date keeps original clocks, overnight boundaries and all-day exclusive end', () => {
  assert.deepEqual(rescheduleEvent(timed('2026-12-12T08:00:00-03:00', '2026-12-12T09:00:00-03:00'), '2026-10-12', zone), {
    start: { dateTime: '2026-10-12T11:00:00.000Z', timeZone: zone }, end: { dateTime: '2026-10-12T12:00:00.000Z', timeZone: zone }
  });
  assert.deepEqual(rescheduleEvent(timed('2026-12-31T23:30:00-03:00', '2027-01-01T01:00:00-03:00'), '2026-10-12', zone), {
    start: { dateTime: '2026-10-13T02:30:00.000Z', timeZone: zone }, end: { dateTime: '2026-10-13T04:00:00.000Z', timeZone: zone }
  });
  assert.deepEqual(rescheduleEvent({ start: { date: '2026-12-30' }, end: { date: '2027-01-02' } }, '2026-10-12', zone), {
    start: { date: '2026-10-12' }, end: { date: '2026-10-15' }
  });
  assert.throws(() => rescheduleEvent(timed('2026-12-12T08:00:00-03:00', '2026-12-12T09:00:00-03:00'), '2026-02-30', zone), /data válida/);
  assert.throws(() => rescheduleEvent({ start: {}, end: {} }, '2026-10-12', zone), /horários originais/);
});

test('rescheduling uses the target date offset and refuses DST gaps or overlaps', () => {
  const ny = 'America/New_York';
  assert.deepEqual(rescheduleEvent(timed('2026-01-12T08:00:00-05:00', '2026-01-12T09:00:00-05:00'), '2026-07-12', ny), {
    start: { dateTime: '2026-07-12T12:00:00.000Z', timeZone: ny }, end: { dateTime: '2026-07-12T13:00:00.000Z', timeZone: ny }
  });
  assert.throws(() => rescheduleEvent(timed('2026-01-12T02:30:00-05:00', '2026-01-12T03:30:00-05:00'), '2026-03-08', ny), /inexistente ou ambíguo/);
  assert.throws(() => rescheduleEvent(timed('2026-01-12T01:30:00-05:00', '2026-01-12T02:30:00-05:00'), '2026-11-01', ny), /inexistente ou ambíguo/);
});
