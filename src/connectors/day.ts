import { z } from 'zod';
import { OAuth } from '../oauth.js';
import { jsonRequest } from '../http.js';
import type { Fetch } from '../types.js';

export const dayQuery = z.object({ status: z.enum(['pending', 'todo', 'doing', 'waiting', 'blocked', 'done']).default('pending'),
  dueBefore: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null), limit: z.number().int().min(1).max(50).default(20) }).strict();
export class Day {
  constructor(private oauth: OAuth, private fetcher: Fetch = fetch) {}
  async subjects(sender: string, input: unknown) {
    const args = dayQuery.parse(input); const c = await this.oauth.connection(sender, 'day');
    const p = new URLSearchParams({ select: 'id,title,status,next_action,review_on,due_on,project', archived: 'eq.false',
      user_id: `eq.${c.accountId}`, order: 'due_on.asc.nullslast,created_at.desc', limit: String(args.limit + 1),
      status: args.status === 'pending' ? 'neq.done' : `eq.${args.status}` });
    if (args.dueBefore) p.set('due_on', `lte.${args.dueBefore}`);
    const rows = await jsonRequest(this.fetcher, `${this.oauth.config.day.url}/rest/v1/zenit_day_subjects?${p}`, {
      headers: { apikey: this.oauth.config.day.key, Authorization: `Bearer ${c.tokens.access_token}` }
    });
    if (!Array.isArray(rows)) throw new Error('Invalid Day response');
    return { subjects: rows.slice(0, args.limit), truncated: rows.length > args.limit,
      note: 'Dados sincronizados do Day. review_on é retomada; due_on é prazo. Alterações ainda offline não aparecem.' };
  }
}
