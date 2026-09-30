import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { AudioTranscriber, MAX_AUDIO_BYTES } from '../src/audio.js';
import { readConfig } from '../src/config.js';
import { PublicError, type Fetch } from '../src/types.js';

const config = readConfig({ DATABASE_URL: 'postgresql://test:test@localhost/zenit_hub_test', HUB_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  WHATSAPP_PHONE_NUMBER_ID: 'phone-1', WHATSAPP_ACCESS_TOKEN: 'meta-private', OPENAI_API_KEY: 'ai-private' });
const bytes = Buffer.from('synthetic-audio');
const metadata = { url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?synthetic=1', mime_type: 'audio/ogg; codecs=opus',
  file_size: bytes.length, sha256: createHash('sha256').update(bytes).digest('base64') };
const json = (data: unknown) => new Response(JSON.stringify(data));

test('Hub downloads authenticated Meta audio and transcribes with neutral context; credentials never cross providers', async () => {
  for (const model of ['gpt-transcribe', 'gpt-4o-mini-transcribe']) {
    let calls = 0;
    const transcriber = new AudioTranscriber({ ...config, ai: { ...config.ai, transcriptionModel: model } }, (async (url, init) => {
      calls++;
      assert.equal(init?.redirect, 'error'); assert(init?.signal);
      const authorization = new Headers(init?.headers).get('Authorization');
      if (calls === 1) {
        assert.equal(String(url), 'https://graph.facebook.com/v23.0/123?phone_number_id=phone-1');
        assert.equal(authorization, 'Bearer meta-private'); return json(metadata);
      }
      if (calls === 2) { assert.equal(String(url), metadata.url); assert.equal(authorization, 'Bearer meta-private'); return new Response(bytes); }
      assert.equal(String(url), 'https://api.openai.com/v1/audio/transcriptions'); assert.equal(authorization, 'Bearer ai-private');
      const form = init!.body as FormData;
      assert.equal(form.get('model'), model); assert.equal(form.get('response_format'), 'json');
      assert.equal(form.get(model === 'gpt-transcribe' ? 'languages[]' : 'language'), 'pt');
      assert.equal(form.get(model === 'gpt-transcribe' ? 'language' : 'languages[]'), null);
      assert(!String(form.get('prompt')).includes('finance')); assert.equal(form.get('keywords[]'), null);
      const file = form.get('file') as File;
      assert.equal(file.name, 'mensagem.ogg'); assert.equal(file.type, 'audio/ogg'); assert.equal(file.size, bytes.length);
      return json({ text: '  Tenho compromissos no primeiro final de semana de dezembro?  ' });
    }) as Fetch);
    assert.equal(await transcriber.transcribe('123'), 'Tenho compromissos no primeiro final de semana de dezembro?');
    assert.equal(calls, 3);
  }
});

test('untrusted media destinations, invalid IDs, sizes and types fail before credentials or audio can be forwarded', async () => {
  const badMetadata = [
    ...['https://attacker.test/audio', 'https://fbsbx.com.attacker.test/audio', 'http://lookaside.fbsbx.com/audio',
      'https://user:password@lookaside.fbsbx.com/audio', 'https://lookaside.fbsbx.com:444/audio', 'http://127.0.0.1/audio'].map(url => ({ ...metadata, url })),
    { ...metadata, file_size: MAX_AUDIO_BYTES + 1 }, { ...metadata, file_size: 0 }, { ...metadata, mime_type: 'text/html' }
  ];
  for (const bad of badMetadata) {
    let calls = 0;
    const transcriber = new AudioTranscriber(config, (async () => { calls++; return json(bad); }) as Fetch);
    await assert.rejects(transcriber.transcribe('123'), PublicError); assert.equal(calls, 1);
  }
  let calls = 0;
  const transcriber = new AudioTranscriber(config, (async () => { calls++; throw new Error(); }) as Fetch);
  await assert.rejects(transcriber.transcribe('https://attacker.test'), PublicError); assert.equal(calls, 0);
});

test('download size and checksum are enforced even when metadata or content-length underreport the stream', async () => {
  for (const scenario of ['stream', 'header', 'checksum', 'empty', 'redirect']) {
    let calls = 0; let cancelled = false;
    const transcriber = new AudioTranscriber(config, (async () => {
      if (++calls === 1) return json(scenario === 'checksum' ? { ...metadata, sha256: '00'.repeat(32) } : metadata);
      if (scenario === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://attacker.test' } });
      if (scenario === 'header') return new Response(bytes, { headers: { 'Content-Length': String(MAX_AUDIO_BYTES + 1) } });
      if (scenario === 'empty') return new Response(new Uint8Array());
      if (scenario === 'checksum') return new Response(bytes);
      return new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(MAX_AUDIO_BYTES + 1)); }, cancel() { cancelled = true; }
      }), { headers: { 'Content-Length': '1' } });
    }) as Fetch);
    await assert.rejects(transcriber.transcribe('123'), PublicError); assert.equal(calls, 2);
    if (scenario === 'stream') assert(cancelled);
  }
});

test('bad or unavailable transcripts return a safe error and are not retried', async () => {
  for (const scenario of ['empty', 'long', 'malformed', 'provider', 'network']) {
    let calls = 0;
    const transcriber = new AudioTranscriber(config, (async () => {
      if (++calls === 1) return json(metadata);
      if (calls === 2) return new Response(bytes);
      if (scenario === 'network') throw new Error('ai-private provider details');
      if (scenario === 'provider') return new Response('ai-private provider details', { status: 429 });
      if (scenario === 'malformed') return new Response('ai-private invalid JSON');
      return json({ text: scenario === 'long' ? 'a'.repeat(6001) : '  ' });
    }) as Fetch);
    await assert.rejects(transcriber.transcribe('123'), error => error instanceof PublicError && !error.message.includes('ai-private'));
    assert.equal(calls, 3);
  }
});
