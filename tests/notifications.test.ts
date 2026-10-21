import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readConfig } from '../src/config.js';
import { createTestStore } from './database-helper.js';
import { Notifications, reminderChange } from '../src/notifications.js';
import { Assistant } from '../src/assistant.js';
import { OAuth } from '../src/oauth.js';
import { Day } from '../src/connectors/day.js';
import { NotificationTransport } from '../src/notification-transport.js';
import { WhatsApp } from '../src/whatsapp.js';
import { metaSignature } from '../src/security.js';
import { ConnectionAccessError, ReminderConsentError } from '../src/types.js';
import { Worker } from '../src/worker.js';
import { HttpError } from '../src/http.js';

const config = readConfig({
  DATABASE_URL: 'postgres://test@localhost/zenit_hub_test',
  HUB_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  OPENAI_API_KEY: 'test-model-secret',
  OPENAI_MODEL: 'test',
  DAY_SITE_URL: 'https://day.example.test',
  WHATSAPP_APP_SECRET: 'signature-secret',
  WHATSAPP_PHONE_NUMBER_ID: 'phone',
  WHATSAPP_ACCESS_TOKEN: 'meta-secret',
  WHATSAPP_BUSINESS_ACCOUNT_ID: 'waba',
  WHATSAPP_SUMMARY_TEMPLATE: 'zenit_daily_summary_v1',
  WHATSAPP_REMINDER_TEMPLATE: 'zenit_day_reminder_v1',
});
const sender = 'alice';
const schedule = {
  kind: 'daily',
  timeZone: 'America/Sao_Paulo',
  startAt: new Date().toISOString(),
  endAt: null,
  times: ['07:00', '15:00', '23:00'],
  weekDays: [],
  monthDay: null,
  intervalMinutes: null,
  windowStart: null,
  windowEnd: null,
};
const token = (r: any) => r.buttons[0].id.split(':').at(-1)!;
async function fixture() {
  const store = await createTestStore(config.key);
  const connect = async (account = 'day-account') =>
    store.connect({
      sender,
      provider: 'day',
      accountId: account,
      label: 'test@example.test',
      tokens: {
        access_token: 'private-day',
        refresh_token: 'private-refresh',
        expires_at: Date.now() + 3600_000,
      },
    });
  await connect();
  const state = {
    authorized: true,
    approved: true,
    occurrences: [] as any[],
    reminders: [] as any[],
    sent: [] as any[],
    writes: [] as any[],
    failSend: false,
    pollError: null as Error | null,
    completionError: null as Error | null,
    completed: new Set<string>(),
  };
  const day = {
    occurrenceState: async (_s:string,id:string,revision:number,due:number) => {
      if(state.pollError) throw state.pollError;
      if(!state.authorized) throw new ReminderConsentError('consent required');
      const r=state.reminders.find(r=>r.id===id);
      if(!r||r.revision!==revision||!r.enabled||r.deleted||state.occurrences.some(o=>o.id===id&&Date.parse(o.dueAt)>due)) return {state:'obsolete'};
      return {state:state.completed.has(`${id}:${revision}:${due}`)?'completed':'pending',reminder:r,validUntil:r.validUntil??new Date(Date.now()+10*86400_000).toISOString()};
    },
    completeReminder: async (_s:string,id:string,revision:number,due:number) => {
      if(state.completionError) throw state.completionError;
      const result=await day.occurrenceState(_s,id,revision,due);
      if(result.state==='obsolete') return result;
      state.completed.add(`${id}:${revision}:${due}`);
      return {state:'completed'};
    },
    remindersAuthorized: async () => state.authorized,
    requireReminders: async () => {
      if (!state.authorized) throw new ReminderConsentError('consent required');
    },
    occurrences: async () => {
      if (state.pollError) throw state.pollError;
      return { items: state.occurrences, truncated: false };
    },
    reminders: async (_s: string, id?: string, filter: {search?: string|null;limit?: number} = {}) => {
      if (!state.authorized) throw new Error('revoked');
      const items = state.reminders.filter((r) => (!id || r.id === id) && !r.deleted && (!filter.search || r.title.toLowerCase().includes(filter.search.toLowerCase())));
      const limit = filter.limit ?? 20;
      return { items: items.slice(0, limit), truncated: items.length > limit };
    },
    daily: async () => ({ items: [], truncated: false }),
    previewReminder: async () => [new Date(Date.now() + 86400_000).toISOString()],
    saveReminder: async (...args: any[]) => {
      state.writes.push(args);
      return { result: 'saved' };
    },
  };
  const cash = { connected: async () => false };
  const transport = {
    approved: async () => state.approved,
    require: async () => {
      if (!state.approved) throw new Error('template unavailable');
    },
    send: async (...args: any[]) => {
      state.sent.push(args);
      if (state.failSend) throw new Error('timeout');
      return `wamid.${state.sent.length}`;
    },
  };
  const n = new Notifications(config, store, day as any, cash as any, {} as any, transport as any);
  const subscribe = async () => {
    const r = await n.prepare(sender, {
      kind: 'day_reminders',
      time: null,
      timeZone: config.timeZone,
      sources: ['day'],
    });
    await n.confirm(sender, token(r), true);
    return (await n.db.subscription(sender, 'day_reminders'))!;
  };
  return { store, state, day, cash, n, subscribe, connect };
}

const savedReminder = (title: string, overrides: Record<string, unknown> = {}) => ({
  id: randomUUID(), revision: 1, title, enabled: true, deleted: false, subject_id: null,
  schedule, requires_confirmation: false, repeat_minutes: 5, respect_quiet_hours: true, ...overrides,
});

test('numbered deletion uses the displayed snapshot, survives restart and still requires the owner confirmation', async () => {
  const f = await fixture();
  try {
    f.state.reminders = [savedReminder('Livro da Cibele'), savedReminder('Remédio')];
    const selectedId = f.state.reminders[1].id;
    const a = new Assistant(config,f.store,new OAuth(config,f.store),f.cash as any,f.day as any,{} as any,
      async () => { throw new Error('Numbered deletion must not call AI'); },undefined,f.n);
    const send = (text: string, button?: string) => a.handle({id:randomUUID(),sender,text,button,timestamp:Date.now()/1000});
    const [list] = await send('Como remover um lembrete?');
    assert.match(list.text,/1\. Livro da Cibele/);
    assert.match(list.text,/2\. Remédio/);
    assert.match(list.text,/somente com o número/);
    assert.equal(f.state.writes.length,0);
    assert.match((await f.n.command('bob','excluir 2'))!.text,/nova lista/);
    const raw = JSON.stringify((await f.store.db.query('SELECT data FROM notification_drafts')).rows);
    assert(!raw.includes(selectedId));
    f.state.reminders.reverse();
    const restarted = new Notifications(config,f.store,f.day as any,f.cash as any,{} as any);
    const review = (await restarted.command(sender,'2'))!;
    assert.match(review.text,/Remédio/);
    assert.match(review.text,/Estado após confirmar: excluído/);
    assert(!review.text.includes('Livro da Cibele'));
    assert.equal(f.state.writes.length,0);
    await restarted.confirm('bob',token(review),true);
    assert.equal(f.state.writes.length,0);
    await send('',review.buttons![0].id);
    await send('',review.buttons![0].id);
    assert.equal(f.state.writes.length,1);
    assert.equal(f.state.writes[0][2],selectedId);
    assert.equal(f.state.writes[0][3],1);
    assert.equal(f.state.writes[0][4].deleted,true);
  } finally { await f.store.close(); }
});

test('listing requires explicit deletion intent and supports cancellation, filtering and bounded results', async () => {
  const f = await fixture();
  try {
    f.state.reminders = Array.from({length:12},(_,i)=>savedReminder(`Lembrete ${i+1}`));
    const list = (await f.n.command(sender,'meus lembretes'))!;
    assert.match(list.text,/10\. Lembrete 10/);
    assert(!list.text.includes('11. Lembrete 11'));
    assert.match(list.text,/Há mais lembretes/);
    assert.match((await f.n.command(sender,'2'))!.text,/envie “excluir 2”/);
    for (const n of ['0','11','1.5','-1','1, 2']) {
      assert.match((await f.n.command(sender,n))!.text,/Escolha um único número/);
    }
    const review = (await f.n.command(sender,'excluir 2'))!;
    assert.match(review.text,/Lembrete 2/);
    await f.n.confirm(sender,token(review),false);
    assert.equal(f.state.writes.length,0);
    await f.n.command(sender,'remover lembrete contendo lembrete 12');
    const last = (await f.n.command(sender,'1'))!;
    assert.match(last.text,/Lembrete 12/);
    assert.match((await f.n.selection.listing(sender,{purpose:'delete',search:'inexistente'})).text,/Não encontrei/);
    assert.equal(await f.n.db.pending(sender),null);
    const replacement = (await f.n.command(sender,'remover lembrete'))!;
    await f.n.command(sender,'',replacement.buttons![0].id);
    assert.equal(await f.n.db.pending(sender),null);
    f.state.reminders=[savedReminder('Remédio da manhã')];
    assert.match((await f.n.command(sender,'remover lembrete contendo remedio',undefined,'Remover lembrete contendo Remédio?'))!.text,/1\. Remédio da manhã/);
    assert.equal(f.state.writes.length,0);
  } finally { await f.store.close(); }
});

test('numbered deletion rejects expired, changed and removed reminders and changed Day identity', async () => {
  const f = await fixture();
  try {
    f.state.reminders = [savedReminder('Livro')];
    await f.n.command(sender,'remover lembrete');
    await f.store.db.query('UPDATE notification_drafts SET expires=0 WHERE sender=$1',[sender]);
    assert.match((await f.n.command(sender,'1'))!.text,/lista expirou/);
    await f.n.command(sender,'qual meu saldo');
    assert.equal(await f.n.command(sender,'1'),null);
    await f.n.command(sender,'remover lembrete');
    f.state.reminders[0].revision++;
    await assert.rejects(f.n.command(sender,'1'),/mudou desde a listagem/);
    await f.n.command(sender,'remover lembrete');
    f.state.reminders[0].deleted=true;
    await assert.rejects(f.n.command(sender,'1'),/não encontrado/);
    f.state.reminders[0].deleted=false;
    await f.n.command(sender,'remover lembrete');
    await f.connect('different-account');
    assert.match((await f.n.command(sender,'excluir 1'))!.text,/nova lista/);
    await f.n.command(sender,'remover lembrete');
    f.state.authorized=false;
    await assert.rejects(f.n.command(sender,'1'),/consent required/);
    assert.equal(f.state.writes.length,0);
  } finally { await f.store.close(); }
});

test('a new Calendar choice invalidates reminder numbers before interpreting another numeric reply', async () => {
  const f = await fixture();
  try {
    f.state.reminders=[savedReminder('Livro')];
    await f.n.command(sender,'remover lembrete');
    let guestChoices=0;
    const calendar = {
      openGuests: async () => ({text:'Escolha convidados: 1. Ana'}),
      tryGuestNumbers: async () => {guestChoices++;return {text:'Ana selecionada'};},
    };
    const a=new Assistant(config,f.store,new OAuth(config,f.store),f.cash as any,f.day as any,calendar as any,
      async()=>{throw new Error('No AI needed');},undefined,f.n);
    await a.handle({id:'guest',sender,text:'',button:`hub:calendar:guests:${randomBytes(32).toString('base64url')}`,timestamp:Date.now()/1000});
    const reply=await a.handle({id:'choice',sender,text:'1',timestamp:Date.now()/1000});
    assert.match(reply[0].text,/Ana selecionada/);
    assert.equal(guestChoices,1);
    assert.equal(f.state.writes.length,0);
  } finally {await f.store.close();}
});

test('natural-language deletion can ask the numbered selector directly without AI rewriting the choices', async () => {
  const f=await fixture();
  try {
    f.state.reminders=[savedReminder('Livro da Cibele'),savedReminder('Livro da biblioteca')];
    let calls=0;
    const a=new Assistant(config,f.store,new OAuth(config,f.store),f.cash as any,f.day as any,{} as any,
      async(_url,init)=>{
        calls++;
        const body=JSON.parse(String(init?.body));
        assert(body.tools.some((t:any)=>t.name==='reminder_choices'));
        return new Response(JSON.stringify({output:[{type:'function_call',name:'reminder_choices',call_id:'pick',arguments:JSON.stringify({purpose:'delete',search:'Livro'})}]}));
      },undefined,f.n);
    const [reply]=await a.handle({id:'natural',sender,text:'Queria tirar aquele aviso do livro, mas tenho mais de um',timestamp:Date.now()/1000});
    assert.match(reply.text,/Qual lembrete deseja excluir/);
    assert.match(reply.text,/2\. Livro da biblioteca/);
    assert.equal(calls,1);
    assert.equal(f.state.writes.length,0);
  } finally {await f.store.close();}
});
test('guided reminder options and quiet settings require owner buttons, valid minutes and final confirmation',async()=>{
  const f=await fixture();
  try {
    let r=await f.n.prepareReminder(sender,{operation:'create',id:null,title:'Livro',schedule},new Set());
    assert.match(r.text,/até marcar como concluído/);
    const old=r.buttons![0].id;
    assert.match((await f.n.command('bob','',old))!.text,/expirou/);
    r=(await f.n.command(sender,'',old))!;
    assert.match(r.text,/número inteiro/);
    for(const text of ['0','-1','1.5','10081']) assert.match((await f.n.command(sender,text))!.text,/inteiro/);
    r=(await f.n.command(sender,'7'))!;
    assert.match(r.text,/respeitar seu período/);
    assert.match((await f.n.command(sender,'',old))!.text,/expirou/);
    r=(await f.n.command(sender,'',r.buttons![1].id))!;
    assert.match(r.text,/a cada 7 minutos/);
    assert.match(r.text,/ignorar para este lembrete/);
    assert.equal(f.state.writes.length,0);
    await f.n.confirm(sender,token(r),true);
    assert.deepEqual(Object.fromEntries(Object.entries(f.state.writes[0][4]).filter(([k])=>['requires_confirmation','repeat_minutes','respect_quiet_hours'].includes(k))),{requires_confirmation:true,repeat_minutes:7,respect_quiet_hours:false});
    await f.n.command(sender,'configurar silencio');
    assert.match((await f.n.command(sender,'22:00 as 22:00'))!.text,/inválidos/);
    r=(await f.n.command(sender,'22:00 as 07:00'))!;
    assert.equal(await f.n.queue.settings(sender),null);
    await f.n.confirm('bob',token(r),true);
    assert.equal(await f.n.queue.settings(sender),null);
    await f.n.confirm(sender,token(r),true);
    assert.equal((await f.n.queue.settings(sender))!.enabled,true);
    r=(await f.n.command(sender,'desativar silencio'))!;
    assert.equal((await f.n.queue.settings(sender))!.enabled,true);
    await f.n.confirm(sender,token(r),true);
    assert.equal((await f.n.queue.settings(sender))!.enabled,false);
    const raw=JSON.stringify((await f.store.db.query('SELECT data FROM notification_settings')).rows);
    assert(!raw.includes('22:00'));
  } finally {await f.store.close();}
});
test('confirmation repeats at the chosen interval, survives reinitialization and stops locally while Day is unavailable',async()=>{
  const f=await fixture();
  try {
    const s=await f.subscribe(),now=Date.now()+1000,id=randomUUID();
    f.state.reminders=[{id,revision:1,enabled:true,title:'Livro',requires_confirmation:true,repeat_minutes:5,respect_quiet_hours:true}];
    await f.n.queue.remember(s,{id,revision:1,title:'Livro',timeZone:config.timeZone,dueAt:new Date(now).toISOString()},now);
    await f.n.reminders.tick(now);
    assert.equal(f.state.sent.length,1);
    assert.equal(f.state.sent[0][2][0], 'Livro');
    assert.match(f.state.sent[0][2][1], /^Hoje às \d{2}h\d{2}$/);
    const payload=f.state.sent[0][3];
    assert.match(payload,/^hub:done:/);
    await f.connect(); // Same account reauthorization must preserve this pending occurrence.
    await f.n.reminders.tick(now+299_999);
    assert.equal(f.state.sent.length,1);
    const restarted=new Notifications(config,f.store,f.day as any,f.cash as any,{} as any,f.n.transport);
    await Promise.all([restarted.reminders.tick(now+300_000),f.n.reminders.tick(now+300_000)]);
    assert.equal(f.state.sent.length,2);
    assert.match((await restarted.command('bob','',payload))!.text,/não está disponível/);
    assert.equal(f.state.completed.size,0);
    f.state.completionError=new Error('offline');
    assert.match((await restarted.command(sender,'',payload))!.text,/interrompidas/);
    await restarted.reminders.tick(now+600_000);
    assert.equal(f.state.sent.length,2);
    assert.equal((await f.store.db.query('SELECT sync_pending FROM reminder_occurrences')).rows[0].sync_pending,true);
    f.state.completionError=null;
    await restarted.reminders.tick(now+660_000);
    assert.equal(f.state.completed.size,1);
    assert.match((await restarted.command(sender,'',payload))!.text,/já foi concluída/);
    assert.equal(f.state.sent.length,2);
  } finally {await f.store.close();}
});
test('quiet hours block initial sends and retries, exceptions bypass, and only latest occurrence survives',async()=>{
  const f=await fixture();
  try {
    const s=await f.subscribe();
    const date=new Date(Date.now()+86400_000).toISOString().slice(0,10);
    const night=Date.parse(`${date}T23:00:00-03:00`),morning=night+8*3600_000;
    await f.n.queue.saveSettings(sender,{enabled:true,start:'22:00',end:'07:00',timeZone:config.timeZone});
    const ids=[randomUUID(),randomUUID()];
    f.state.reminders=ids.map((id,i)=>({id,revision:1,title:i?'Exceção':'Livro',enabled:true,requires_confirmation:true,repeat_minutes:5,respect_quiet_hours:!i}));
    for(const id of ids) await f.n.queue.remember(s,{id,revision:1,title:'Livro',timeZone:config.timeZone,dueAt:new Date(night).toISOString()},night);
    await f.n.reminders.tick(night);
    assert.equal(f.state.sent.length,1);
    assert.equal(f.state.sent[0][2][0],'Exceção');
    assert.equal((await f.n.queue.status(sender,night)).quiet,1);
    const old=(await f.store.db.query("SELECT * FROM reminder_occurrences WHERE quiet_until>0")).rows[0];
    const oldData:any=f.store.vault.open(old.data,`reminder-occurrence:${old.id}:${sender}`);
    await f.n.queue.remember(s,{id:ids[0],revision:1,title:'Livro',timeZone:config.timeZone,dueAt:new Date(night+3600_000).toISOString()},night+3600_000);
    await f.n.reminders.tick(night+3600_000);
    await f.n.reminders.tick(morning);
    assert.equal(f.state.sent.filter(v=>v[2][0]==='Livro').length,1);
    // An earlier occurrence must never complete the replacement.
    await f.n.command(sender,'',`hub:done:${oldData.token}`);
    assert.equal(f.state.completed.size,0);
    await f.n.reminders.tick(morning+5*60_000);
    assert.equal(f.state.sent.filter(v=>v[2][0]==='Livro').length,2);
    // Enter quiet hours after a reminder was already delivered.
    await f.n.queue.saveSettings(sender,{enabled:true,start:'07:00',end:'09:00',timeZone:config.timeZone});
    await f.n.reminders.tick(morning+10*60_000);
    assert.equal(f.state.sent.filter(v=>v[2][0]==='Livro').length,2);
    await f.n.reminders.tick(morning+2*3600_000);
    assert.equal(f.state.sent.filter(v=>v[2][0]==='Livro').length,3);
  } finally {await f.store.close();}
});
test('old delivered buttons, expiration, edits, revoked grants and opt-out never continue repeats or complete newer occurrences',async()=>{
  const f=await fixture();
  try {
    const s=await f.subscribe(),now=Date.now()+1000,id=randomUUID();
    const r={id,revision:1,title:'Livro',enabled:true,requires_confirmation:true,repeat_minutes:1};
    f.state.reminders=[r];
    const due=(at:number)=>({id,revision:1,title:r.title,timeZone:config.timeZone,dueAt:new Date(at).toISOString()});
    await f.n.queue.remember(s,due(now),now);
    await f.n.reminders.tick(now);
    const old=f.state.sent[0][3];
    await f.n.queue.remember(s,due(now+60_000),now+60_000);
    await f.n.reminders.tick(now+60_000);
    assert.match((await f.n.command(sender,'',old))!.text,/anterior/);
    assert.equal(f.state.completed.size,0);
    r.revision=2;
    await f.n.reminders.tick(now+120_000);
    assert.equal(f.state.sent.length,2);
    r.revision=1;
    await f.n.queue.remember(s,due(now+180_000),now+180_000);
    f.state.authorized=false;
    await f.n.reminders.tick(now+180_000);
    assert.equal(f.state.sent.length,2);
    assert.equal((await f.n.db.subscription(sender,'day_reminders'))!.problem,'day_consent');
    f.state.authorized=true;
    await f.n.db.pause(sender);
    await f.n.reminders.tick(now+240_000);
    assert.equal(f.state.sent.length,2);
    assert.equal((await f.store.db.query("SELECT count(*)::int n FROM reminder_occurrences WHERE state='pending'")).rows[0].n,0);
  } finally {await f.store.close();}
});
test('confirmation template sends a user-bound opaque quick reply and uses the approval for its own template',async()=>{
  const calls:any[]=[];
  const t=new NotificationTransport(config,async(url,init)=>{
    calls.push({url,init});
    return new Response(JSON.stringify(String(url).includes('message_templates')?{data:[{name:config.notifications.confirmationTemplate,status:'APPROVED',language:'pt_BR'}]}:{messages:[{id:'wamid.confirm'}]}));
  });
  assert.equal(await t.approved('day_reminders'),false);
  assert.equal(await t.approved('day_reminders',false,true),true);
  const payload='hub:done:'+randomBytes(32).toString('base64url');
  await t.send(sender,'day_reminders',['Livro','06:30'],payload);
  const body=JSON.parse(calls.at(-1).init.body);
  assert.equal(body.template.name,config.notifications.confirmationTemplate);
  assert.deepEqual(body.template.components[1],{type:'button',sub_type:'quick_reply',index:'0',parameters:[{type:'payload',payload}]});
});
test('screenshot question returns real catalog without AI, even with old Calendar-only history', async () => {
  const f = await fixture();
  try {
    await f.store.addHistory(sender, 'assistant', 'Não há notificações proativas; somente Calendar.');
    const a = new Assistant(
      config,
      f.store,
      new OAuth(config, f.store),
      f.cash as any,
      f.day as any,
      {} as any,
      async () => {
        throw new Error('AI must not run');
      },
      undefined,
      f.n,
    );
    const r = await a.handle({
      id: 'm',
      sender,
      text: 'Quais notificações posso receber?',
      timestamp: Date.now() / 1000,
    });
    assert.match(r[0].text, /Resumo diário/);
    assert.match(r[0].text, /Lembretes do Day/);
    assert.equal(r[0].buttons?.length, 3);
    assert.equal((await f.n.db.list(sender)).length, 0);
    f.state.approved = false;
    assert.match((await f.n.catalog(sender)).text, /aguardando configuração/);
  } finally {
    await f.store.close();
  }
});
test('subscription needs current sender button, replaces previews, supports opt-out and never silently reconnects', async () => {
  const f = await fixture();
  try {
    const first = await f.n.prepare(sender, {
      kind: 'day_reminders',
      time: null,
      timeZone: config.timeZone,
      sources: ['day'],
    });
    const second = await f.n.prepare(sender, {
      kind: 'day_reminders',
      time: null,
      timeZone: config.timeZone,
      sources: ['day'],
    });
    await f.n.confirm('bob', token(second), true);
    await f.n.confirm(sender, token(first), true);
    assert.equal((await f.n.db.list(sender)).length, 0);
    await Promise.all([f.n.confirm(sender, token(second), true), f.n.confirm(sender, token(second), true)]);
    assert.equal((await f.n.db.subscription(sender, 'day_reminders'))?.revision, 1);
    await f.n.command(sender, 'parar notificacoes');
    assert.equal((await f.n.db.subscription(sender, 'day_reminders'))?.enabled, false);
    await f.subscribe();
    await f.connect('another-account');
    assert.equal((await f.n.db.subscription(sender, 'day_reminders'))?.enabled, false);
  } finally {
    await f.store.close();
  }
});
test('repeated polling sends occurrence once; receipt state never claims delivered from HTTP acceptance', async () => {
  const f = await fixture();
  try {
    const sub = await f.subscribe(),
      now = Date.now() + 1000,
      id = randomUUID();
    f.state.reminders = [{ id, revision: 1, enabled: true, deleted: false, title: 'Beber água' }];
    f.state.occurrences = [
      {
        id,
        revision: 1,
        title: 'Beber água',
        timeZone: config.timeZone,
        dueAt: new Date(now - 100).toISOString(),
      },
    ];
    await f.n.tick(now);
    await f.n.tick(now + 1000);
    assert.equal(f.state.sent.length, 1);
    assert.equal(f.state.sent[0][2][0], 'Beber água');
    assert.match(f.state.sent[0][2][1], /^Hoje às \d{2}h\d{2}$/);
    assert.equal(f.state.sent[0][3], undefined);
    assert.equal((await f.n.db.history(sender))[0].state, 'accepted');
    await f.n.db.receipt('wamid.1', 'delivered');
    await f.n.db.receipt('wamid.1', 'read');
    await f.n.db.receipt('wamid.1', 'delivered');
    assert.equal((await f.n.db.history(sender))[0].state, 'read');
    await f.n.queue.remember(sub,f.state.occurrences[0],now);
    assert.equal((await f.n.db.history(sender)).length, 1);
    const raw = JSON.stringify((await f.store.db.query('SELECT data FROM notification_deliveries')).rows);
    assert(!raw.includes('Beber água'));
  } finally {
    await f.store.close();
  }
});
test('paused, edited, revoked, expired and unavailable-template reminders never send; uncertain sends never retry', async () => {
  const f = await fixture();
  try {
    let sub = await f.subscribe();
    const now = Date.now() + 1000,
      id = randomUUID();
    const data = { reminderId: id, reminderRevision: 1, timeZone: config.timeZone };
    f.state.reminders = [{ id, revision: 2, enabled: true, title: 'edited' }];
    await f.n.db.enqueue(sub, 'edited', now, 300000, data);
    await f.n.tick(now);
    assert.equal(f.state.sent.length, 0);
    f.state.reminders[0].revision = 1;
    f.state.reminders[0].enabled = false;
    await f.n.db.enqueue(sub, 'paused', now, 300000, data);
    await f.n.tick(now);
    assert.equal(f.state.sent.length, 0);
    f.state.reminders[0].enabled = true;
    f.state.authorized = false;
    await f.n.db.enqueue(sub, 'revoked', now, 300000, data);
    await f.n.tick(now);
    assert.equal(f.state.sent.length, 0);
    f.state.authorized = true;
    f.state.approved = false;
    await f.n.db.enqueue(sub, 'template', now, 300000, data);
    await f.n.tick(now);
    assert.equal(f.state.sent.length, 0);
    f.state.approved = true;
    await f.n.db.enqueue(sub, 'expired', now - 301000, 300000, data);
    await f.n.tick(now);
    assert.equal(f.state.sent.length, 0);
    f.state.failSend = true;
    await f.n.db.enqueue(sub, 'uncertain', now, 300000, data);
    await f.n.tick(now);
    await f.n.tick(now);
    assert.equal(f.state.sent.length, 1);
    assert.equal(
      (await f.store.db.query("SELECT count(*)::int n FROM notification_deliveries WHERE state='uncertain'"))
        .rows[0].n,
      1,
    );
    await f.n.db.enqueue(sub, 'cancelled', now, 300000, data);
    await f.n.db.pause(sender);
    await f.n.tick(now);
    assert.equal(f.state.sent.length, 1);
  } finally {
    await f.store.close();
  }
});
test('reminder writes preserve button boundary, foreign IDs, revisions and connection binding', async () => {
  const f = await fixture();
  try {
    const change = { operation: 'create', id: null, title: 'Levar livro', schedule };
    const questions = await f.n.prepareReminder(sender, change, new Set());
    const quiet = await f.n.command(sender,'',questions.buttons![1].id);
    const preview = (await f.n.command(sender,'',quiet!.buttons![0].id))!;
    assert.equal(f.state.writes.length, 0);
    await f.n.confirm('bob', token(preview), true);
    assert.equal(f.state.writes.length, 0);
    await f.n.confirm(sender, token(preview), true);
    await f.n.confirm(sender, token(preview), true);
    assert.equal(f.state.writes.length, 1);
    assert.equal(f.state.writes[0][3], 0);
    await assert.rejects(
      f.n.prepareReminder(
        sender,
        { operation: 'delete', id: randomUUID(), title: null, schedule: null },
        new Set(),
      ),
    );
    const stale = await f.n.prepareReminder(sender, change, new Set());
    await f.connect('other');
    await f.n.confirm(sender, token(stale), true);
    assert.equal(f.state.writes.length, 1);
    assert.equal(
      reminderChange.safeParse({ ...change, schedule: { ...schedule, times: ['155:00'] } }).success,
      false,
    );
  } finally {
    await f.store.close();
  }
});
test('daily summary honors local midnight, connected selections, partial failures and server calculated totals', async () => {
  const f = await fixture();
  try {
    const now = Date.now();
    const date = new Intl.DateTimeFormat('sv-SE', { timeZone: config.timeZone, dateStyle: 'short' }).format(
      now,
    );
    const calls: any[] = [];
    f.n.calendar.events = async (_sender: string, args: any) => {
      calls.push(args);
      return {
        events: [{ summary: 'Consulta', start: { dateTime: `${date}T09:00:00-03:00` } }],
        truncated: false,
        calendar: 'primary',
        timeZone: config.timeZone,
      };
    };
    f.n.cash.query = async () => ({
      data: {
        ok: true,
        totalItems: 2,
        totalAmount: 250.2,
        items: [{ description: 'Energia' }, { description: 'Internet' }],
      },
    });
    f.day.daily = async () => {
      throw new Error('offline');
    };
    const s = await f.subscribe();
    s.data.sources = ['calendar', 'cash', 'day'];
    const workspace = { id: 3, name: 'Casa', personal: true, reference: '7:3', cash: true };
    s.data.cashWorkspace = workspace;
    f.n.cash.status = async () => ({ connected: true, workspace, workspaces: [workspace] });
    const values = await f.n.summary(s, date);
    assert.equal(values.length, 4);
    assert.match(values[1], /09:00 Consulta/);
    assert.match(values[2], /250,20/);
    assert.match(values[3], /indisponível/);
    assert.equal(calls[0].start, `${date}T03:00:00.000Z`);
    assert.equal(Date.parse(calls[0].end) - Date.parse(calls[0].start), 86400000);
    const r = await f.n.prepare(sender, {
      kind: 'daily_summary',
      time: '07:00',
      timeZone: config.timeZone,
      sources: ['day'],
    });
    await f.n.confirm(sender, token(r), true);
    const summary = (await f.n.db.subscription(sender, 'daily_summary'))!;
    assert.deepEqual(summary.data.sources, ['day']);
    await f.store.db.query(
      'UPDATE notification_subscriptions SET data=$1,next_check=0 WHERE sender=$2 AND kind=$3',
      [
        f.store.vault.seal(
          { ...summary.data, since: now - 86400000 },
          `subscription:${sender}:daily_summary`,
        ),
        sender,
        'daily_summary',
      ],
    );
    const at = Date.parse(`${date}T07:00:01-03:00`);
    // Enqueue is deterministic in local dates; expired wall-clock deliveries are discarded.
    await f.n.tick(at);
    await f.n.tick(at + 31000);
    assert.equal(
      (
        await f.store.db.query(
          "SELECT count(*)::int n FROM notification_deliveries WHERE kind='daily_summary'",
        )
      ).rows[0].n,
      1,
    );
  } finally {
    await f.store.close();
  }
});
test('transport only accepts correct approved language/template and uses template endpoint, not freeform outside window', async () => {
  const calls: any[] = [];
  const t = new NotificationTransport(config, async (url, init) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify(
        String(url).includes('message_templates')
          ? { data: [{ name: config.notifications.summaryTemplate, status: 'APPROVED', language: 'pt_BR' }] }
          : { messages: [{ id: 'wamid.test' }] },
      ),
    );
  });
  assert.equal(await t.approved('daily_summary'), true);
  assert.equal(await t.approved('day_reminders'), false);
  assert.equal(
    await t.send(sender, 'daily_summary', ['01/10/2026', 'Agenda', 'Contas', 'Tarefas']),
    'wamid.test',
  );
  const body = JSON.parse(calls.at(-1).init.body);
  assert.equal(body.type, 'template');
  assert.equal(body.template.components[0].parameters.length, 4);
  assert.equal(body.to, sender);
});
test('delivery receipts require valid Meta signature and configured phone, and ignore unrelated states', () => {
  const wa = new WhatsApp(config);
  const body = Buffer.from(
    JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'phone' },
                statuses: [
                  { id: 'wamid.1', status: 'delivered' },
                  { id: 'wamid.2', status: 'sent' },
                ],
              },
            },
          ],
        },
      ],
    }),
  );
  assert.throws(() => wa.receipts(body, 'bad'));
  assert.deepEqual(wa.receipts(body, metaSignature(body, config.meta.secret)), [
    { id: 'wamid.1', status: 'delivered' },
  ]);
});
test('new Day consent is checked before querying reminders and identity never comes from AI arguments', async () => {
  const store = await createTestStore(config.key);
  try {
    await store.connect({
      sender,
      provider: 'day',
      accountId: 'owner',
      label: 'owner@example.test',
      tokens: { access_token: 'private', refresh_token: 'refresh', expires_at: Date.now() + 3600_000 },
    });
    const urls: string[] = [];
    let granted = false;
    const day = new Day(new OAuth(config, store), async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify(String(url).includes('check') ? { authorized: granted } : []));
    });
    await assert.rejects(day.reminders(sender), /Autorize/);
    assert.equal(urls.length, 1);
    granted = true;
    await day.reminders(sender);
    assert.match(urls[2], /user_id=eq.owner/);
  } finally {
    await store.close();
  }
});

test('same-account reauthorization preserves subscription, consent, scheduled delivery and deduplication; opt-out stays paused', async () => {
  const f = await fixture();
  try {
    const sub = await f.subscribe();
    const original = (await f.store.connection(sender, 'day'))!;
    const now = Date.now() + 1000, id = randomUUID();
    const occurrence = `${sub.data.accounts.day}:${id}:${now}`;
    f.state.reminders = [{ id, revision: 1, enabled: true, deleted: false, title: 'Livro' }];
    await f.n.db.enqueue(sub, occurrence, now, 300000, { reminderId: id, reminderRevision: 1, timeZone: config.timeZone });
    await f.store.connect({ ...original, label: 'renamed@example.test', tokens: { ...original.tokens, access_token: 'new-access', refresh_token: 'new-refresh' } });
    const after = (await f.n.db.subscription(sender, 'day_reminders'))!;
    assert.equal(after.enabled, true);
    assert.equal(after.revision, sub.revision);
    assert.deepEqual(after.data, sub.data);
    assert.equal((await f.store.connection(sender, 'day'))!.grantId, original.grantId);
    await f.n.tick(now);
    await f.n.db.enqueue(after, occurrence, now, 300000, {});
    await f.n.tick(now + 1000);
    assert.equal(f.state.sent.length, 1);
    await f.n.db.pause(sender);
    await f.connect();
    assert.equal((await f.n.db.subscription(sender, 'day_reminders'))!.enabled, false);
    await f.connect('other');
    await f.connect();
    assert.equal((await f.n.db.subscription(sender, 'day_reminders'))!.enabled, false);
  } finally { await f.store.close(); }
});

test('changing or disconnecting Calendar leaves Day reminders enabled; changing Day only pauses dependent subscriptions', async () => {
  const f = await fixture();
  try {
    await f.subscribe();
    const dayConnection = (await f.store.connection(sender, 'day'))!;
    await f.store.connect({ ...dayConnection, provider: 'calendar', accountId: 'calendar-a' });
    let calendar = (await f.store.connection(sender, 'calendar'))!;
    const daySub = (await f.n.db.subscription(sender, 'day_reminders'))!;
    await f.n.db.save(sender, 'daily_summary', { ...daySub.data, sources: ['calendar'], accounts: { calendar: JSON.stringify([calendar.accountId, calendar.grantId]) } });
    await f.store.connect({ ...calendar, accountId: 'calendar-b' });
    assert.equal((await f.n.db.subscription(sender, 'day_reminders'))!.enabled, true);
    assert.equal((await f.n.db.subscription(sender, 'daily_summary'))!.problem, 'connection_changed');
    await f.store.disconnect(sender, 'calendar');
    assert.equal((await f.n.db.subscription(sender, 'day_reminders'))!.enabled, true);
    await f.n.db.save(sender, 'daily_summary', { ...daySub.data, sources: ['cash'], accounts: { cash: 'connected' } });
    await f.connect('different-day-account');
    assert.equal((await f.n.db.subscription(sender, 'day_reminders'))!.enabled, false);
    assert.equal((await f.n.db.subscription(sender, 'day_reminders'))!.problem, 'connection_changed');
    assert.equal((await f.n.db.subscription(sender, 'daily_summary'))!.enabled, true);
    assert.match((await f.n.status(sender)).text, /contas utilizadas mudou/);
  } finally { await f.store.close(); }
});

test('poll failures persist actionable access status, keep the subscription and clear only after successful authenticated polling', async () => {
  const f = await fixture();
  try {
    const sub = await f.subscribe();
    const now = Date.now() + 1000;
    f.state.pollError = new ConnectionAccessError('private provider diagnostic');
    await f.n.tick(now);
    let current = (await f.n.db.subscription(sender, 'day_reminders'))!;
    assert.equal(current.enabled, true);
    assert.equal(current.problem, 'day_access');
    assert.equal(current.checkedAt, sub.checkedAt);
    assert.equal(current.problemSince, now);
    assert.match((await f.n.status(sender)).text, /envio interrompido.*perdeu a autorização/);
    assert.match((await f.n.catalog(sender)).text, /conectar Day/);
    assert(!JSON.stringify(await f.n.status(sender)).includes('private provider'));
    assert.equal(f.state.sent.length, 0);
    assert.equal((await f.n.db.history(sender)).length, 0);
    await f.connect();
    assert.equal((await f.n.db.subscription(sender, 'day_reminders'))!.problem, 'day_access');
    f.state.pollError = null;
    await f.n.tick(now + 61000);
    current = (await f.n.db.subscription(sender, 'day_reminders'))!;
    assert.equal(current.problem, null);
    assert.equal(current.enabled, true);
    assert.equal(current.revision, sub.revision);
    assert.equal((await f.n.warnings(sender)).length, 0);
    assert.match((await f.n.status(sender)).text, /Lembretes do Day: ativo/);
  } finally { await f.store.close(); }
});

test('revoked consent and temporary outage show different recovery instructions without asking to resubscribe', async () => {
  const f = await fixture();
  try {
    await f.subscribe();
    const now = Date.now() + 1000;
    f.state.authorized = false;
    await f.n.tick(now);
    assert.equal((await f.n.db.subscription(sender, 'day_reminders'))!.problem, 'day_consent');
    assert.match((await f.n.status(sender)).text, /https:\/\/day.example.test\/hub\/reminders/);
    f.state.authorized = true;
    f.state.pollError = new Error('network failure with secret');
    await f.n.tick(now + 61000);
    assert.equal((await f.n.db.subscription(sender, 'day_reminders'))!.problem, 'day_unavailable');
    assert.match((await f.n.status(sender)).text, /tentará novamente automaticamente/);
    assert(!JSON.stringify(await f.n.status(sender)).includes('network failure'));
    f.state.pollError = null;
    await f.n.tick(now + 122000);
    assert.equal((await f.n.db.subscription(sender, 'day_reminders'))!.problem, null);
  } finally { await f.store.close(); }
});

test('next conversation receives one durable warning per problem, without unsolicited messages or cross-sender exposure', async () => {
  const f = await fixture();
  try {
    await f.subscribe();
    const now = Date.now() + 1000;
    f.state.pollError = new ConnectionAccessError('revoked');
    await f.n.tick(now);
    assert.equal((await f.store.db.query('SELECT count(*)::int n FROM outbox')).rows[0].n, 0);
    assert.equal((await f.n.warnings('bob')).length, 0);
    const sent: any[] = [];
    const worker = new Worker(f.store, { handle: async () => [{ text: 'Resposta normal' }], notifications: f.n } as any, {
      withTypingIndicator: async (_id: string, work: () => Promise<any>) => work(),
      send: async (_sender: string, reply: any) => { sent.push(reply); },
    } as any);
    await f.store.enqueue({ id: 'warning-message', sender, text: 'oi', timestamp: Date.now() / 1000 });
    await worker.tick();
    assert.equal(sent.length, 2);
    assert.match(sent[1].text, /perdeu a autorização/);
    await f.n.tick(now + 61000);
    await f.store.enqueue({ id: 'second-message', sender, text: 'saldo', timestamp: Date.now() / 1000 });
    await worker.tick();
    assert.equal(sent.length, 3);
    assert.equal((await f.n.warnings(sender)).length, 0);
    // An old warning cannot reappear after opt-out or recovery.
    f.state.pollError = null;
    await f.n.tick(now + 122000);
    f.state.pollError = new ConnectionAccessError('revoked again');
    await f.n.tick(now + 153000);
    const warnings = await f.n.warnings(sender);
    assert.equal(warnings.length, 1);
    await f.n.db.pause(sender);
    const message = { id: 'cancelled-warning', sender, text: 'oi', timestamp: Date.now() / 1000 };
    await f.store.enqueue(message); await f.store.nextMessage();
    await f.store.complete(message, [{ text: 'ok' }], warnings);
    assert.equal((await f.store.db.query("SELECT count(*)::int n FROM outbox WHERE state='pending'")).rows[0].n, 1);
  } finally { await f.store.close(); }
});

test('warning acknowledgement rolls back with the reply and the status response does not duplicate the warning', async () => {
  const f = await fixture();
  try {
    const sub = await f.subscribe();
    await f.n.db.problem(sub, 'day_access');
    const warnings = await f.n.warnings(sender);
    const message = { id: 'atomic-warning', sender, text: 'minhas assinaturas', timestamp: Date.now() / 1000 };
    await f.store.enqueue(message); await f.store.nextMessage();
    const circular: any = { text: 'broken' }; circular.self = circular;
    await assert.rejects(f.store.complete(message, [circular], warnings));
    assert.equal((await f.n.warnings(sender)).length, 1);
    await f.store.complete(message, [await f.n.status(sender)], warnings);
    assert.equal((await f.store.db.query('SELECT count(*)::int n FROM outbox')).rows[0].n, 1);
    assert.equal((await f.n.warnings(sender)).length, 0);
  } finally { await f.store.close(); }
});

test('a Meta authorization failure is not reported as a Day connection failure', async () => {
  const f = await fixture();
  try {
    const sub = await f.subscribe(), now = Date.now() + 1000;
    f.n.transport.approved = async () => { throw new HttpError(401); };
    await f.n.db.enqueue(sub, 'meta-failure', now, 300000, {});
    await f.n.tick(now);
    assert.equal((await f.n.db.subscription(sender, 'day_reminders'))!.problem, null);
    assert.equal((await f.n.warnings(sender)).length, 0);
    assert.equal((await f.n.db.history(sender))[0].state, 'skipped');
    assert.equal(f.state.sent.length, 0);
  } finally { await f.store.close(); }
});

test('reconnection confirmation does not append a stale request to reconnect before checking the new access', async () => {
  const f = await fixture();
  try {
    const sub = await f.subscribe();
    await f.n.db.problem(sub, 'day_access');
    const sent: any[] = [];
    const worker = new Worker(f.store, {
      handle: async () => { await f.connect(); return [{ text: 'Mesma conta reconectada. O Hub verificará o acesso.' }]; },
      notifications: f.n,
    } as any, {
      withTypingIndicator: async (_id: string, work: () => Promise<any>) => work(),
      send: async (_sender: string, reply: any) => { sent.push(reply); },
    } as any);
    await f.store.enqueue({ id: 'reconnected', sender, button: 'hub:approve:confirmation', text: '', timestamp: Date.now() / 1000 });
    await worker.tick();
    assert.equal(sent.length, 1);
    assert(!sent[0].text.includes('perdeu a autorização'));
    assert.equal((await f.n.db.subscription(sender, 'day_reminders'))!.problem, null);
  } finally { await f.store.close(); }
});
