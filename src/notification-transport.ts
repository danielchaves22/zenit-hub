import type { Config } from './config.js';
import type { Fetch } from './types.js';
import { jsonRequest } from './http.js';
import { PublicError } from './types.js';
import type { NotificationKind } from './notification-store.js';

export class NotificationTransport {
  private cache = new Map<string, { at: number; approved: boolean; snooze: boolean }>();
  constructor(
    readonly config: Config,
    private fetcher: Fetch = fetch,
  ) {}
  name(kind: NotificationKind, confirmation = false) {
    if(kind==='day_reminders'&&confirmation) return this.config.notifications.confirmationTemplate;
    return kind === 'daily_summary'
      ? this.config.notifications.summaryTemplate
      : this.config.notifications.reminderTemplate;
  }
  async approved(kind: NotificationKind, refresh = false, confirmation = false) {
    if (kind === 'day_reminders' && confirmation && await this.snoozeApproved(refresh)) return true;
    return (await this.inspect(this.name(kind,confirmation),refresh)).approved;
  }
  async snoozeApproved(refresh = false) {
    return (await this.inspect(this.config.notifications.snoozeTemplate,refresh)).snooze;
  }
  private async inspect(name: string, refresh: boolean) {
    const id = this.config.notifications.wabaId;
    if (!name || !id || !this.config.meta.token || !this.config.meta.phoneId) return { at: Date.now(), approved: false, snooze: false };
    const cached = this.cache.get(name);
    if (!refresh && cached && Date.now() - cached.at < 60_000) return cached;
    const p = new URLSearchParams({ name, fields: 'name,status,language,category,components', limit: '100' });
    const result = await jsonRequest(
      this.fetcher,
      `https://graph.facebook.com/${this.config.meta.version}/${id}/message_templates?${p}`,
      { headers: { Authorization: `Bearer ${this.config.meta.token}` } },
      10_000,
    );
    const template =
      result.data?.find(
        (t: any) =>
          t.name === name && t.language === this.config.notifications.language && t.status === 'APPROVED',
      );
    const buttons = template?.components?.find((c: any) => c.type === 'BUTTONS')?.buttons;
    const entry = { at: Date.now(), approved: Boolean(template), snooze: template?.category === 'UTILITY' && Array.isArray(buttons) && buttons.length === 2 &&
      buttons[0].type === 'QUICK_REPLY' && buttons[0].text === 'Concluído' && buttons[1].type === 'QUICK_REPLY' && buttons[1].text === 'Adiar' };
    this.cache.set(name, entry);
    return entry;
  }
  async require(kind: NotificationKind, confirmation = false) {
    if (!(await this.approved(kind, false, confirmation)))
      throw new PublicError(
        'O envio desta notificação ainda aguarda a configuração ou aprovação do modelo pelo WhatsApp. Nenhuma configuração foi salva. Envie "notificações" para consultar o estado.',
      );
  }
  async send(sender: string, kind: NotificationKind, values: string[], completionButton?: string) {
    if(completionButton && (kind!=='day_reminders'||!/^hub:done:[A-Za-z0-9_-]{43}$/.test(completionButton))) throw new Error('Invalid reminder button');
    if (values.length !== (kind === 'daily_summary' ? 4 : 2)) throw new Error('Invalid template parameters');
    const snooze = Boolean(completionButton) && await this.snoozeApproved();
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
            name: snooze ? this.config.notifications.snoozeTemplate : this.name(kind, Boolean(completionButton)),
            language: { code: this.config.notifications.language },
            components: [
              {
                type: 'body',
                parameters: values.map((text) => ({ type: 'text', text: text.replace(/\s+/g, ' ').trim() })),
              },
              ...(completionButton?[{type:'button',sub_type:'quick_reply',index:'0',parameters:[{type:'payload',payload:completionButton}]}]:[]),
              ...(snooze?[{type:'button',sub_type:'quick_reply',index:'1',parameters:[{type:'payload',payload:completionButton!.replace('hub:done:','hub:snooze:')}]}]:[]),
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
