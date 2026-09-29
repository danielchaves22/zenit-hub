import type { Assistant } from './assistant.js';
import type { Store } from './store.js';
import type { WhatsApp } from './whatsapp.js';
import { PublicError } from './types.js';
export class Worker {
  private current?: Promise<void>;
  private stopping = false;
  private prunedAt = 0;
  constructor(readonly store: Store, readonly assistant: Assistant, readonly whatsapp: WhatsApp) {}
  tick(): Promise<void> {
    if (this.current || this.stopping) return Promise.resolve();
    this.current = this.run().finally(() => { this.current = undefined; });
    return this.current;
  }
  async stop() { this.stopping = true; await this.current; }
  private async run() {
    if (!await this.store.startWorker()) return;
    const message = await this.store.nextMessage();
    if (message) {
      try {
        const replies = message.text || message.button || message.audio
          ? await this.whatsapp.withTypingIndicator(message.id, () => this.assistant.handle(message))
          : [{ text: 'Envie texto para consultar suas conexões ou uma mensagem de voz para falar com o Cash.' }];
        await this.store.complete(message, replies);
      } catch (error) {
        await this.store.fail(message.id);
        await this.store.sendLater(message.sender, { text: error instanceof PublicError ? error.message : 'Não foi possível concluir. Consulte o estado antes de repetir uma operação.' });
        console.error('hub.message.failed');
      }
    }
    let outgoing;
    while (!this.stopping && (outgoing = await this.store.nextReply())) {
      try { await this.whatsapp.send(outgoing.sender, outgoing.reply); await this.store.sent(outgoing.id, true); }
      catch { await this.store.sent(outgoing.id, false); console.error('hub.reply.uncertain'); }
    }
    if (Date.now() - this.prunedAt > 60_000) { await this.store.prune(); this.prunedAt = Date.now(); }
  }
}
