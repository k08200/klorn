import { describe, expect, it } from "vitest";
import {
  createDemoClientLedger,
  DEMO_CLIENT_LEDGER_MAX_ENTRIES,
} from "../routes/playground-demo-ledger.js";

// The key-free demo's per-client ledger (routes/playground.ts, wall 1): 3 calls
// a minute and 10 a UTC day per client bucket, held in memory on a 512 MB
// instance. A burst of unique addresses must not grow it without bound.

const LIMITS = { perMinute: 3, perDay: 10 };
const T0 = new Date("2026-11-13T10:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const MINUTE = 60_000;

function takeN(
  ledger: ReturnType<typeof createDemoClientLedger>,
  bucket: string,
  n: number,
  now: Date,
) {
  return Array.from({ length: n }, () => ledger.take(bucket, now));
}

describe("demo client ledger: the limits a real visitor sees", () => {
  it("allows 3 calls in a minute, refuses the 4th, and allows again the next minute", () => {
    const ledger = createDemoClientLedger({ ...LIMITS, maxEntries: 100 });
    expect(takeN(ledger, "a", 4, T0)).toEqual([true, true, true, false]);
    expect(ledger.take("a", at(MINUTE))).toBe(true);
  });

  it("allows 10 calls in a UTC day across minutes, then refuses until the next day", () => {
    const ledger = createDemoClientLedger({ ...LIMITS, maxEntries: 100 });
    const allowed = Array.from({ length: 12 }, (_, i) => ledger.take("a", at(i * MINUTE)));
    expect(allowed.filter(Boolean)).toHaveLength(10);
    expect(allowed.slice(10)).toEqual([false, false]);
    expect(ledger.take("a", new Date("2026-11-14T00:00:00Z"))).toBe(true);
  });

  it("keeps clients apart", () => {
    const ledger = createDemoClientLedger({ ...LIMITS, maxEntries: 100 });
    takeN(ledger, "a", 3, T0);
    expect(ledger.take("a", T0)).toBe(false);
    expect(ledger.take("b", T0)).toBe(true);
  });
});

describe("demo client ledger: bounded memory", () => {
  it("never holds more than its cap, however many distinct clients arrive", () => {
    const ledger = createDemoClientLedger({ ...LIMITS, maxEntries: 50 });
    for (let i = 0; i < 5_000; i++) ledger.take(`client-${i}`, T0);
    expect(ledger.size).toBe(50);
  });

  it("evicts the least recently seen client first", () => {
    const ledger = createDemoClientLedger({ ...LIMITS, maxEntries: 3 });
    takeN(ledger, "a", 3, T0);
    takeN(ledger, "b", 3, T0);
    takeN(ledger, "c", 3, T0);
    ledger.take("a", T0); // refused, but seen: "a" is now the most recent

    ledger.take("d", T0); // full: "b" is the least recently seen

    expect(ledger.size).toBe(3);
    expect(ledger.take("a", T0)).toBe(false); // still at its minute cap
    expect(ledger.take("c", T0)).toBe(false);
    expect(ledger.take("b", T0)).toBe(true); // forgotten, so counted afresh
  });

  it("keeps a client that keeps hammering at its cap: a refused call refreshes it", () => {
    const ledger = createDemoClientLedger({ ...LIMITS, maxEntries: 2 });
    takeN(ledger, "hammer", 3, T0);
    for (let i = 0; i < 100; i++) {
      expect(ledger.take("hammer", T0)).toBe(false);
      ledger.take(`rotating-${i}`, T0);
    }
    expect(ledger.take("hammer", T0)).toBe(false);
  });

  it("drops previous-day clients first: their counts are already void", () => {
    const ledger = createDemoClientLedger({ ...LIMITS, maxEntries: 3 });
    ledger.take("yesterday-1", new Date("2026-11-12T23:58:00Z"));
    ledger.take("yesterday-2", new Date("2026-11-12T23:59:00Z"));
    takeN(ledger, "today", 3, T0);
    expect(ledger.size).toBe(1);

    ledger.take("today-2", T0);
    ledger.take("today-3", T0);
    expect(ledger.size).toBe(3);
    expect(ledger.take("today", T0)).toBe(false); // live entry kept
  });

  it("clear() empties it", () => {
    const ledger = createDemoClientLedger({ ...LIMITS, maxEntries: 10 });
    takeN(ledger, "a", 3, T0);
    ledger.clear();
    expect(ledger.size).toBe(0);
    expect(ledger.take("a", T0)).toBe(true);
  });

  it("caps production at 50,000 clients: over the 1,250 calls a day the default budget pays for", () => {
    expect(DEMO_CLIENT_LEDGER_MAX_ENTRIES).toBe(50_000);
  });
});
