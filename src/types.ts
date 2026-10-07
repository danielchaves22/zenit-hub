export type Provider = 'day' | 'calendar';
export type Reply = { text: string; buttons?: { id: string; title: string }[];
  flow?: { token: string; favorites: { id: string; title: string; description: string }[] };
  list?: { button: string; rows: { id: string; title: string; description?: string }[] } };
export type Incoming = { id: string; sender: string; text: string; button?: string; audio?: { mediaId: string };
  flowReply?: { token: string; guestIds: string[] }; timestamp: number };
export type Tokens = { access_token: string; refresh_token: string; expires_at: number; scope?: string };
export type Connection = { sender: string; provider: Provider; accountId: string; label: string; tokens: Tokens; grantId?: string };
export type Fetch = typeof fetch;
export class PublicError extends Error {}
