import { test } from "node:test";
import assert from "node:assert/strict";
import { quietUntil, quietHoursSchema } from "../src/quiet-hours.js";
test("quiet hours use local time, inclusive start and exclusive end, overnight and DST", () => {
  const q = {
    enabled: true,
    start: "22:00",
    end: "07:00",
    timeZone: "America/Sao_Paulo",
  };
  const at = (s: string) => Date.parse(s);
  assert.equal(quietUntil(at("2026-10-14T21:59:59-03:00"), q), null);
  assert.equal(
    quietUntil(at("2026-10-14T22:00:00-03:00"), q),
    at("2026-10-15T07:00:00-03:00"),
  );
  assert.equal(
    quietUntil(at("2026-10-15T06:59:59-03:00"), q),
    at("2026-10-15T07:00:00-03:00"),
  );
  assert.equal(quietUntil(at("2026-10-15T07:00:00-03:00"), q), null);
  assert.equal(
    quietUntil(at("2026-10-14T12:30:00-03:00"), {
      ...q,
      start: "12:00",
      end: "14:00",
    }),
    at("2026-10-14T14:00:00-03:00"),
  );
  assert.equal(
    quietUntil(at("2026-03-08T01:30:00-05:00"), {
      ...q,
      timeZone: "America/New_York",
      end: "03:00",
    }),
    at("2026-03-08T03:00:00-04:00"),
  );
  assert.equal(
    quietUntil(at("2026-11-01T01:30:00-04:00"), {
      ...q,
      timeZone: "America/New_York",
      end: "02:00",
    }),
    at("2026-11-01T02:00:00-05:00"),
  );
  assert.equal(quietUntil(Date.now(), null), null);
  assert.equal(
    quietHoursSchema.safeParse({ ...q, end: "22:00" }).success,
    false,
  );
  assert.equal(
    quietHoursSchema.safeParse({ ...q, timeZone: "unknown" }).success,
    false,
  );
});
