import { z } from "zod";

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const quietHoursSchema = z
  .object({
    enabled: z.boolean(),
    start: clock,
    end: clock,
    timeZone: z
      .string()
      .min(1)
      .max(80)
      .refine((v) => {
        try {
          new Intl.DateTimeFormat("pt-BR", { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }),
  })
  .strict()
  .refine(
    (v) => !v.enabled || v.start !== v.end,
    "Início e fim devem ser diferentes.",
  );
export type QuietHours = z.infer<typeof quietHoursSchema>;
export const quietHoursLabel = (q: QuietHours | null) =>
  q?.enabled ? `das ${q.start} às ${q.end} (${q.timeZone})` : "desativado";

// Work in instants, not a fixed UTC offset: handles overnight windows and DST.
export function quietUntil(now: number, q: QuietHours | null): number | null {
  if (!q?.enabled) return null;
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: q.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const inside = (at: number) => {
    const time = f.format(at);
    return q.start < q.end
      ? time >= q.start && time < q.end
      : time >= q.start || time < q.end;
  };
  if (!inside(now)) return null;
  for (
    let at = Math.floor(now / 60_000) * 60_000 + 60_000;
    at <= now + 27 * 3600_000;
    at += 60_000
  )
    if (!inside(at)) return at;
  throw new Error("Could not resolve quiet-hours boundary");
}
