import { randomBytes } from 'node:crypto';
import { bridgeSignature } from '../security.js';
import { jsonRequest } from '../http.js';
import type { Config } from '../config.js';
import type { Fetch, Incoming, Reply } from '../types.js';
import { PublicError } from '../types.js';

export class Cash {
  constructor(private config: Config['cash'], private fetcher: Fetch = fetch) {}
  get enabled() { return Boolean(this.config.url && this.config.secret.length >= 32); }
  async call(body: Record<string, unknown>) {
    if (!this.enabled) throw new PublicError('O conector Cash ainda precisa ser configurado no Hub.');
    const path = '/api/integrations/hub/bridge';
    const text = JSON.stringify(body); const time = String(Date.now()); const nonce = randomBytes(16).toString('hex');
    return jsonRequest(this.fetcher, this.config.url + path, { method: 'POST', body: text, headers: {
      'Content-Type': 'application/json', 'X-Hub-Timestamp': time, 'X-Hub-Nonce': nonce,
      'X-Hub-Signature': bridgeSignature(text, time, nonce, path, this.config.secret)
    } }, body.operation === 'message' ? 240_000 : 45_000);
  }
  async connected(sender: string) { return this.enabled && (await this.call({ operation: 'status', sender })).connected === true; }
  async message(message: Incoming): Promise<Reply[]> {
    const response = await this.call({ operation: 'message', sender: message.sender, messageId: message.id,
      text: message.text, ...(message.button ? { buttonId: message.button } : {}), ...(message.audio ? { audio: message.audio } : {}) });
    if (!Array.isArray(response.replies)) throw new PublicError('Resposta inválida do Cash.');
    return response.replies;
  }
  query(sender: string, tool: string, args: Record<string, unknown>) { return this.call({ operation: 'query', sender, tool, args }); }
  disconnect(sender: string) { return this.call({ operation: 'disconnect', sender }); }
}
