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
  OPENAI_API_KEY: 'test-ai-key', OPENAI_MODEL: 'test-model',
  CASH_API_URL: 'https://cash.example', CASH_HUB_SHARED_SECRET: 'test-only-cash-secret-with-more-than-32-characters' });
const sender = '5544999990000';
function envelope(messages: object[]) {
  return Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: config.meta.phoneId }, messages: messages.map(m => ({ from: sender, timestamp: Math.floor(Date.now() / 1000), ...m }))
  } }] }] }));
}

test('signed voice is transcribed once, routed by Hub and reaches Cash as text with original identity and unchanged buttons', async () => {
  const store = (await createTestStore(config.key));
  const cashCalls: any[] = []; const metaCalls: any[] = [];
  const buttons = [{ id: 'zenit:confirm:42:1790700000000', title: 'Confirmar' }, { id: 'zenit:cancel:42:1790700000000', title: 'Cancelar' }];
  const cash = new Cash(config.cash, (async (_url, init) => {
    const raw = String(init?.body); const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-hub-signature'), bridgeSignature(raw, headers.get('x-hub-timestamp')!, headers.get('x-hub-nonce')!, '/api/integrations/hub/bridge', config.cash.secret));
    const body = JSON.parse(raw);
    if (body.operation === 'status') return new Response(JSON.stringify({ connected: true }));
    cashCalls.push(body);
    assert.equal(body.sender, sender);
    assert.equal(body.text, body.buttonId ? '' : 'Gastei cinquenta reais com almoço.');
    assert.equal(body.audio, undefined);
    assert(!('userId' in body) && !('companyId' in body));
    return new Response(JSON.stringify({ replies: [{ text: 'Confira o rascunho.', buttons }] }));
  }) as typeof fetch);
  const whatsapp = new WhatsApp(config, (async (_url, init) => {
    metaCalls.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ success: true }));
  }) as typeof fetch);
  let transcriptions = 0; let modelCalls = 0;
  const assistant = new Assistant(config, store, new OAuth(config, store), cash, {} as any, {} as any,
    (async (_url, init) => {
      modelCalls++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.input.at(-1).content, 'Gastei cinquenta reais com almoço.');
      assert(!JSON.stringify(body).includes('123456789'));
      return new Response(JSON.stringify({ output: [{ type: 'function_call', name: 'cash_assistant', call_id: '1', arguments: '{}' }] }));
    }) as typeof fetch, { transcribe: async id => {
      transcriptions++; assert.equal(id, '123456789'); assert.equal(metaCalls.at(-1).status, 'read');
      return 'Gastei cinquenta reais com almoço.';
    } });
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
    assert.equal(cashCalls[0].messageId, 'wamid.voice');
    assert.equal(transcriptions, 1); assert.equal(modelCalls, 1);
    const replies = metaCalls.filter(c => c.type === 'interactive');
    assert.equal(replies.length, 1);
    assert.deepEqual(replies[0].interactive.action.buttons.map((b: any) => b.reply), buttons);
    assert.equal((await store.db.query('SELECT state FROM inbox')).rows[0]?.state, 'done');
    assert.equal((await store.history(sender)).length, 2);
    assert.equal((await store.history(sender))[0].content, 'Gastei cinquenta reais com almoço.');
    assert(!JSON.stringify((await store.history(sender))).includes('123456789'));
    assert(!JSON.stringify((await store.db.query('SELECT data FROM history')).rows).includes('cinquenta'));
    const result = await assistant.handle({ id: 'wamid.click', sender, text: '', button: buttons[0].id, timestamp: Date.now() / 1000 });
    assert.equal(cashCalls[1].buttonId, buttons[0].id);
    assert.equal(cashCalls[1].audio, undefined);
    assert.deepEqual(result[0].buttons, buttons);
    assert.equal(cashCalls.length, 2);
    assert.equal(transcriptions, 1); assert.equal(modelCalls, 1);
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

test('voice and typed corrections share the original transcript and Cash draft without retranscription in Cash', async () => {
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
        if (modelCalls > 1) {
          assert(JSON.stringify(body.input).includes('Aguardando confirmação: despesa de R$ 50,00.'));
          assert(JSON.stringify(body.input).includes('Gastei 50 reais com almoço.'));
        }
        assert(!JSON.stringify(body).includes('987654321'));
        return new Response(JSON.stringify({ output: [{ type: 'function_call', name: 'cash_assistant', call_id: '1', arguments: '{}' }] }));
      }) as typeof fetch, { transcribe: async id => id === '987654321' ? 'Gastei 50 reais com almoço.' : 'Na verdade foram 45 reais.' });
    await assistant.handle({ id: 'voice', sender, timestamp: Date.now() / 1000, text: '', audio: { mediaId: '987654321' } });
    assert.equal(modelCalls, 1);
    const correction = { id: 'correction', sender, timestamp: Date.now() / 1000, text: '', audio: { mediaId: '987654322' } };
    assert.equal((await assistant.handle(correction))[0].text, 'Rascunho corrigido: R$ 45,00.');
    assert.equal(modelCalls, 2);
    assert.deepEqual(received[1], { id: correction.id, sender, timestamp: correction.timestamp, text: 'Na verdade foram 45 reais.' });
    const typed = { id: 'typed', sender, timestamp: Date.now() / 1000, text: 'Mostre o rascunho novamente.' };
    await assistant.handle(typed);
    assert.deepEqual(received[2], typed); assert.equal(modelCalls, 3);
  } finally { (await store.close()); }
});

test('weekend voice, spoken clarification and typed follow-up share Calendar context; Cash can be disconnected', async () => {
  const store = await createTestStore(config.key);
  try {
    await store.connect({ sender, provider: 'calendar', accountId: 'google-account', label: 'calendar@example.test',
      tokens: { access_token: 'google-secret', refresh_token: 'refresh', expires_at: Date.now() + 3600000 } });
    await store.disableCash(sender, true);
    let modelCalls = 0; let calendarReads = 0;
    const transcripts = ['Tenho compromissos no primeiro final de semana de dezembro?', 'Estou falando dos compromissos de agenda.'];
    const fetcher = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)); modelCalls++;
      assert(!body.tools.some((t: any) => t.name.startsWith('cash_')));
      assert(body.tools.some((t: any) => t.name === 'calendar_events'));
      assert(JSON.stringify(body.input).includes(transcripts[0]));
      if (modelCalls > 2) assert(JSON.stringify(body.input).includes(transcripts[1]));
      if (modelCalls > 4) assert(JSON.stringify(body.input).includes('Você tem acesso à agenda do Google?'));
      const output = modelCalls % 2 ? [{ type: 'function_call', name: 'calendar_events', call_id: 'c', arguments: JSON.stringify({
        start: '2026-12-05T00:00:00-03:00', end: '2026-12-07T00:00:00-03:00', calendarId: 'primary', limit: 20
      }) }] : [{ type: 'message', content: [{ type: 'output_text', text: 'Nenhum evento de agenda nesse fim de semana.' }] }];
      return new Response(JSON.stringify({ output }));
    }) as typeof fetch;
    const assistant = new Assistant(config, store, new OAuth(config, store), {
      connected: async () => { throw new Error('Cash is disconnected'); }, message: async () => { throw new Error('must not reach Cash'); }
    } as any, {} as any, { events: async (who: string, args: any) => {
      calendarReads++; assert.equal(who, sender); assert.equal(args.start, '2026-12-05T00:00:00-03:00');
      return { calendar: 'primary', events: [] };
    } } as any, fetcher, { transcribe: async id => transcripts[id === '123' ? 0 : 1] });
    for (const mediaId of ['123', '124']) await assistant.handle({ id: mediaId, sender, timestamp: Date.now() / 1000, text: '', audio: { mediaId } });
    await assistant.handle({ id: 'typed', sender, timestamp: Date.now() / 1000, text: 'Você tem acesso à agenda do Google?' });
    assert.equal(calendarReads, 3); assert.equal(modelCalls, 6);
    assert.deepEqual((await store.history(sender)).filter(h => h.role === 'user').map(h => h.content), [...transcripts, 'Você tem acesso à agenda do Google?']);
  } finally { await store.close(); }
});

test('voice can query Day with no Cash connection and transcription failure never calls a connector', async () => {
  const store = await createTestStore(config.key);
  try {
    await store.connect({ sender, provider: 'day', accountId: 'day-account', label: 'day@example.test',
      tokens: { access_token: 'day-secret', refresh_token: 'refresh', expires_at: Date.now() + 3600000 } });
    let modelCalls = 0; let reads = 0; let fail = false;
    const assistant = new Assistant(config, store, new OAuth(config, store), { connected: async () => false } as any,
      { subjects: async (who: string) => { reads++; assert.equal(who, sender); return { subjects: [] }; } } as any, {} as any,
      (async () => new Response(JSON.stringify({ output: ++modelCalls === 1
        ? [{ type: 'function_call', name: 'day_subjects', call_id: 'd', arguments: '{"status":"pending","dueBefore":null,"limit":20}' }]
        : [{ type: 'message', content: [{ type: 'output_text', text: 'Sem tarefas pendentes.' }] }] }))) as typeof fetch,
      { transcribe: async () => { if (fail) throw new Error('transcription failed'); return 'Quais tarefas tenho no Day?'; } });
    const voice = { id: 'voice', sender, timestamp: Date.now() / 1000, text: '', audio: { mediaId: '123' } };
    assert.equal((await assistant.handle(voice))[0].text, 'Sem tarefas pendentes.');
    fail = true; await assert.rejects(assistant.handle(voice), /transcription failed/);
    assert.equal(reads, 1); assert.equal(modelCalls, 2);
    await assert.rejects(assistant.handle({ ...voice, button: 'hub:calendar:confirm:' + 'a'.repeat(43) }), /separadamente/);
  } finally { await store.close(); }
});

test('a spoken Calendar request prepares a draft; speech cannot act as its confirmation button', async () => {
  const store = await createTestStore(config.key);
  try {
    await store.connect({ sender, provider: 'calendar', accountId: 'calendar-account', label: 'calendar@example.test',
      tokens: { access_token: 'token', refresh_token: 'refresh', expires_at: Date.now() + 3600000 } });
    const preview = { text: 'Revise o evento.', buttons: [{ id: 'hub:calendar:confirm:' + 'a'.repeat(43), title: 'Confirmar' }] };
    const spoken = 'Crie Show Crossroads dia 23 de dezembro de 2026 das 14h às 17h.';
    let prepared = 0; let confirmed = 0; let modelCalls = 0;
    const assistant = new Assistant(config, store, new OAuth(config, store), { connected: async () => false } as any, {} as any,
      { prepare: async () => { prepared++; return preview; }, confirm: async () => { confirmed++; return { text: 'Criado.' }; } } as any,
      (async () => new Response(JSON.stringify({ output: ++modelCalls === 1 ? [{ type: 'function_call', name: 'calendar_prepare', call_id: 'c', arguments: JSON.stringify({
        operation: 'create', calendarId: 'primary', eventId: null, title: 'Show Crossroads', description: null, location: null,
        start: '2026-12-23T14:00:00-03:00', end: '2026-12-23T17:00:00-03:00', allDay: false, timingEvidence: spoken, reminderMinutes: null
      }) }] : [{ type: 'message', content: [{ type: 'output_text', text: 'Use o botão Confirmar.' }] }] }))) as typeof fetch,
      { transcribe: async id => id === '123' ? spoken : 'Confirmar' });
    const voice = { id: 'voice', sender, timestamp: Date.now() / 1000, text: '', audio: { mediaId: '123' } };
    assert.deepEqual(await assistant.handle(voice), [preview]);
    await assistant.handle({ ...voice, id: 'confirm-voice', audio: { mediaId: '124' } });
    assert.equal(prepared, 1); assert.equal(confirmed, 0);
    await assistant.handle({ id: 'button', sender, timestamp: Date.now() / 1000, text: '', button: preview.buttons[0].id });
    assert.equal(confirmed, 1); assert.equal(modelCalls, 2);
  } finally { await store.close(); }
});
