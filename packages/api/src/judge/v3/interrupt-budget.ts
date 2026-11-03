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

/** Upper bound for a user's own daily budget (AutomationConfig.interruptBudget). */
export const MAX_USER_INTERRUPT_BUDGET = 50;

/** A per-user budget value the settings API accepts: an integer 1..50. */
export function isValidUserInterruptBudget(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_USER_INTERRUPT_BUDGET
  );
}

/** The user's own budget when set and valid; otherwise the system default. */
export function resolveUserInterruptBudget(
  userValue: number | null,
  env: NodeJS.ProcessEnv,
  onInvalid?: (raw: string) => void,
): number | null {
  return isValidUserInterruptBudget(userValue) ? userValue : resolveInterruptBudget(env, onInvalid);
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

/**
 * Share of the day's slots reserved for trusted senders (doc §3(5)): a VIP, or
 * someone the user has written to. Strangers claim only above the reserve, so
 * urgent-looking mail from people the user never wrote to cannot spend the
 * whole day's budget.
 */
export const TRUSTED_SLOT_SHARE = 0.4;

/** Slots 1..n reserved for trusted senders (none without a limit). */
export function reservedTrustedSlots(limit: number | null): number {
  return limit === null ? 0 : Math.floor(limit * TRUSTED_SLOT_SHARE);
}

export interface BudgetCandidate {
  id: string;
  importance: number;
  receivedAt: Date;
  /** A trusted sender may use the reserved slots. */
  trusted: boolean;
}

/**
 * Batch admission (replay): candidates are admitted by importance, then
 * arrival, then id, until the day's budget is spent; strangers stop at their
 * share. Pure; returns ids.
 */
export function allocateInterruptBudget(
  candidates: readonly BudgetCandidate[],
  budget: { limit: number | null },
): { admitted: string[]; held: string[] } {
  const ordered = [...candidates].sort(
    (a, b) =>
      b.importance - a.importance ||
      a.receivedAt.getTime() - b.receivedAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const { limit } = budget;
  if (limit === null) return { admitted: ordered.map((c) => c.id), held: [] };
  const strangerCap = limit - reservedTrustedSlots(limit);
  const admitted: string[] = [];
  const held: string[] = [];
  let strangers = 0;
  for (const c of ordered) {
    const fits = admitted.length < limit && (c.trusted || strangers < strangerCap);
    if (!fits) {
      held.push(c.id);
      continue;
    }
    admitted.push(c.id);
    if (!c.trusted) strangers++;
  }
  return { admitted, held };
}

export type SlotClaim =
  | { status: "admitted"; dedupeKey: string; used: number }
  | { status: "held"; used: number };

export interface SlotStore {
  /** Slot numbers already used for the day (parsed from the keys with this prefix). */
  usedSlots: (prefix: string) => Promise<number[]>;
  /** Insert the key; "taken" when the unique index already holds it. */
  tryCreate: (dedupeKey: string) => Promise<"created" | "taken">;
}

/**
 * Claim a free interrupt slot for the day. With a limit, slots are 1..limit:
 * a trusted sender takes the lowest free one, a stranger only one above the
 * trusted reserve. A unique-index conflict means a racing claimer took that
 * slot, so the claim moves on to the next; at most `limit` attempts. Without
 * a limit it takes the next number after the highest used one.
 */
export async function claimInterruptSlot(
  input: { dayKey: string; limit: number | null; trusted: boolean } & SlotStore,
): Promise<SlotClaim> {
  const prefix = interruptSlotPrefix(input.dayKey);
  const used = new Set((await input.usedSlots(prefix)).filter((n) => Number.isInteger(n) && n > 0));
  if (input.limit === null) return claimUnlimited(input, used);
  const lowest = input.trusted ? 1 : reservedTrustedSlots(input.limit) + 1;
  for (let slot = lowest; slot <= input.limit; slot++) {
    if (used.has(slot)) continue;
    const key = interruptSlotKey(input.dayKey, slot);
    if ((await input.tryCreate(key)) === "created") {
      return { status: "admitted", dedupeKey: key, used: used.size + 1 };
    }
    used.add(slot);
  }
  return { status: "held", used: used.size };
}

async function claimUnlimited(
  input: { dayKey: string } & SlotStore,
  used: Set<number>,
): Promise<SlotClaim> {
  let slot = Math.max(0, ...used) + 1;
  for (let attempts = 0; attempts < MAX_CLAIM_ATTEMPTS; attempts++, slot++) {
    const key = interruptSlotKey(input.dayKey, slot);
    if ((await input.tryCreate(key)) === "created") {
      return { status: "admitted", dedupeKey: key, used: used.size + 1 };
    }
    used.add(slot);
  }
  throw new Error(`interrupt budget: no slot claimed after ${MAX_CLAIM_ATTEMPTS} attempts`);
}

/** Upper bound on conflict retries in one claim; far above any real concurrency. */
const MAX_CLAIM_ATTEMPTS = 64;
