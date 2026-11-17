import type { Pool } from 'pg';
import { z } from 'zod';
import type { Cash } from './connectors/cash.js';

export const assistantDefaultsSchema = z.object({
  model: z.string().trim().min(1).max(100),
  reasoningEffort: z.enum(['none', 'low', 'medium', 'high']).nullable(),
});
type AssistantDefaults = z.infer<typeof assistantDefaultsSchema>;
export const initialAssistantDefaults = { model: 'gpt-6.2-sol', reasoningEffort: 'low' } as const;

export class AssistantDefaultsCache {
  private current?: AssistantDefaults;
  private nextCheck = 0;
  private refreshing?: Promise<AssistantDefaults>;

  constructor(private cash: Pick<Cash, 'assistantDefaults'>, private db: Pool, private now = () => Date.now()) {}

  async get(): Promise<AssistantDefaults> {
    if (this.now() < this.nextCheck) return this.current ?? initialAssistantDefaults;
    this.refreshing ??= this.refresh().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async refresh(): Promise<AssistantDefaults> {
    const started = this.now();
    try {
      this.current = await this.cash.assistantDefaults();
      await this.db.query(`INSERT INTO assistant_defaults_cache (singleton, model, reasoning_effort, checked_at)
        VALUES (true, $1, $2, $3) ON CONFLICT (singleton) DO UPDATE
        SET model=EXCLUDED.model, reasoning_effort=EXCLUDED.reasoning_effort, checked_at=EXCLUDED.checked_at
        WHERE assistant_defaults_cache.checked_at <= EXCLUDED.checked_at`,
      [this.current.model, this.current.reasoningEffort, started])
        .catch(() => console.warn('hub.assistant.defaults.cache_write_failed'));
    } catch {
      console.warn('hub.assistant.defaults.bridge_unavailable');
      if (!this.current) {
        const saved = await this.db.query('SELECT model, reasoning_effort AS "reasoningEffort" FROM assistant_defaults_cache WHERE singleton')
          .catch(() => undefined);
        const cached = assistantDefaultsSchema.safeParse(saved?.rows[0]);
        if (cached.success) this.current = cached.data;
      }
    }
    this.nextCheck = this.now() + 60_000;
    return this.current ?? initialAssistantDefaults;
  }
}
