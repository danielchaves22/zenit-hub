import type { Assistant } from './assistant.js';
import type { Store } from './store.js';
import type { WhatsApp } from './whatsapp.js';
import { PublicError } from './types.js';
export class Worker {
  private running = false;
  constructor(readonly store: Store, readonly assistant: Assistant, readonly whatsapp: WhatsApp) {}
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const message = this.store.nextMessage();
      if (message) {
        try {
          const replies = message.text || message.button || message.audio
            ? await this.whatsapp.withTypingIndicator(message.id, () => this.assistant.handle(message))
            : [{ text: 'Envie texto para consultar suas conexões ou uma mensagem de voz para falar com o Cash.' }];
          this.store.complete(message, replies);
        } catch (error) {
          this.store.fail(message.id);
          this.store.sendLater(message.sender, { text: error instanceof PublicError ? error.message : 'Não foi possível concluir. Consulte o estado antes de repetir uma operação.' });
          console.error('hub.message.failed');
        }
      }
      let outgoing;
      while ((outgoing = this.store.nextReply())) {
        try { await this.whatsapp.send(outgoing.sender, outgoing.reply); this.store.sent(outgoing.id, true); }
        catch { this.store.sent(outgoing.id, false); console.error('hub.reply.uncertain'); }
      }
      this.store.prune();
    } finally { this.running = false; }
  }
}
