import { createHash, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';
import { PublicError, type Fetch } from './types.js';

export const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const extensions: Record<string, string> = {
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm', 'audio/flac': 'flac'
};
const unavailable = 'Não consegui processar este áudio agora. Envie novamente ou escreva o pedido. Nenhuma operação foi executada a partir dele.';
const invalidSize = 'O áudio está vazio ou ultrapassa 16 MB. Envie um áudio menor ou escreva o pedido.';

async function readBounded(response: Response, max: number): Promise<Buffer> {
  if (!response.body) throw new Error('Missing response body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    const length = response.headers.get('content-length');
    if (length && (!Number.isSafeInteger(Number(length)) || Number(length) < 0 || Number(length) > max)) throw new Error('Body limit');
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > max) throw new Error('Body limit');
      chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Voice is a channel input: no source account, financial prompt or domain routing here. */
export class AudioTranscriber {
  constructor(private config: Config, private fetcher: Fetch = fetch) {}

  private async request(url: string, init: RequestInit, timeoutMs: number) {
    const response = await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Audio service unavailable'); }
    return response;
  }

  async transcribe(mediaId: string): Promise<string> {
    if (!this.config.ai.key || !this.config.meta.token || !this.config.meta.phoneId) {
      throw new PublicError('A transcrição de áudio ainda precisa ser configurada no Hub. Por enquanto, envie texto.');
    }
    try {
      if (!/^\d{1,128}$/.test(mediaId)) throw new Error('Invalid media ID');
      const headers = { Authorization: `Bearer ${this.config.meta.token}` };
      const endpoint = new URL(`https://graph.facebook.com/${this.config.meta.version}/${mediaId}`);
      endpoint.searchParams.set('phone_number_id', this.config.meta.phoneId);
      const metadata = JSON.parse((await readBounded(await this.request(endpoint.toString(), { headers }, 15_000), 16_384)).toString());
      if (!Number.isSafeInteger(metadata.file_size) || metadata.file_size <= 0 || metadata.file_size > MAX_AUDIO_BYTES) throw new PublicError(invalidSize);
      const mimeType = String(metadata.mime_type || '').split(';')[0].trim().toLowerCase();
      const extension = extensions[mimeType];
      if (!extension) throw new PublicError('Não consigo ler este formato de áudio. Grave pelo microfone do WhatsApp ou envie texto.');
      const url = new URL(metadata.url);
      // Meta credentials only go to Meta's media hosts, never inbound URLs or redirects.
      if (url.protocol !== 'https:' || url.username || url.password || url.port ||
          !['fbsbx.com', 'fbcdn.net'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) throw new Error('Untrusted media host');
      const buffer = await readBounded(await this.request(url.toString(), { headers }, 30_000), MAX_AUDIO_BYTES);
      if (buffer.length !== metadata.file_size) throw new Error('Media size mismatch');
      if (metadata.sha256) {
        const expected = Buffer.from(metadata.sha256, /^[a-f0-9]{64}$/i.test(metadata.sha256) ? 'hex' : 'base64');
        const actual = createHash('sha256').update(buffer).digest();
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('Media checksum mismatch');
      }
      const model = this.config.ai.transcriptionModel;
      const form = new FormData();
      form.append('model', model);
      form.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), `mensagem.${extension}`);
      form.append(model.startsWith('gpt-transcribe') ? 'languages[]' : 'language', 'pt');
      form.append('prompt', 'Mensagem em português brasileiro. Preserve nomes, datas, horários e valores. Transcreva somente o que foi falado, sem responder nem completar informações.');
      form.append('response_format', 'json');
      const result = JSON.parse((await readBounded(await this.request('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST', headers: { Authorization: `Bearer ${this.config.ai.key}` }, body: form
      }, 60_000), 65_536)).toString());
      const text = typeof result.text === 'string' ? result.text.trim() : '';
      if (!text) throw new PublicError('Não consegui entender uma fala neste áudio. Grave novamente com mais clareza ou envie texto.');
      if (text.length > 6000) throw new PublicError('Este áudio ficou longo demais para um único pedido. Envie uma mensagem mais curta.');
      return text;
    } catch (error) {
      // Never expose provider responses, URLs, tokens or audio in errors/logs.
      throw error instanceof PublicError ? error : new PublicError(unavailable);
    }
  }
}
