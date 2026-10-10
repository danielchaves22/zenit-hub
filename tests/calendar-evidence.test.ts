import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCalendarTiming } from '../src/calendar-evidence.js';

const change = { operation: 'create', start: '2026-12-23T14:00:00-03:00', end: '2026-12-23T17:00:00-03:00', allDay: false, timingEvidence: 'das 14h às 17h' };
test('Calendar cannot turn missing times, invented evidence, dates or partial hours into a confirmable draft', () => {
  const check = (q: typeof change, messages: string[]) => checkCalendarTiming(q, messages, 'America/Sao_Paulo');
  check(change, ['Crie Show Crossroads das 14h às 17h']);
  check({ ...change, timingEvidence: '14 às 17' }, ['dia 23/12/2026, 14 às 17']);
  assert.throws(() => check(change, ['Crie uma reunião amanhã']));
  assert.throws(() => check({ ...change, timingEvidence: 'reunião amanhã' }, ['Crie reunião amanhã']));
  assert.throws(() => check({ ...change, timingEvidence: 'às 14h' }, ['Crie reunião às 14h']));
  assert.throws(() => check({ ...change, timingEvidence: '14/12/2017' }, ['14/12/2017']));
  assert.throws(() => check({ ...change, start: '2026-12-23T14:00:00Z' }, ['das 14h às 17h']));
  assert.throws(() => check({ ...change, allDay: true }, ['das 14h às 17h']));
  check({ ...change, allDay: true, timingEvidence: 'dia inteiro' }, ['Marque no dia inteiro']);
});

test('equivalent clock spelling in a quote is accepted without accepting invented times or prose', () => {
  const q = { ...change, start: '2026-10-12T08:00:00-03:00', end: '2026-10-12T09:00:00-03:00', timingEvidence: '08:00 às 09:00' };
  checkCalendarTiming(q, ['8:00 às 9:00'], 'America/Sao_Paulo');
  checkCalendarTiming(q, ['8h às 9h'], 'America/Sao_Paulo');
  checkCalendarTiming(q, ['  8h00   às   9h00  '], 'America/Sao_Paulo');
  assert.throws(() => checkCalendarTiming(q, ['8:00 às 10:00'], 'America/Sao_Paulo'));
  assert.throws(() => checkCalendarTiming(q, ['No mesmo horário do original'], 'America/Sao_Paulo'));
  assert.throws(() => checkCalendarTiming({ ...q, timingEvidence: 'Inventado das 08:00 às 09:00' }, ['8:00 às 9:00'], 'America/Sao_Paulo'));
});
