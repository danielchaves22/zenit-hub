import { z } from 'zod';
import { readDatabaseConfig } from './database.js';
import { initialAssistantDefaults } from './assistant-defaults.js';

function safeUrl(value: string) {
  const u = new URL(value);
  if (u.username || u.password || u.search || u.hash || u.hostname.includes('*') || u.pathname !== '/' ||
      (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)))) {
    throw new Error('Use uma origem HTTPS, ou HTTP apenas em localhost.');
  }
  return u.origin;
}
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const optionalOrigin = (key: string) => env[key] ? safeUrl(env[key]!) : '';
  const key = env.HUB_ENCRYPTION_KEY || '';
  if (Buffer.from(key, 'base64').length !== 32) throw new Error('Configure HUB_ENCRYPTION_KEY (32 bytes base64).');
  const timeZone = env.HUB_TIME_ZONE || 'America/Sao_Paulo';
  new Intl.DateTimeFormat('pt-BR', { timeZone }).format();
  const dayUrl = optionalOrigin('DAY_SUPABASE_URL');
  const dayKey = env.DAY_SUPABASE_PUBLISHABLE_KEY || '';
  if (dayUrl && (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(dayUrl) || !dayKey.startsWith('sb_publishable_'))) {
    throw new Error('O Day exige URL Supabase e chave publicável; chaves administrativas não são aceitas.');
  }
  const cashUrl = optionalOrigin('CASH_API_URL');
  const cashSecret = env.CASH_HUB_SHARED_SECRET || '';
  // An installation without a bridge may still select its own chat model.
  const standaloneModel = cashUrl && cashSecret.length >= 32 ? undefined : env.OPENAI_MODEL?.trim();
  return {
    host: z.enum(['127.0.0.1', '0.0.0.0', '::1', '::']).parse(env.HUB_HOST || '127.0.0.1'),
    port: z.coerce.number().int().min(1).max(65535).parse(env.PORT || 3210),
    publicUrl: safeUrl(env.HUB_PUBLIC_URL || 'http://localhost:3210'),
    database: readDatabaseConfig(env), key, timeZone,
    allowedSenders: new Set((env.HUB_ALLOWED_SENDERS || '').split(',').map(s => s.trim()).filter(Boolean)),
    meta: { version: z.string().regex(/^v\d+\.\d+$/).parse(env.WHATSAPP_API_VERSION || 'v23.0'),
      phoneId: env.WHATSAPP_PHONE_NUMBER_ID || '', token: env.WHATSAPP_ACCESS_TOKEN || '',
      guestsFlowId: z.string().regex(/^\d{1,128}$/).optional().parse(env.WHATSAPP_GUESTS_FLOW_ID || undefined),
      secret: env.WHATSAPP_APP_SECRET || '', verify: env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || '' },
    cash: { url: cashUrl, secret: cashSecret,
      bindingPrefix: env.CASH_BINDING_PREFIX || 'VINCULAR ZENIT', connectUrl: env.CASH_CONNECT_URL || '' },
    ai: { key: env.OPENAI_API_KEY || '', model: standaloneModel || initialAssistantDefaults.model,
      transcriptionModel: env.WHATSAPP_TRANSCRIPTION_MODEL?.trim() || 'gpt-transcribe',
      effort: standaloneModel ? z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
        .optional().parse(env.OPENAI_REASONING_EFFORT || undefined) : initialAssistantDefaults.reasoningEffort },
    google: { clientId: env.GOOGLE_CLIENT_ID || '', secret: env.GOOGLE_CLIENT_SECRET || '' },
    notifications: { wabaId: env.WHATSAPP_BUSINESS_ACCOUNT_ID || '', language: 'pt_BR',
      summaryTemplate: env.WHATSAPP_SUMMARY_TEMPLATE || '', reminderTemplate: env.WHATSAPP_REMINDER_TEMPLATE || '',
      confirmationTemplate: env.WHATSAPP_REMINDER_CONFIRM_TEMPLATE || 'zenit_lembrete_confirmar_v1',
      snoozeTemplate: env.WHATSAPP_REMINDER_SNOOZE_TEMPLATE || '' },
    day: { url: dayUrl, siteUrl: optionalOrigin('DAY_SITE_URL'), key: dayKey, clientId: env.DAY_CLIENT_ID || '', secret: env.DAY_CLIENT_SECRET || '' }
  };
}
export type Config = ReturnType<typeof readConfig>;
