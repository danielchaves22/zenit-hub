import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { createTestStore } from './database-helper.js';
import { WhatsApp } from '../src/whatsapp.js';
import { Cash } from '../src/connectors/cash.js';
import { Assistant } from '../src/assistant.js';
import { OAuth } from '../src/oauth.js';
import { Worker } from '../src/worker.js';
import { bridgeSignature, metaSignature } from '../src/security.js';
const config = readConfig({ DATABASE_URL: 'postgresql://test:test@localhost/zenit_hub_test', HUB_ENCRYPTION_KEY: randomBytes(32).toString('base64'), WHATSAPP_APP_SECRET: 'test-meta-secret',
  WHATSAPP_PHONE_NUMBER_ID: 'phone-1', WHATSAPP_ACCESS_TOKEN: 'test-meta-token',
  CASH_API_URL: 'https://cash.example', CASH_HUB_SHARED_SECRET: 'test-only-cash-secret-with-more-than-32-characters' });
const sender = '5544999990000';
function envelope(messages: object[]) {
  return Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: config.meta.phoneId }, messages: messages.map(m => ({ from: sender, timestamp: Math.floor(Date.now() / 1000), ...m }))
  } }] }] }));
}

test('signed voice survives encrypted queue and reaches Cash once with original identity and unchanged buttons', async () => {
  const store = (await createTestStore(config.key));
  const cashCalls: any[] = []; const metaCalls: any[] = [];
  const buttons = [{ id: 'zenit:confirm:42:1790700000000', title: 'Confirmar' }, { id: 'zenit:cancel:42:1790700000000', title: 'Cancelar' }];
  const cash = new Cash(config.cash, (async (_url, init) => {
    const raw = String(init?.body); const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-hub-signature'), bridgeSignature(raw, headers.get('x-hub-timestamp')!, headers.get('x-hub-nonce')!, '/api/integrations/hub/bridge', config.cash.secret));
    const body = JSON.parse(raw); cashCalls.push(body);
    if (body.audio) assert.equal(metaCalls[metaCalls.length - 1].status, 'read');
    assert.equal(body.sender, sender);
    assert.equal(body.text, '');
    assert(!('userId' in body) && !('companyId' in body));
    return new Response(JSON.stringify({ replies: [{ text: 'Confira o rascunho.', buttons }] }));
  }) as typeof fetch);
  const whatsapp = new WhatsApp(config, (async (_url, init) => {
    metaCalls.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ success: true }));
  }) as typeof fetch);
  const assistant = new Assistant(config, store, new OAuth(config, store), cash, {} as any, {} as any,
    (async () => { throw new Error('Audio must not call the Hub model'); }) as typeof fetch);
  try {
    for (const provider of ['day', 'calendar'] as const) (await store.connect({ sender, provider, accountId: 'independent-account', label: 'another@example.com',
      tokens: { access_token: 'provider-secret', refresh_token: 'refresh', expires_at: Date.now() + 3600000 } }));
    const raw = envelope([{ id: 'wamid.voice', type: 'audio', audio: { id: '123456789', mime_type: 'audio/ogg; codecs=opus' } }]);
    const [message] = whatsapp.parse(raw, metaSignature(raw, config.meta.secret));
    assert.deepEqual(message.audio, { mediaId: '123456789' });
    assert((await store.enqueue(message))); assert(!(await store.enqueue(message)));
    assert(!JSON.stringify((await store.db.query('SELECT data FROM inbox')).rows).includes('123456789'));
    const worker = new Worker(store, assistant, whatsapp);
    await Promise.all([worker.tick(), worker.tick()]); await worker.tick();
    assert.equal(cashCalls.length, 1);
    assert.deepEqual(cashCalls[0].audio, { mediaId: '123456789' });
    const replies = metaCalls.filter(c => c.type === 'interactive');
    assert.equal(replies.length, 1);
    assert.deepEqual(replies[0].interactive.action.buttons.map((b: any) => b.reply), buttons);
    assert.equal((await store.db.query('SELECT state FROM inbox')).rows[0]?.state, 'done');
    assert.equal((await store.history(sender)).length, 2);
    assert(!JSON.stringify((await store.history(sender))).includes('123456789'));
    const result = await assistant.handle({ id: 'wamid.click', sender, text: '', button: buttons[0].id, timestamp: Date.now() / 1000 });
    assert.equal(cashCalls[1].buttonId, buttons[0].id);
    assert.equal(cashCalls[1].audio, undefined);
    assert.deepEqual(result[0].buttons, buttons);
    (await store.disableCash(sender, true));
    await assert.rejects(assistant.handle(message), /Conecte o Cash novamente/);
    assert.equal(cashCalls.length, 2);
  } finally { (await store.close()); }
});

test('audio cannot smuggle a typed command or confirmation button and non-audio media never forwards an audio reference', () => {
  const whatsapp = new WhatsApp(config);
  const raw = envelope([
    { id: 'voice', type: 'audio', audio: { id: '123' }, text: { body: 'desconectar Cash' }, interactive: { button_reply: { id: 'zenit:confirm:1:1' } } },
    { id: 'document', type: 'document', audio: { id: '456' } },
    { id: 'url', type: 'audio', audio: { id: 'https://other.example/private' } }
  ]);
  const messages = whatsapp.parse(raw, metaSignature(raw, config.meta.secret));
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0].audio, { mediaId: '123' });
  assert.equal(messages[0].text, ''); assert.equal(messages[0].button, undefined);
  assert.equal(messages[1].audio, undefined);
});

test('typing failures do not prevent processing or leak credentials', async () => {
  const whatsapp = new WhatsApp(config, (async () => { throw new Error('provider failure'); }) as typeof fetch);
  let calls = 0;
  assert.equal(await whatsapp.withTypingIndicator('wamid.voice', async () => { calls++; return 'ok'; }), 'ok');
  assert.equal(calls, 1);
});

test('a typed correction after voice has the visible Cash draft as context and preserves the original correction', async () => {
  const store = (await createTestStore(config.key));
  try {
    (await store.connect({ sender, provider: 'day', accountId: 'independent', label: 'day@example.com',
      tokens: { access_token: 'day-token', refresh_token: 'refresh', expires_at: Date.now() + 3600000 } }));
    const received: any[] = []; let modelCalls = 0;
    const cash = { connected: async () => true, message: async (message: unknown) => {
      received.push(message); return [{ text: received.length === 1 ? 'Aguardando confirmação: despesa de R$ 50,00.' : 'Rascunho corrigido: R$ 45,00.' }];
    } };
    const withAI = { ...config, ai: { ...config.ai, key: 'test-key', model: 'test-model' } };
    const assistant = new Assistant(withAI, store, new OAuth(config, store), cash as any, {} as any, {} as any,
      (async (_url, init) => {
        modelCalls++;
        const body = JSON.parse(String(init?.body));
        assert(JSON.stringify(body.input).includes('Aguardando confirmação: despesa de R$ 50,00.'));
        assert(!JSON.stringify(body).includes('987654321'));
        return new Response(JSON.stringify({ output: [{ type: 'function_call', name: 'cash_assistant', call_id: '1', arguments: '{}' }] }));
      }) as typeof fetch);
    await assistant.handle({ id: 'voice', sender, timestamp: Date.now() / 1000, text: '', audio: { mediaId: '987654321' } });
    assert.equal(modelCalls, 0);
    const correction = { id: 'correction', sender, timestamp: Date.now() / 1000, text: 'Na verdade foram 45 reais.' };
    assert.equal((await assistant.handle(correction))[0].text, 'Rascunho corrigido: R$ 45,00.');
    assert.equal(modelCalls, 1);
    assert.deepEqual(received[1], correction);
  } finally { (await store.close()); }
});
