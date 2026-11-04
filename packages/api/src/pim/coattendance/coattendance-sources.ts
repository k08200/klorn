/**
 * Coverage of the co-attendance counts: what a reader needs to tell a true 0 from
 * unknown, and what the pass needs to evaluate each finished UTC day once.
 *
 *   - User.coAttendanceCountedThrough, the watermark: the last UTC day through
 *     which every finished day has been evaluated, all of the user's Google
 *     calendar sources together. It only advances through days every covered
 *     source listed in full.
 *   - Per Google calendar source (the primary login's UserToken, each GOOGLE
 *     LinkedCalendarAccount): coAttendanceObservedSince, the first full day the
 *     source was covered by an advance of the watermark, and
 *     coAttendanceLastPassAt, the last pass in which that source's listing
 *     succeeded in full (not failed, not cut) through the days being evaluated,
 *     whether or not the watermark advanced. The pass uses it as its 6-hour
 *     interval. It is NOT a reader's freshness signal: a healthy source keeps it
 *     fresh while a failing one freezes the watermark. A source left out of an advance (re-link pending, not
 *     connectable, linked sync off) loses observedSince: its days were not
 *     covered. It starts again at the day after the watermark.
 *
 * The reader's gate (when a missing ContactCoAttendance row may read as 0) is in
 * judge/v3/relationship-coattendance.ts and docs/design/attention-engine-v3.md
 * §3(2): flag on, watermark current, every Google source covering the full
 * 30-day window, none needing reconnect, no non-Google calendar. Re-linking or
 * reconnecting a grant clears the source's two columns (routes/google-link-finish.ts);
 * unlinking deletes the row.
 */

import { INTERACTIVE_TX_OPTIONS, prisma } from "../../db.js";

export interface CoverageSource {
  readonly kind: "primary" | "linked";
  /** The UserToken id or the LinkedCalendarAccount id. */
  readonly id: string;
  readonly needsReconnect: boolean;
  readonly observedSince: Date | null;
  readonly lastPassAt: Date | null;
}

export interface Coverage {
  readonly countedThrough: Date | null;
  /** The primary first (when the user has one), then each GOOGLE linked calendar. */
  readonly sources: readonly CoverageSource[];
}

const MARKERS = {
  id: true,
  coAttendanceObservedSince: true,
  coAttendanceLastPassAt: true,
} as const;

export async function readCoverage(userId: string): Promise<Coverage> {
  const [user, token, linked] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { coAttendanceCountedThrough: true } }),
    prisma.userToken.findUnique({
      where: { userId_provider: { userId, provider: "google" } },
      select: MARKERS,
    }),
    prisma.linkedCalendarAccount.findMany({
      where: { userId, provider: "GOOGLE" },
      select: { ...MARKERS, needsReconnect: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const source = (
    kind: CoverageSource["kind"],
    row: {
      id: string;
      coAttendanceObservedSince: Date | null;
      coAttendanceLastPassAt: Date | null;
    },
    needsReconnect = false,
  ): CoverageSource => ({
    kind,
    id: row.id,
    needsReconnect,
    observedSince: row.coAttendanceObservedSince,
    lastPassAt: row.coAttendanceLastPassAt,
  });
  return {
    countedThrough: user?.coAttendanceCountedThrough ?? null,
    sources: [
      ...(token ? [source("primary", token)] : []),
      ...linked.map((row) => source("linked", row, row.needsReconnect)),
    ],
  };
}

/** True when the source never listed, or its last listing is at least `intervalMs` old. */
export function isPassDue(source: CoverageSource, now: Date, intervalMs: number): boolean {
  return source.lastPassAt === null || now.getTime() - source.lastPassAt.getTime() >= intervalMs;
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

function setSource(tx: Tx, source: CoverageSource, guard: object, data: object) {
  if (source.kind === "primary") {
    return tx.userToken.updateMany({
      where: { id: source.id, provider: "google", ...guard },
      data,
    });
  }
  return tx.linkedCalendarAccount.updateMany({
    where: { id: source.id, provider: "GOOGLE", ...guard },
    data,
  });
}

/**
 * The gap rule: days before the window were never covered, so coverage restarts.
 * The watermark moves to the day before the window and every source loses
 * observedSince until an advance covers it again (then: the window's first day).
 */
export async function restartCoverage(
  userId: string,
  watermark: Date,
  sources: readonly CoverageSource[],
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { coAttendanceCountedThrough: watermark },
    });
    for (const source of sources) {
      await setSource(tx, source, {}, { coAttendanceObservedSince: null });
    }
  }, INTERACTIVE_TX_OPTIONS);
}

export interface Advance {
  /** The watermark the pass started from; the advance is refused if it moved. */
  readonly previous: Date | null;
  /** The new watermark: the last day every covered source listed in full. */
  readonly through: Date;
  /** The first day of this advance: a newly covered source's observedSince. */
  readonly from: Date;
  /** Sources listed in full through `through` (a cut listing may be among them). */
  readonly covered: readonly CoverageSource[];
  /** Of those, the ones listed in full through yesterday, not cut: they get the pass time. */
  readonly complete: readonly CoverageSource[];
  /** Sources left out: they lose observedSince. */
  readonly dropped: readonly CoverageSource[];
  readonly now: Date;
}

/**
 * Advance the watermark and the sources' markers together. Returns false, changing
 * nothing, when the watermark moved since the pass read it (a concurrent pass).
 * A source re-linked meanwhile (its last pass changed) keeps its cleared markers.
 */
export async function recordAdvance(userId: string, advance: Advance): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const moved = await tx.user.updateMany({
      where: { id: userId, coAttendanceCountedThrough: advance.previous },
      data: { coAttendanceCountedThrough: advance.through },
    });
    if (moved.count === 0) return false;
    const complete = new Set(advance.complete.map((source) => source.id));
    for (const source of advance.covered) {
      await setSource(
        tx,
        source,
        { coAttendanceLastPassAt: source.lastPassAt },
        {
          ...(complete.has(source.id) ? { coAttendanceLastPassAt: advance.now } : {}),
          coAttendanceObservedSince: source.observedSince ?? advance.from,
        },
      );
    }
    for (const source of advance.dropped) {
      if (source.observedSince === null) continue;
      await setSource(tx, source, {}, { coAttendanceObservedSince: null });
    }
    return true;
  }, INTERACTIVE_TX_OPTIONS);
}

/**
 * A pass that advanced nothing (a source failed, or a cut listing covered no full
 * day): record the pass time of the sources whose listing was complete, and only
 * theirs. The pass time is what a reader checks for freshness, so it is never
 * written for a failed or cut listing.
 */
export async function recordListedOnly(
  sources: readonly CoverageSource[],
  now: Date,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    for (const source of sources) {
      await setSource(
        tx,
        source,
        { coAttendanceLastPassAt: source.lastPassAt },
        { coAttendanceLastPassAt: now },
      );
    }
  }, INTERACTIVE_TX_OPTIONS);
}
