import { z } from 'zod';
import { OAuth } from '../oauth.js';
import { jsonRequest } from '../http.js';
import { PublicError, type Fetch } from '../types.js';

export const dayQuery = z.object({ status: z.enum(['pending', 'todo', 'doing', 'waiting', 'blocked', 'done']).default('pending'),
  dueBefore: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null), limit: z.number().int().min(1).max(50).default(20) }).strict();
export class Day {
  constructor(private oauth: OAuth, private fetcher: Fetch = fetch) {}
  async rpc(sender: string, name: string, body: unknown) {
    const c=await this.oauth.connection(sender,'day');
    return jsonRequest(this.fetcher,`${this.oauth.config.day.url}/rest/v1/rpc/${name}`,{method:'POST',body:JSON.stringify(body),
      headers:{'Content-Type':'application/json',apikey:this.oauth.config.day.key,Authorization:`Bearer ${c.tokens.access_token}`}});
  }
  async remindersAuthorized(sender: string) {
    const result=await this.rpc(sender,'zenit_day_hub_reminders_check',{});return result.authorized===true;
  }
  async requireReminders(sender: string) {
    if (!await this.remindersAuthorized(sender)) throw new PublicError(`Autorize primeiro os lembretes na conta do Day conectada ao Hub: ${this.oauth.config.day.siteUrl}/hub/reminders. Depois envie "ativar lembretes do Day".`);
  }
  async reminders(sender: string, id?: string, filter: {search?: string|null;limit?: number} = {}) {
    await this.requireReminders(sender);const c=await this.oauth.connection(sender,'day');
    const limit=z.number().int().min(1).max(20).parse(filter.limit??20);
    const search=z.string().max(100).nullable().parse(filter.search??null);
    const p=new URLSearchParams({select:'id,title,subject_id,enabled,deleted,schedule,revision',user_id:`eq.${c.accountId}`,deleted:'eq.false',order:'title.asc,id.asc',limit:String(limit+1)});
    if(id) p.set('id',`eq.${z.string().uuid().parse(id)}`);
    if(search) p.set('title',`ilike.%${search.replace(/[%_\\]/g,'\\$&')}%`);
    const rows=await jsonRequest(this.fetcher,`${this.oauth.config.day.url}/rest/v1/zenit_day_reminders?${p}`,{headers:{apikey:this.oauth.config.day.key,Authorization:`Bearer ${c.tokens.access_token}`}});
    if(!Array.isArray(rows)) throw new Error('Invalid reminders');return {items:rows.slice(0,limit),truncated:rows.length>limit};
  }
  occurrences(sender: string,after: number,until: number) { return this.rpc(sender,'zenit_day_reminder_occurrences',{p_after:new Date(after).toISOString(),p_until:new Date(until).toISOString()}); }
  saveReminder(sender: string,operationId: string,id: string,revision: number,doc: unknown) {
    return this.rpc(sender,'zenit_day_save_reminder',{p_operation_id:operationId,p_reminder_id:id,p_expected_revision:revision,p_reminder:doc});
  }
  async previewReminder(sender: string,schedule: unknown,after=Date.now()-1000) {
    const next: string[]=[];
    for(let i=0;i<3;i++) { const at=await this.rpc(sender,'zenit_day_next_reminder',{s:schedule,p_after:new Date(after).toISOString()});
      if(!at) break;next.push(at);after=Date.parse(at); }
    return next;
  }
  async daily(sender: string,date: string) {
    const c=await this.oauth.connection(sender,'day');
    const p=new URLSearchParams({select:'id,title,status,next_action,review_on,due_on,priority,daily_goal,daily_goal_on',user_id:`eq.${c.accountId}`,archived:'eq.false',status:'neq.done',
      or:`(due_on.lte.${date},review_on.lte.${date},and(daily_goal_on.eq.${date},daily_goal.neq.not_today))`,order:'due_on.asc.nullslast,review_on.asc.nullslast',limit:'51'});
    const rows=await jsonRequest(this.fetcher,`${this.oauth.config.day.url}/rest/v1/zenit_day_subjects?${p}`,{headers:{apikey:this.oauth.config.day.key,Authorization:`Bearer ${c.tokens.access_token}`}});
    if(!Array.isArray(rows)) throw new Error('Invalid Day response');return {items:rows.slice(0,50),truncated:rows.length>50};
  }
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
