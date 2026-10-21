import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reminderTime } from '../src/reminder-format.js';

test('reminder time uses the occurrence zone and keeps its original date after midnight', () => {
  const due = Date.parse('2026-10-20T23:30:00Z');
  assert.equal(reminderTime(due, 'America/Sao_Paulo', Date.parse('2026-10-21T00:05:00Z')), 'Hoje às 20h30');
  assert.equal(reminderTime(due, 'America/Sao_Paulo', Date.parse('2026-10-21T03:05:00Z')), '20/10/2026 às 20h30');
  assert.equal(reminderTime(due, 'Asia/Tokyo', Date.parse('2026-10-21T00:05:00Z')), 'Hoje às 08h30');
  const midnight = Date.parse('2026-10-21T03:00:00Z');
  assert.equal(reminderTime(midnight, 'America/Sao_Paulo', midnight + 300_000), 'Hoje às 00h00');
  assert.equal(reminderTime(due, 'America/Sao_Paulo', Date.parse('2027-01-01T12:00:00Z')), '20/10/2026 às 20h30');
});
