import { z } from 'zod';
import { OAuth } from '../oauth.js';
import { jsonRequest } from '../http.js';
import type { Fetch } from '../types.js';
export const eventQuery = z.object({ start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }),
  calendarId: z.string().min(1).max(512).default('primary'), limit: z.number().int().min(1).max(50).default(20) }).strict()
  .refine(a => Date.parse(a.end) > Date.parse(a.start) && Date.parse(a.end) - Date.parse(a.start) <= 366 * 86400_000, 'Período inválido ou maior que um ano.');
export class Calendar {
  constructor(private oauth: OAuth, private fetcher: Fetch = fetch) {}
  async events(sender: string, input: unknown) {
    const args = eventQuery.parse(input); const c = await this.oauth.connection(sender, 'calendar');
    const params = new URLSearchParams({ timeMin: args.start, timeMax: args.end, singleEvents: 'true', orderBy: 'startTime',
      maxResults: String(args.limit), timeZone: this.oauth.config.timeZone, fields: 'items(id,summary,start,end,location,status),nextPageToken' });
    const result = await jsonRequest(this.fetcher, `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(args.calendarId)}/events?${params}`, {
      headers: { Authorization: `Bearer ${c.tokens.access_token}` }
    });
    return { events: result.items || [], truncated: Boolean(result.nextPageToken), calendar: args.calendarId, timeZone: this.oauth.config.timeZone };
  }
  async calendars(sender: string) {
    const c = await this.oauth.connection(sender, 'calendar');
    const result = await jsonRequest(this.fetcher, 'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=100&fields=items(id,summary,primary),nextPageToken', {
      headers: { Authorization: `Bearer ${c.tokens.access_token}` }
    });
    return { calendars: result.items || [], truncated: Boolean(result.nextPageToken) };
  }
}
