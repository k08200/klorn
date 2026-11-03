/**
 * PUSH interrupt budget (docs/design/attention-engine-v3.md §3(4), §8): the
 * most PUSH notifications Klorn may send a user per local day. Default 5
 * (founder decision 2026-10-31), user-adjustable. Once the day's budget is
 * spent, further PUSH candidates are held: QUEUE, top of the ranked list,
 * reason "held: daily interrupt budget", no notification.
 *
 * Live admission is atomic: each sent PUSH claims slot n by writing its
 * Notification with dedupeKey `interrupt:<day>:<n>`, and (userId, dedupeKey)
 * is unique, so concurrent judgements can never claim more slots than the
 * budget allows.
 */

export const DEFAULT_INTERRUPT_BUDGET = 5;
const UNLIMITED = "unlimited";
const FALLBACK_ZONE = "UTC";

/**
 * System default budget: JUDGE_V3_PUSH_BUDGET (positive integer or
 * "unlimited"), else 5. A set but invalid value (0, negative, text) falls back
 * to the default and is reported through `onInvalid`.
 */
export function resolveInterruptBudget(
  env: Readonly<Record<string, string | undefined>>,
  onInvalid?: (raw: string) => void,
): number | null {
  const raw = env.JUDGE_V3_PUSH_BUDGET?.trim().toLowerCase();
  if (raw === UNLIMITED) return null;
  if (raw && /^[1-9]\d*$/.test(raw)) return Number(raw);
  if (raw) onInvalid?.(raw);
  return DEFAULT_INTERRUPT_BUDGET;
}

/**
 * The user's local calendar day, YYYY-MM-DD. An invalid zone falls back to UTC
 * and reports `zone: "UTC"` so the caller can log it.
 */
export function localDayKey(now: Date, timeZone: string): { dayKey: string; zone: string } {
  const zone = isValidTimeZone(timeZone) ? timeZone : FALLBACK_ZONE;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { dayKey: `${get("year")}-${get("month")}-${get("day")}`, zone };
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch (err) {
    if (err instanceof RangeError) return false;
    throw err;
  }
}

/**
 * Every slot key starts with this. Clearing the bell must hide these rows, not
 * delete them (background.ts clearNotifications): deleting one would hand the
 * day's spent budget back.
 */
export const INTERRUPT_SLOT_ROOT = "interrupt:";
export const interruptSlotPrefix = (dayKey: string): string => `${INTERRUPT_SLOT_ROOT}${dayKey}:`;
export const interruptSlotKey = (dayKey: string, slot: number): string =>
  `${interruptSlotPrefix(dayKey)}${slot}`;

export interface BudgetCandidate {
  id: string;
  importance: number;
  receivedAt: Date;
}

/**
 * Batch admission (replay, and any future batch path): candidates are
 * admitted by importance, then arrival, then id, until the day's budget is
 * spent. Pure; returns ids.
 */
export function allocateInterruptBudget(
  candidates: readonly BudgetCandidate[],
  budget: { used: number; limit: number | null },
): { admitted: string[]; held: string[] } {
  const ordered = [...candidates].sort(
    (a, b) =>
      b.importance - a.importance ||
      a.receivedAt.getTime() - b.receivedAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const free = budget.limit === null ? ordered.length : Math.max(0, budget.limit - budget.used);
  return {
    admitted: ordered.slice(0, free).map((c) => c.id),
    held: ordered.slice(free).map((c) => c.id),
  };
}

export type SlotClaim =
  | { status: "admitted"; dedupeKey: string; used: number }
  | { status: "held"; used: number };

export interface SlotStore {
  /** Count of existing keys with this prefix for the user. */
  countUsed: (prefix: string) => Promise<number>;
  /** Insert the key; "taken" when the unique index already holds it. */
  tryCreate: (dedupeKey: string) => Promise<"created" | "taken">;
}

/**
 * Claim the next free interrupt slot for the day. Starts after the slots
 * already used and walks forward on a unique-index conflict, so a racing
 * claimer just takes the next number. Bounded: with a limit it stops at the
 * limit; without one it re-counts after a bounded number of conflicts.
 */
export async function claimInterruptSlot(
  input: { dayKey: string; limit: number | null } & SlotStore,
): Promise<SlotClaim> {
  const prefix = interruptSlotPrefix(input.dayKey);
  let slot = (await input.countUsed(prefix)) + 1;
  for (let attempts = 0; attempts < MAX_CLAIM_ATTEMPTS; attempts++) {
    if (input.limit !== null && slot > input.limit) return { status: "held", used: input.limit };
    if ((await input.tryCreate(interruptSlotKey(input.dayKey, slot))) === "created") {
      return { status: "admitted", dedupeKey: interruptSlotKey(input.dayKey, slot), used: slot };
    }
    slot++;
  }
  throw new Error(`interrupt budget: no slot claimed after ${MAX_CLAIM_ATTEMPTS} attempts`);
}

/** Upper bound on conflict retries in one claim; far above any real concurrency. */
const MAX_CLAIM_ATTEMPTS = 64;
