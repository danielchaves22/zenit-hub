import { z } from 'zod';
import type { Config } from './config.js';
import { equal, metaSignature } from './security.js';
import type { Fetch, Incoming, Reply } from './types.js';
import { jsonRequest } from './http.js';

const incomingSchema = z.object({ id: z.string().min(1).max(256), from: z.string().regex(/^[A-Za-z0-9_.-]{5,128}$/),
  timestamp: z.coerce.number().int().positive(), type: z.string(), text: z.object({ body: z.string().max(8000) }).optional(),
  audio: z.object({ id: z.string().regex(/^\d{1,128}$/) }).optional(),
  interactive: z.object({ button_reply: z.object({ id: z.string().max(256) }).optional() }).optional(),
  button: z.object({ payload: z.string().max(256) }).optional() });
export class WhatsApp {
  constructor(readonly config: Config, private fetcher: Fetch = fetch) {}
  parse(body: Buffer, signature: string): Incoming[] {
    if (!this.config.meta.secret || !equal(metaSignature(body, this.config.meta.secret), signature)) throw new Error('signature');
    const payload = JSON.parse(body.toString('utf8'));
    if (payload.object !== 'whatsapp_business_account') throw new Error('object');
    const messages: Incoming[] = [];
    for (const entry of payload.entry || []) for (const change of entry.changes || []) {
      if (change.field !== 'messages' || change.value?.metadata?.phone_number_id !== this.config.meta.phoneId) continue;
      for (const raw of change.value.messages || []) {
        const parsed = incomingSchema.safeParse(raw);
        if (!parsed.success) continue;
        const message = parsed.data;
        if (this.config.allowedSenders.size && !this.config.allowedSenders.has(message.from)) continue;
        // Ignore old replayed envelopes. A signed webhook does not include an expiry.
        if (Math.abs(Date.now() / 1000 - message.timestamp) > 86400) continue;
        messages.push({ id: message.id, sender: message.from, timestamp: message.timestamp,
          text: message.type === 'text' ? message.text?.body || '' : '',
          button: message.type === 'interactive' ? message.interactive?.button_reply?.id : message.type === 'button' ? message.button?.payload : undefined,
          ...(message.type === 'audio' && message.audio ? { audio: { mediaId: message.audio.id } } : {}) });
      }
    }
    return messages;
  }
  async withTypingIndicator<T>(messageId: string, work: () => Promise<T>): Promise<T> {
    const indicate = async () => {
      if (!this.config.meta.token || !this.config.meta.phoneId) return;
      try {
        await jsonRequest(this.fetcher, `https://graph.facebook.com/${this.config.meta.version}/${this.config.meta.phoneId}/messages`, {
          method: 'POST', headers: { Authorization: `Bearer ${this.config.meta.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId, typing_indicator: { type: 'text' } })
        }, 3000);
      } catch { /* Feedback failure must not prevent the requested operation. */ }
    };
    await indicate();
    const timer = setInterval(() => void indicate(), 20_000); timer.unref();
    try { return await work(); } finally { clearInterval(timer); }
  }
  receipts(body:Buffer,signature:string):{id:string;status:string}[] {
    if(!this.config.meta.secret || !equal(metaSignature(body,this.config.meta.secret),signature)) throw new Error('signature');
    const payload=JSON.parse(body.toString('utf8'));const receipts:{id:string;status:string}[]=[];
    if(payload.object!=='whatsapp_business_account') return receipts;
    for(const e of payload.entry||[]) for(const c of e.changes||[]) {
      if(c.field!=='messages'||c.value?.metadata?.phone_number_id!==this.config.meta.phoneId) continue;
      for(const s of c.value.statuses||[]) if(typeof s.id==='string'&&s.id.length<=256&&['delivered','read','failed'].includes(s.status)) receipts.push({id:s.id,status:s.status});
    }return receipts;
  }
  async send(sender: string, reply: Reply) {
    const token = this.config.meta.token;
    if (!token || !this.config.meta.phoneId) throw new Error('WhatsApp not configured');
    const chunks = reply.text.match(/[\s\S]{1,3500}/gu) || ['Sem resposta.'];
    if (reply.buttons && (reply.buttons.length > 3 || reply.buttons.some(b => b.id.length > 256 || b.title.length > 20))) throw new Error('Invalid buttons');
    if (reply.buttons && reply.text.length <= 1024) {
      await this.post(sender, { type: 'interactive', interactive: { type: 'button', body: { text: reply.text },
        action: { buttons: reply.buttons.map(reply => ({ type: 'reply', reply })) } } });
    } else {
      for (const body of chunks) await this.post(sender, { type: 'text', text: { body, preview_url: false } });
      if (reply.buttons) await this.post(sender, { type: 'interactive', interactive: { type: 'button', body: { text: 'Escolha uma opção:' },
        action: { buttons: reply.buttons.map(reply => ({ type: 'reply', reply })) } } });
    }
  }
  private post(to: string, content: unknown) {
    return jsonRequest(this.fetcher, `https://graph.facebook.com/${this.config.meta.version}/${this.config.meta.phoneId}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.config.meta.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...content as object })
    });
  }
}
