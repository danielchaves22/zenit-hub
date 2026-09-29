export type Provider = 'day' | 'calendar';
export type Reply = { text: string; buttons?: { id: string; title: string }[] };
export type Incoming = { id: string; sender: string; text: string; button?: string; audio?: { mediaId: string }; timestamp: number };
export type Tokens = { access_token: string; refresh_token: string; expires_at: number; scope?: string };
export type Connection = { sender: string; provider: Provider; accountId: string; label: string; tokens: Tokens };
export type Fetch = typeof fetch;
export class PublicError extends Error {}
