import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AssistantDefaultsCache, initialAssistantDefaults } from '../src/assistant-defaults.js';
import { Cash } from '../src/connectors/cash.js';
import { readConfig } from '../src/config.js';
import { createTestStore } from './database-helper.js';
import { Assistant } from '../src/assistant.js';
import { OAuth } from '../src/oauth.js';
import { Day } from '../src/connectors/day.js';
import { Calendar } from '../src/connectors/calendar.js';

test('integrated chat starts with Sol low regardless of old Render model settings and keeps its audio model', () => {
  const env = { DATABASE_URL: 'postgresql://localhost/zenit_hub_test', HUB_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    OPENAI_MODEL: 'previous-model', OPENAI_REASONING_EFFORT: 'none', WHATSAPP_TRANSCRIPTION_MODEL: 'audio-test' };
  const standalone = readConfig(env);
  assert.equal(standalone.ai.model, 'previous-model');
  assert.equal(standalone.ai.effort, 'none');
  const integrated = readConfig({ ...env, CASH_API_URL: 'https://cash.example', CASH_HUB_SHARED_SECRET: 'a'.repeat(32) });
  assert.equal(integrated.ai.model, 'gpt-6.2-sol');
  assert.equal(integrated.ai.effort, 'low');
  assert.equal(integrated.ai.transcriptionModel, 'audio-test');
});

test('one refresh serves concurrent turns, updates the persisted default and falls back on restart', async () => {
  const store = await createTestStore(randomBytes(32).toString('base64'));
  try {
    let now = 1000;
    let calls = 0;
    let response: Record<string, unknown> = { model: '', reasoningEffort: 'not-a-level' };
    const cash = new Cash({ url: 'https://cash.example', secret: 'b'.repeat(32), bindingPrefix: '', connectUrl: '' },
      async () => { calls++; return Response.json(response); });
    const cache = new AssistantDefaultsCache(cash, store.db, () => now);
    assert.deepEqual(await cache.get(), initialAssistantDefaults);
    assert.equal((await store.db.query('SELECT * FROM assistant_defaults_cache')).rowCount, 0);
    now += 60_001;
    response = { model: 'first', reasoningEffort: 'medium' };
    const [first, concurrent] = await Promise.all([cache.get(), cache.get()]);
    assert.deepEqual(first, response);
    assert.deepEqual(concurrent, first);
    assert.equal(calls, 2);
    response = { model: 'next', reasoningEffort: null };
    assert.deepEqual(await cache.get(), first);
    assert.equal(calls, 2);
    now += 60_001;
    assert.deepEqual(await cache.get(), response);
    response = { model: 'invalid', reasoningEffort: 'unrecognized' };
    now += 60_001;
    assert.deepEqual(await cache.get(), { model: 'next', reasoningEffort: null });
    const afterRestart = new AssistantDefaultsCache(cash, store.db, () => now);
    assert.deepEqual(await afterRestart.get(), { model: 'next', reasoningEffort: null });
    assert.equal(calls, 5);
  } finally { await store.close(); }
});

test('a Day user without Cash receives the global policy without sharing user context with the policy endpoint', async () => {
  const config = readConfig({ DATABASE_URL: 'postgresql://localhost/zenit_hub_test', HUB_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    OPENAI_API_KEY: 'test', CASH_API_URL: 'https://cash.example', CASH_HUB_SHARED_SECRET: 'c'.repeat(32) });
  const store = await createTestStore(config.key);
  try {
    const sender = 'day-only';
    await store.disableCash(sender, true);
    await store.connect({ sender, provider: 'day', accountId: 'day-test', label: 'Day', tokens: {
      access_token: 'test', refresh_token: 'test', expires_at: Date.now() + 3600_000 } });
    const operations: unknown[] = [];
    const cash = new Cash(config.cash, async (_url, init) => {
      operations.push(JSON.parse(String(init?.body)));
      return Response.json({ model: 'global-model', reasoningEffort: 'high' });
    });
    const oauth = new OAuth(config, store);
    const assistant = new Assistant(config, store, oauth, cash, new Day(oauth), new Calendar(oauth), async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, 'global-model');
      assert.deepEqual(body.reasoning, { effort: 'high' });
      return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Resposta de teste' }] }] });
    });
    const message = { sender, id: 'day-only-menu', timestamp: Date.now() / 1000, text: 'conexões' };
    await assistant.handle(message);
    assert.deepEqual(operations, []);
    const reply = await assistant.handle({ ...message, id: 'day-only-question', text: 'O que faço hoje?' });
    assert.equal(reply[0].text, 'Resposta de teste');
    assert.deepEqual(operations, [{ operation: 'assistant_defaults' }]);
  } finally { await store.close(); }
});
