import express from 'express';
import type { Config } from './config.js';
import { OAuth } from './oauth.js';
import { Store } from './store.js';
import { WhatsApp } from './whatsapp.js';
import { digest, equal, randomToken } from './security.js';
import { PublicError, type Provider } from './types.js';

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const page = (title: string, content: string) => `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · Zenit Hub</title><body><main><h1>${escape(title)}</h1>${content}</main></body></html>`;
function cookieValue(header: string | undefined, name: string) {
  return (header || '').split(';').map(c => c.trim()).find(c => c.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}
export function createApp(config: Config, store: Store, oauth: OAuth, whatsapp: WhatsApp) {
  const app = express(); app.disable('x-powered-by');
  app.use((_req, res, next) => {
    // Preserve the Origin of same-origin form POSTs without leaking link tokens
    // in the Referer when the browser redirects to an external OAuth provider.
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'none'; form-action 'self' https://accounts.google.com ${config.day.url}; frame-ancestors 'none'; base-uri 'none'` }); next();
  });
  app.get('/health', async (_req, res) => {
    try { await store.health(); return res.json({ application: 'zenit-hub', status: 'ok' }); }
    catch { return res.status(503).json({ application: 'zenit-hub', status: 'unavailable' }); }
  });
  app.get('/webhooks/whatsapp', (req, res) => {
    if (config.meta.verify && req.query['hub.mode'] === 'subscribe' && typeof req.query['hub.verify_token'] === 'string' &&
        equal(req.query['hub.verify_token'], config.meta.verify) && typeof req.query['hub.challenge'] === 'string') res.type('text').send(req.query['hub.challenge']);
    else res.sendStatus(403);
  });
  app.post('/webhooks/whatsapp', express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
    if (!Buffer.isBuffer(req.body)) return res.sendStatus(400);
    let incoming;
    try { incoming = whatsapp.parse(req.body, String(req.headers['x-hub-signature-256'] || '')); }
    catch { return res.sendStatus(401); }
    for (const message of incoming) await store.enqueue(message);
    return res.status(202).json({ accepted: true });
  });
  app.get('/connect/:token', async (req, res) => {
    const token = String(req.params.token); const pending = await store.readLink(token, 'link');
    if (!pending) return res.status(410).type('html').send(page('Link expirado', '<p>Peça um novo link pelo WhatsApp.</p>'));
    // GET is safe for messaging link previews. Only the explicit form POST starts OAuth.
    const browser = randomToken();
    res.cookie('hub_browser', browser, { httpOnly: true, secure: config.publicUrl.startsWith('https:'), sameSite: 'lax', maxAge: 600_000, path: '/' });
    return res.type('html').send(page(`Conectar ${pending.provider === 'day' ? 'Day' : 'Google Calendar'}`,
      `<p>Você autorizará a conta no serviço correspondente e confirmará a conexão no WhatsApp.</p><form method="post"><input type="hidden" name="csrf" value="${digest(browser)}"><button type="submit">Continuar</button></form>`));
  });
  app.post('/connect/:token', express.urlencoded({ extended: false, limit: '2kb' }), async (req, res) => {
    const browser = cookieValue(req.headers.cookie, 'hub_browser');
    if (!browser || !equal(String(req.body?.csrf || ''), digest(browser)) ||
        (req.headers.origin && req.headers.origin !== config.publicUrl)) return res.sendStatus(403);
    try { return res.redirect(303, await oauth.begin(String(req.params.token), browser)); }
    catch (error) { return res.status(400).type('html').send(page('Conexão não iniciada', `<p>${escape(error instanceof PublicError ? error.message : 'Tente novamente pelo WhatsApp.')}</p>`)); }
  });
  app.get('/oauth/:provider/callback', async (req, res) => {
    const provider = req.params.provider;
    if (!['day', 'calendar'].includes(String(provider))) return res.sendStatus(404);
    if (typeof req.query.state !== 'string' || typeof req.query.code !== 'string' || req.query.code.length > 4096) {
      return res.status(400).type('html').send(page('Autorização não concluída', '<p>Volte ao WhatsApp para iniciar novamente.</p>'));
    }
    try {
      await oauth.finish(provider as Provider, req.query.state, cookieValue(req.headers.cookie, 'hub_browser'), req.query.code);
      return res.type('html').send(page('Confirme no WhatsApp', '<p>A autorização foi recebida. Volte à conversa que iniciou a conexão e confirme a conta.</p>'));
    } catch (error) {
      return res.status(400).type('html').send(page('Conexão não concluída', `<p>${escape(error instanceof PublicError ? error.message : 'Inicie novamente pelo WhatsApp.')}</p>`));
    }
  });
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: 'Solicitação não concluída.' }));
  return app;
}
