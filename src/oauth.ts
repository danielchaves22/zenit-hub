import { z } from 'zod';
import type { Config } from './config.js';
import { Store } from './store.js';
import { challenge, digest, equal, randomToken } from './security.js';
import { jsonRequest } from './http.js';
import { PublicError, type Connection, type Fetch, type Provider, type Tokens } from './types.js';

const googleScopes = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly'];
const tokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().optional(),
  expires_in: z.coerce.number().positive().max(86400 * 365), token_type: z.string().optional(), scope: z.string().optional() });

export class OAuth {
  private refreshing = new Map<string, Promise<Connection>>();
  constructor(readonly config: Config, readonly store: Store, private fetcher: Fetch = fetch) {}
  settings(provider: Provider) {
    if (provider === 'calendar') return { clientId: this.config.google.clientId, secret: this.config.google.secret,
      authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token',
      userinfo: 'https://openidconnect.googleapis.com/v1/userinfo', scopes: googleScopes.join(' ') };
    return { clientId: this.config.day.clientId, secret: this.config.day.secret,
      authorize: this.config.day.url + '/auth/v1/oauth/authorize', token: this.config.day.url + '/auth/v1/oauth/token',
      userinfo: this.config.day.url + '/auth/v1/oauth/userinfo', scopes: 'email' };
  }
  enabled(provider: Provider) {
    const s = this.settings(provider);
    return Boolean(s.clientId && s.secret && (provider !== 'day' || this.config.day.url));
  }
  callback(provider: Provider) { return `${this.config.publicUrl}/oauth/${provider}/callback`; }
  async createLink(sender: string, provider: Provider) {
    if (!this.enabled(provider)) throw new PublicError(`O conector ${provider === 'day' ? 'Day' : 'Calendar'} ainda precisa ser configurado no Hub.`);
    const token = randomToken();
    await this.store.cancelLinks(sender, provider);
    await this.store.link(token, sender, provider, {});
    return `${this.config.publicUrl}/connect/${token}`;
  }
  async begin(token: string, browser: string) {
    const link = await this.store.takeLink(token, 'link');
    if (!link) throw new PublicError('Este link expirou ou já foi usado. Peça uma nova conexão pelo WhatsApp.');
    const state = randomToken(); const verifier = randomToken(); const s = this.settings(link.provider);
    await this.store.link(state, link.sender, link.provider, { verifier, browser: digest(browser) }, 'state');
    const url = new URL(s.authorize);
    const params: Record<string, string> = { client_id: s.clientId, redirect_uri: this.callback(link.provider), response_type: 'code',
      scope: s.scopes, state, code_challenge: challenge(verifier), code_challenge_method: 'S256' };
    if (link.provider === 'calendar') Object.assign(params, { access_type: 'offline', prompt: 'consent select_account' });
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }
  private async exchange(provider: Provider, parameters: Record<string, string>, previous?: Tokens): Promise<Tokens> {
    const s = this.settings(provider);
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
    const body = new URLSearchParams(parameters);
    if (provider === 'day') headers.Authorization = `Basic ${Buffer.from(`${s.clientId}:${s.secret}`).toString('base64')}`;
    else { body.set('client_id', s.clientId); body.set('client_secret', s.secret); }
    const raw = tokenSchema.parse(await jsonRequest(this.fetcher, s.token, { method: 'POST', headers, body: body.toString() }));
    if (raw.token_type && raw.token_type.toLowerCase() !== 'bearer') throw new PublicError('Tipo de autorização não suportado.');
    const refresh = raw.refresh_token || previous?.refresh_token;
    if (!refresh) throw new PublicError('Não foi concedido acesso contínuo. Revogue a autorização anterior e conecte novamente.');
    const scope = raw.scope ?? previous?.scope;
    if (provider === 'calendar' && scope && !googleScopes.slice(2).every(s => scope.split(' ').includes(s))) {
      throw new PublicError('Conceda as permissões de consulta às agendas para concluir a conexão.');
    }
    return { access_token: raw.access_token, refresh_token: refresh, expires_at: Date.now() + raw.expires_in * 1000, scope };
  }
  async finish(provider: Provider, state: string, browser: string, code: string) {
    const saved = await this.store.readLink(state, 'state');
    if (!saved || saved.provider !== provider || !equal(saved.data.browser, digest(browser))) throw new PublicError('A autorização não corresponde a este navegador. Inicie novamente pelo WhatsApp.');
    if (!await this.store.takeLink(state, 'state')) throw new PublicError('Esta autorização já foi usada.');
    const tokens = await this.exchange(provider, { grant_type: 'authorization_code', code,
      code_verifier: saved.data.verifier, redirect_uri: this.callback(provider) });
    const identity = await jsonRequest(this.fetcher, this.settings(provider).userinfo, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    if (typeof identity.sub !== 'string' || !identity.sub || typeof identity.email !== 'string') throw new PublicError('Não foi possível identificar a conta autorizada.');
    if (provider === 'day') {
      const capability = await jsonRequest(this.fetcher, `${this.config.day.url}/rest/v1/rpc/zenit_day_hub_connection_check`, {
        method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', apikey: this.config.day.key, Authorization: `Bearer ${tokens.access_token}` }
      });
      if (capability.application !== 'zenit-day' || capability.hub_read_only !== true) throw new PublicError('A proteção de acesso somente para leitura precisa ser instalada no Day antes de conectar.');
    }
    const connection: Connection = { sender: saved.sender, provider, accountId: identity.sub, label: identity.email, tokens };
    const confirmation = randomToken();
    await this.store.link(confirmation, saved.sender, provider, connection, 'confirmation');
    await this.store.sendLater(saved.sender, { text: `Autorizar ${provider === 'day' ? 'Day' : 'Google Calendar'} (${connection.label}) nesta conversa?`,
      buttons: [{ id: `hub:approve:${confirmation}`, title: 'Conectar' }, { id: `hub:deny:${confirmation}`, title: 'Cancelar' }] });
  }
  async approve(sender: string, token: string, approved: boolean) {
    const pending = await this.store.approveLink(sender, token, approved);
    if (!pending) throw new PublicError('Esta confirmação expirou ou pertence a outra conversa.');
    return approved ? `${pending.provider === 'day' ? 'Day' : 'Google Calendar'} conectado. Suas outras conexões continuam ativas.` : 'Conexão cancelada.';
  }
  async connection(sender: string, provider: Provider) {
    const connection = await this.store.connection(sender, provider);
    if (!connection) throw new PublicError(`Conecte ${provider === 'day' ? 'o Day' : 'o Calendar'} primeiro.`);
    if (connection.tokens.expires_at > Date.now() + 60_000) return connection;
    const key = `${sender}:${provider}`;
    if (!this.refreshing.has(key)) {
      const work = (async () => {
        const tokens = await this.exchange(provider, { grant_type: 'refresh_token', refresh_token: connection.tokens.refresh_token }, connection.tokens);
        const refreshed = await this.store.refreshConnection(connection, tokens);
        if (!refreshed) {
          throw new PublicError('A conexão foi alterada. Faça a consulta novamente.');
        }
        return refreshed;
      })().finally(() => this.refreshing.delete(key));
      this.refreshing.set(key, work);
    }
    return this.refreshing.get(key)!;
  }
}
