/**
 * Per-user daily LLM cost gate.
 *
 * Wraps every paid LLM call. Reads the `LlmCostLedger` row for today,
 * compares against `DAILY_COST_CAP_CENTS`, and blocks the call once the
 * cap is exceeded. Successful calls increment the ledger.
 *
 * The previous code path only logged `estimateModelCostUsd()` — no hard
 * stop. A single runaway agent loop could rack up real money. With this
 * gate the worst case is one over-the-cap call (the one that crosses the
 * threshold), then every subsequent call short-circuits.
 *
 * Free models (cost = 0) still flow through here so we record the
 * `callCount` and `lastModel` for visibility, but they never trip the cap.
 */

import {
  DAILY_COST_CAP_CENTS,
  FREE_DAILY_COST_CAP_CENTS,
  GLOBAL_DAILY_COST_CAP_CENTS,
  JUDGE_BUDGET_RESERVE_CENTS,
  PAYWALL_ENABLED,
} from "../config.js";
import { prisma } from "../db.js";
import { captureError } from "../sentry.js";
import { notifyCostCapTrip } from "./cost-trip-alert.js";
import { isEntitled } from "./stripe.js";

export interface CostGateResult {
  allowed: boolean;
  remainingCents: number;
  usedCents: number;
  capCents: number;
  /**
   * True when the FREE-tier cap (paywall on, non-entitled user) is the cap in
   * force. Callers use it to pick the upgrade nudge over the BYOK nudge when
   * the gate blocks. Never true on the fail-open path (full cap applies there).
   */
  freeCapApplied?: boolean;
  reason?: string;
}

function utcDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// The free tier's daily limit: when the paywall is on, a non-entitled (free)
// user gets FREE_DAILY_COST_CAP_CENTS instead of the full cap — this is what
// bounds free classification/AUTO volume. When the paywall is off, or the user
// is entitled (paid/trial/admin), the normal cap applies and no extra lookup
// happens.
async function resolveCapCents(
  userId: string,
): Promise<{ capCents: number; freeCapApplied: boolean }> {
  if (!PAYWALL_ENABLED) return { capCents: DAILY_COST_CAP_CENTS, freeCapApplied: false };
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { plan: true, role: true },
    });
    if (user && !isEntitled(user.plan, user.role ?? undefined)) {
      return { capCents: FREE_DAILY_COST_CAP_CENTS, freeCapApplied: true };
    }
  } catch (err) {
    // Fail OPEN to the normal cap (not closed to the free cap) — a deliberate
    // tradeoff. resolveCapCents runs for EVERY user, so failing closed to the
    // free cap would throttle PAYING users to 10¢ during any DB blip (and
    // recordCostUsage's overCap would then wrongly block their calls). A full
    // outage already fails closed downstream: checkCostGate's ledger read
    // throws and blocks the call. The residual exposure — a narrow partial
    // failure letting a free user spend at the paid cap — is bounded by the
    // GLOBAL daily cap and surfaced via captureError so an operator can act on
    // a sustained fault. captureError no-ops when Sentry is off.
    console.warn("[cost-guard] plan lookup failed, using default cap:", err);
    captureError(err, { tags: { scope: "cost-guard.resolve-cap" }, extra: { userId } });
  }
  return { capCents: DAILY_COST_CAP_CENTS, freeCapApplied: false };
}

/**
 * How much of the daily cap only the judge may spend.
 *
 * On 2026-10-15 a credit top-up brought the LLM back at 22:07; by 22:28 the
 * account had spent 101¢ of a 100¢ cap, nearly all of it chat/agent traffic on
 * a model 6.7x the judge's price. Every paid call was then blocked until UTC
 * midnight and the judge fell back to keywords, which structurally cannot emit
 * PUSH. The product's one promise went dark because a side surface spent the
 * budget first.
 *
 * `priority: "background"` was already documented as stopping background work
 * from starving chat, but it only feeds the concurrency pacer — this file
 * never read it — so neither direction was actually protected.
 *
 * Sizing, from the ledger rather than from the prompt: every call pre-bills a
 * nominal 2000 prompt + 500 completion tokens (llm-usage.ts), and the true-up
 * only charges positive deltas, so that floor is never refunded. At
 * gemini-2.5-flash rates ($0.30/$2.50 per M) that is ~0.185¢ a call, so the recommended 25¢
 * buys roughly 135 classifications a day — not the ~1000 an earlier version of
 * this comment claimed from the raw ~700-token prompt size. A mailbox taking
 * more than ~135 new messages a day, or one whose low-confidence tail
 * escalates through the judge dial, needs more than 25¢.
 *
 * Two things the name does not say. The reserve is headroom above the ordinary
 * line, not a separate bucket: judge spend lands in the same daily total, so a
 * heavy classification day still shrinks what chat has left. And on the free
 * tier the clamp bites — a 25¢ reserve against a 10¢ cap leaves ordinary calls
 * 5¢, halving them.
 *
 * 0 disables the reserve and restores the previous behaviour exactly.
 */
function effectiveCap(fullCap: number, reserved: boolean | undefined): number {
  return reserved ? fullCap : fullCap - reserveCents(fullCap);
}

function reserveCents(capCents: number): number {
  if (JUDGE_BUDGET_RESERVE_CENTS <= 0 || capCents <= 0) return 0;
  // A reserve at or above the cap would leave every other surface nothing,
  // which presents as "chat is broken" rather than "the reserve is too big".
  // Never take more than half.
  return Math.min(JUDGE_BUDGET_RESERVE_CENTS, Math.floor(capCents / 2));
}

/**
 * Check whether `userId` is allowed to make another paid LLM call today.
 * Reads but does not mutate. Cap = 0 disables the gate entirely.
 *
 * `reserved` marks a call that may draw on the judge's reserved slice. Only
 * the firewall judge passes it: it is the one surface whose failure is
 * invisible to the user, because mail keeps being sorted — just without the
 * lane the product is sold on.
 */
export async function checkCostGate(
  userId: string,
  options: { reserved?: boolean } = {},
): Promise<CostGateResult> {
  const { capCents: fullCap, freeCapApplied } = await resolveCapCents(userId);
  // Ordinary calls stop early so the judge always has somewhere to spend.
  const cap = effectiveCap(fullCap, options.reserved);
  if (cap <= 0) {
    return {
      allowed: true,
      remainingCents: Number.POSITIVE_INFINITY,
      usedCents: 0,
      capCents: 0,
      freeCapApplied,
    };
  }
  const row = await prisma.llmCostLedger.findUnique({
    where: { userId_dayKey: { userId, dayKey: utcDayKey() } },
    select: { cents: true },
  });
  const used = row?.cents ?? 0;
  if (used >= cap) {
    // Fire-and-forget visibility: once per user per UTC day (deduped inside).
    // Only the REAL ceiling is an incident. With a reserve active, an ordinary
    // call stopping at (cap - reserve) is the feature working — the judge still
    // has budget and nothing has degraded. Alerting there would spend the
    // once-per-day dedupe and then swallow the full-cap alert, which is the one
    // that means the judge has actually gone dark. The alert text says exactly
    // that ("judge degrades to keyword fallback"), so firing it early would also
    // be false.
    if (cap === fullCap) {
      void notifyCostCapTrip({ scope: "user", userId, usedCents: used, capCents: cap });
    }
    return {
      allowed: false,
      remainingCents: 0,
      usedCents: used,
      capCents: cap,
      freeCapApplied,
      reason: `Daily cap reached (${used}¢/${cap}¢)`,
    };
  }
  return {
    allowed: true,
    remainingCents: cap - used,
    usedCents: used,
    capCents: cap,
    freeCapApplied,
  };
}

// Fractional-cent carry per user for today. The DB column stays integer
// cents (no schema change): sub-cent charges accumulate here and flush to
// the ledger as whole cents once they add up. In-memory and single-instance
// by the same argument as the global accumulator below; worst case on a
// restart is under 1¢ of forgiven carry per active user.
const fractionalCarry = new Map<string, { dayKey: string; frac: number }>();

/**
 * Record an LLM call against today's ledger. `cents` is the estimated cost
 * in USD cents and MAY be fractional (0.01¢ precision) — whole cents land in
 * the integer DB column, the sub-cent remainder carries in memory. Use 0 for
 * free models so the call still counts toward usage tracking.
 */
export async function recordCostUsage(
  userId: string,
  cents: number,
  model: string | null,
  options: { reserved?: boolean } = {},
): Promise<{ totalCents: number; overCap: boolean } | null> {
  const safeCents = Number.isFinite(cents) ? Math.max(0, cents) : 0;
  const dayKey = utcDayKey();
  const carried = fractionalCarry.get(userId);
  const priorFrac = carried && carried.dayKey === dayKey ? carried.frac : 0;
  const combined = priorFrac + safeCents;
  const wholeCents = Math.floor(combined + 1e-9);
  const nextFrac = Math.max(0, Math.round((combined - wholeCents) * 10_000) / 10_000);
  try {
    // The increment is atomic, and we read the post-increment total back so the
    // caller can close the check-then-act TOCTOU: two concurrent calls can both
    // pass the read-side checkCostGate, but only the increments that actually
    // cross the cap report overCap=true.
    const row = await prisma.llmCostLedger.upsert({
      where: { userId_dayKey: { userId, dayKey } },
      create: {
        userId,
        dayKey,
        cents: wholeCents,
        callCount: 1,
        lastModel: model,
      },
      update: {
        cents: { increment: wholeCents },
        callCount: { increment: 1 },
        lastModel: model ?? undefined,
      },
      select: { cents: true },
    });
    // Commit the carry only after the DB write landed: on failure the whole
    // charge is dropped (existing best-effort contract), not half-absorbed.
    fractionalCarry.set(userId, { dayKey, frac: nextFrac });
    const { capCents: fullCap } = await resolveCapCents(userId);
    const cap = effectiveCap(fullCap, options.reserved);
    const overCap = cap > 0 && row.cents > cap;
    if (overCap && cap === fullCap) {
      // The increment that crossed the REAL ceiling — surface it (deduped per
      // day). An ordinary call crossing (cap - reserve) is the reserve doing
      // its job, not an incident, and alerting there would spend the
      // once-a-day dedupe before the trip that actually darkens the judge.
      void notifyCostCapTrip({ scope: "user", userId, usedCents: row.cents, capCents: cap });
    }
    return { totalCents: row.cents, overCap };
  } catch (err) {
    // The ledger is best-effort accounting; never fail the user-facing call
    // because of a write here. But a sustained failure means we're silently
    // dropping all cost accounting (and the cap can't bite) — surface it.
    console.warn("[cost-guard] failed to record usage:", err);
    captureError(err, {
      tags: { scope: "cost-guard.record-usage" },
      extra: { userId, cents: safeCents, model },
    });
    return null;
  }
}

// Moved to cents.ts (leaf module — llm-usage.ts needs it without dragging
// in this file's db.js/Prisma .env-autoload side effect). Re-exported so
// existing importers keep working.
export { usdToCents } from "./cents.js";

// ── Global daily ceiling ──────────────────────────────────────────────────
// Aggregate across every LLM call (per-user AND system-initiated) for one UTC
// day. This is the circuit breaker the per-user gate cannot be: it is the only
// gate that sees calls made without a userId — schedulers, reconcilers, the
// fallback-rejudge sweep.
//
// It lived in a module variable until 2026-08-04. On Render every deploy and
// every wake-from-idle restarts the container, and each restart forgot the
// day's spend and began again at zero, so the ceiling never actually bound.
// That is why the 2026-06-05 billing spike had no brake and
// BACKGROUND_AGENTS_DISABLED had to serve as one (index.ts) — which in turn
// disabled every scheduler, including outage repair and the key-headroom probe.
//
// The ledger is now a row per UTC day (GlobalCostLedger): the rollover is a new
// row rather than a timer, the increment is applied server-side so concurrent
// writers cannot lose spend, and the amount is stored as integer micro-cents so
// sub-cent classifications accumulate exactly — neither rounded up to 1¢ each
// (20x too fast) nor drifting the way accumulated floats do.

/** Storage precision: 1 cent = 10_000 micro-cents (matches the pre-bill). */
const MICRO_PER_CENT = 10_000;

/** Check whether the global daily ceiling still allows another paid call. */
export async function checkGlobalCostGate(): Promise<CostGateResult> {
  const cap = GLOBAL_DAILY_COST_CAP_CENTS;
  if (cap <= 0) {
    return { allowed: true, remainingCents: Number.POSITIVE_INFINITY, usedCents: 0, capCents: 0 };
  }
  const row = await prisma.globalCostLedger.findUnique({
    where: { dayKey: utcDayKey() },
    select: { microCents: true },
  });
  const used = (row?.microCents ?? 0) / MICRO_PER_CENT;
  if (used >= cap) {
    // Fire-and-forget visibility: once per UTC day (deduped inside).
    void notifyCostCapTrip({ scope: "global", usedCents: used, capCents: cap });
    return {
      allowed: false,
      remainingCents: 0,
      usedCents: used,
      capCents: cap,
      reason: `Global daily cap reached (${Math.round(used * 100) / 100}¢/${cap}¢)`,
    };
  }
  return { allowed: true, remainingCents: cap - used, usedCents: used, capCents: cap };
}

/**
 * Record cost against the global ceiling. Called for every LLM call that the
 * shared key pays for. Returns the post-increment total so the caller can
 * re-check it: two calls that both passed the read-side gate would otherwise
 * both slip through (the same check-then-act race the per-user path closes).
 *
 * Cap <= 0 disables the ceiling AND its ledger, symmetric with
 * checkGlobalCostGate: DB-less contexts (CI eval/canary jobs) rely on the
 * whole gate being inert, and a write here would throw before the judge call
 * ever ran. With a nonzero cap a failed write still throws — spend that
 * cannot be recorded must not happen (fail-closed, #1004).
 */
export async function recordGlobalCostUsage(
  cents: number,
): Promise<{ totalCents: number; overCap: boolean } | null> {
  if (GLOBAL_DAILY_COST_CAP_CENTS <= 0) return null;
  const amount = Number.isFinite(cents) ? Math.max(0, cents) : 0;
  if (amount <= 0) return null;
  const micro = Math.round(amount * MICRO_PER_CENT);
  if (micro <= 0) return null;
  const dayKey = utcDayKey();
  const row = await prisma.globalCostLedger.upsert({
    where: { dayKey },
    create: { dayKey, microCents: micro, callCount: 1 },
    update: { microCents: { increment: micro }, callCount: { increment: 1 } },
    select: { microCents: true },
  });
  const totalCents = row.microCents / MICRO_PER_CENT;
  const cap = GLOBAL_DAILY_COST_CAP_CENTS;
  const overCap = cap > 0 && totalCents >= cap;
  if (overCap) {
    void notifyCostCapTrip({ scope: "global", usedCents: totalCents, capCents: cap });
  }
  return { totalCents, overCap };
}

/** Test seam: clear the per-user fractional carries. */
export function __resetGlobalSpendForTest(): void {
  fractionalCarry.clear();
}
