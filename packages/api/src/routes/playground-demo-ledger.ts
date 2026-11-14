/**
 * The key-free demo's per-client ledger (routes/playground.ts, wall 1): N calls
 * a minute and M a UTC day per client bucket, in memory, bounded.
 *
 * The map it replaces evicted only previous-day entries once it crossed its
 * size, so within one day a burst of unique addresses grew it without bound
 * (~210 B an entry, measured: a million buckets is ~205 MB on a 512 MB
 * instance), and every insert past the size scanned the whole map.
 *
 * Now the map's insertion order is last-seen order: every call, allowed or
 * refused, moves its client to the end. Two evictions keep it bounded, both
 * from the front:
 *   - TTL: an entry last seen on an earlier UTC day carries no live count (both
 *     counters reset with the day). Within a day nothing expires, so the sweep
 *     runs on the first call of each UTC day only.
 *   - LRU: at the cap, about 1% of the least recently seen clients are dropped
 *     in one pass. Their counts restart if they return: they may get their
 *     slots again, never fewer. The global daily budget (wall 2) bounds the
 *     spend whatever this forgets.
 * Both open an iterator rarely, on purpose: front deletes leave holes in a V8
 * Map that every fresh iterator walks until the table is rebuilt, so evicting
 * one entry per call cost ~60 us a call under a flood, with multi-ms stalls.
 */

/** ~10.6 MB at the measured ~210 B an entry; see DEMO_CLIENT_LEDGER_MAX_ENTRIES' use. */
export const DEMO_CLIENT_LEDGER_MAX_ENTRIES = 50_000;

const MINUTE_MS = 60_000;
const DAY_KEY_LENGTH = 10;
/** Share of the cap dropped in one pass when full. */
const EVICT_FRACTION = 0.01;

export interface DemoClientLedgerOptions {
  perMinute: number;
  perDay: number;
  maxEntries: number;
}

export interface DemoClientLedger {
  /** Take one slot for this client; false when its minute or day cap is hit. */
  take(bucket: string, now: Date): boolean;
  readonly size: number;
  clear(): void;
}

interface ClientUsage {
  readonly minuteKey: number;
  readonly minuteCount: number;
  readonly dayKey: string;
  readonly dayCount: number;
}

export function createDemoClientLedger(options: DemoClientLedgerOptions): DemoClientLedger {
  const entries = new Map<string, ClientUsage>();
  const evictBatch = Math.max(1, Math.floor(options.maxEntries * EVICT_FRACTION));
  let sweptDay = "";

  /** Drop entries last seen before `dayKey`; they sit at the front (last-seen order). */
  function dropExpired(dayKey: string): void {
    for (const [bucket, usage] of entries) {
      if (usage.dayKey === dayKey) return;
      entries.delete(bucket);
    }
  }

  function dropLeastRecent(): void {
    let dropped = 0;
    for (const bucket of entries.keys()) {
      if (dropped >= evictBatch) return;
      entries.delete(bucket);
      dropped += 1;
    }
  }

  return {
    take(bucket, now) {
      const minuteKey = Math.floor(now.getTime() / MINUTE_MS);
      const dayKey = now.toISOString().slice(0, DAY_KEY_LENGTH);
      if (dayKey !== sweptDay) {
        dropExpired(dayKey);
        sweptDay = dayKey;
      }
      const prev = entries.get(bucket);
      const minuteCount = prev?.minuteKey === minuteKey ? prev.minuteCount : 0;
      const dayCount = prev?.dayKey === dayKey ? prev.dayCount : 0;
      const allowed = minuteCount < options.perMinute && dayCount < options.perDay;
      if (!allowed && !prev) return false;

      const step = allowed ? 1 : 0;
      entries.delete(bucket);
      if (!prev && entries.size >= options.maxEntries) dropLeastRecent();
      entries.set(bucket, {
        minuteKey,
        minuteCount: minuteCount + step,
        dayKey,
        dayCount: dayCount + step,
      });
      return allowed;
    },
    get size() {
      return entries.size;
    },
    clear() {
      entries.clear();
      sweptDay = "";
    },
  };
}
