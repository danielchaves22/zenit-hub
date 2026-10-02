import type { Config } from './config.js';
import type { Fetch } from './types.js';
import { jsonRequest } from './http.js';
import { PublicError } from './types.js';
import type { NotificationKind } from './notification-store.js';

export class NotificationTransport {
  private cache = new Map<string, { at: number; approved: boolean }>();
  constructor(
    readonly config: Config,
    private fetcher: Fetch = fetch,
  ) {}
  name(kind: NotificationKind) {
    return kind === 'daily_summary'
      ? this.config.notifications.summaryTemplate
      : this.config.notifications.reminderTemplate;
  }
  async approved(kind: NotificationKind, refresh = false) {
    const name = this.name(kind),
      id = this.config.notifications.wabaId;
    if (!name || !id || !this.config.meta.token || !this.config.meta.phoneId) return false;
    const cached = this.cache.get(name);
    if (!refresh && cached && Date.now() - cached.at < 60_000) return cached.approved;
    const p = new URLSearchParams({ name, fields: 'name,status,language', limit: '100' });
    const result = await jsonRequest(
      this.fetcher,
      `https://graph.facebook.com/${this.config.meta.version}/${id}/message_templates?${p}`,
      { headers: { Authorization: `Bearer ${this.config.meta.token}` } },
      10_000,
    );
    const approved =
      result.data?.some(
        (t: any) =>
          t.name === name && t.language === this.config.notifications.language && t.status === 'APPROVED',
      ) === true;
    this.cache.set(name, { at: Date.now(), approved });
    return approved;
  }
  async require(kind: NotificationKind) {
    if (!(await this.approved(kind)))
      throw new PublicError(
        'O envio desta notificação ainda aguarda a configuração ou aprovação do modelo pelo WhatsApp. A assinatura não foi ativada. Envie "notificações" para consultar o estado.',
      );
  }
  async send(sender: string, kind: NotificationKind, values: string[]) {
    if (values.length !== (kind === 'daily_summary' ? 4 : 2)) throw new Error('Invalid template parameters');
    const result = await jsonRequest(
      this.fetcher,
      `https://graph.facebook.com/${this.config.meta.version}/${this.config.meta.phoneId}/messages`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.meta.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: sender,
          type: 'template',
          template: {
            name: this.name(kind),
            language: { code: this.config.notifications.language },
            components: [
              {
                type: 'body',
                parameters: values.map((text) => ({ type: 'text', text: text.replace(/\s+/g, ' ').trim() })),
              },
            ],
          },
        }),
      },
      15_000,
    );
    const id = result.messages?.[0]?.id;
    if (typeof id !== 'string') throw new Error('Missing WhatsApp message id');
    return id;
  }
}
