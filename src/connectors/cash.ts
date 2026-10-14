import { randomBytes } from 'node:crypto';
import { bridgeSignature } from '../security.js';
import { jsonRequest } from '../http.js';
import type { Config } from '../config.js';
import type { Fetch, Incoming, Reply } from '../types.js';
import { PublicError } from '../types.js';
import { z } from 'zod';

export const workspaceSchema = z.object({ id: z.number().int().positive(), name: z.string().min(1),
  personal: z.boolean(), reference: z.string().min(1), cash: z.boolean().optional(), bizz: z.boolean().optional() });
export type Workspace = z.infer<typeof workspaceSchema>;
export type CashStatus = { connected: boolean; workspace: Workspace | null; workspaces: Workspace[] };

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
  async status(sender: string): Promise<CashStatus> {
    if (!this.enabled) return { connected: false, workspace: null, workspaces: [] };
    return z.object({ connected: z.boolean(), workspace: workspaceSchema.nullable(), workspaces: z.array(workspaceSchema) })
      .parse(await this.call({ operation: 'workspaces', sender }));
  }
  async selectWorkspace(sender: string, workspaceId: number) {
    return workspaceSchema.parse((await this.call({ operation: 'select_workspace', sender, workspaceId })).workspace);
  }
  async messageResult(message: Incoming, workspaceId?: number): Promise<{ replies: Reply[]; workspace?: Workspace }> {
    const response = await this.call({ operation: 'message', sender: message.sender, messageId: message.id,
      text: message.text, ...(workspaceId ? { workspaceId } : {}), ...(message.button ? { buttonId: message.button } : {}), ...(message.audio ? { audio: message.audio } : {}) });
    if (!Array.isArray(response.replies)) throw new PublicError('Resposta inválida do Cash.');
    return { replies: response.replies, ...(response.workspace ? { workspace: workspaceSchema.parse(response.workspace) } : {}) };
  }
  async message(message: Incoming, workspaceId?: number): Promise<Reply[]> { return (await this.messageResult(message, workspaceId)).replies; }
  query(sender: string, tool: string, args: Record<string, unknown>, workspaceId?: number) { return this.call({ operation: 'query', sender, tool, args, ...(workspaceId ? { workspaceId } : {}) }); }
  disconnect(sender: string) { return this.call({ operation: 'disconnect', sender }); }
}
