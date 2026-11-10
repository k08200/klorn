/**
 * Cohort + PMF — knowing who is in the 100 before pricing them.
 *
 * The launch plan gates the pricing decision on beta cohort feedback, and the
 * competitive analysis put a number on it: 40% or more answering "very
 * disappointed" to the Sean Ellis question. Neither the number nor the cohort
 * it would come from exists today. Klorn cannot currently answer *who showed
 * up* or *would they miss it* — which means the next pricing decision would be
 * instinct wearing a number's clothes.
 *
 * Two halves, deliberately asymmetric in how they get their data:
 *
 *   - **PMF** has to be asked, because nobody's disappointment is observable.
 *     One question, once, and only of someone who has actually used the thing.
 *   - **The cohort readout asks nothing.** Who someone is, how much mail they
 *     get and where they came from are already in the database. A survey that
 *     re-asks what you already store is a survey people stop answering.
 *
 * A note on the original plan item, which said to reframe the 100-account cap
 * as *selection* ("we pick who gets in"). That is not available to us: sign-up
 * is open Production OAuth with the beta gate off, so anyone can create an
 * account. Saying we select would be a lie about our own funnel. What is
 * honest, and more useful, is to measure who arrived — hence this.
 *
 * Off by default behind `PMF_PROBE_ENABLED` (the probe only; the readout is
 * admin-side and reads what already exists).
 */

import { prisma } from "../db.js";
import { captureError } from "../sentry.js";

export const PMF_ANSWERS = ["VERY", "SOMEWHAT", "NOT"] as const;
export type PmfAnswer = (typeof PMF_ANSWERS)[number];

/**
 * Asking on day one measures onboarding, not fit. Sean Ellis's own guidance is
 * to ask people who have experienced the core value; for a triage product that
 * means enough days for mail to have actually arrived and been sorted.
 */
const MIN_TENURE_DAYS = 7;

/** And enough judgements that the product has visibly done its job at all. */
const MIN_DECISIONS = 20;

/**
 * Below this, the percentage is noise wearing a decimal point. Two of three
 * respondents is 67% and means nothing; reporting it as a cleared gate would
 * be the exact false precision this repo refuses elsewhere.
 */
const MIN_SAMPLE = 40;

/** The threshold the launch plan gates pricing on. */
const GATE_PCT = 40;

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far back the cohort readout counts mail. */
const VOLUME_WINDOW_DAYS = 30;

export function isPmfProbeEnabled(): boolean {
  return process.env.PMF_PROBE_ENABLED === "true";
}

/**
 * Should this user be asked?
 *
 * Fails **closed**: on any error we do not ask. Every other read path in this
 * codebase fails open because the cost of silence is a missing feature; here
 * the cost is interrupting a user with a survey we were not sure they had
 * earned, which is worse than never asking at all.
 */
export async function isPmfEligible(userId: string, now: Date = new Date()): Promise<boolean> {
  if (!isPmfProbeEnabled()) return false;
  try {
    const [user, existing] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { createdAt: true } }),
      prisma.pmfResponse.findUnique({ where: { userId }, select: { answer: true } }),
    ]);
    if (!user || existing) return false;

    const tenureDays = Math.floor((now.getTime() - user.createdAt.getTime()) / DAY_MS);
    if (tenureDays < MIN_TENURE_DAYS) return false;

    const decisions = await prisma.decisionLabel.count({ where: { userId } });
    return decisions >= MIN_DECISIONS;
  } catch (err) {
    console.warn(
      "[cohort] PMF eligibility check failed:",
      err instanceof Error ? err.message : String(err),
    );
    captureError(err, { tags: { scope: "pmf-eligible" }, extra: { userId } });
    return false;
  }
}

/**
 * Store one answer per user. Upsert rather than create: a user who reconsiders
 * should be able to say so, and the point of the number is what they think now.
 *
 * Does not fail open — an answer the user believes they gave, that silently did
 * not persist, corrupts the very measurement this exists to produce.
 */
export async function recordPmfResponse(userId: string, answer: PmfAnswer): Promise<void> {
  if (!(PMF_ANSWERS as readonly string[]).includes(answer)) {
    throw new Error(`pmf: answer must be one of ${PMF_ANSWERS.join(", ")}`);
  }
  await prisma.pmfResponse.upsert({
    where: { userId },
    create: { userId, answer },
    update: { answer, respondedAt: new Date() },
  });
}

export interface PmfSummary {
  responses: number;
  very: number;
  veryPct: number;
  /** Both the share and the sample have to hold. */
  gateMet: boolean;
  /** True when the percentage exists but should not be acted on yet. */
  belowMinimumSample: boolean;
  minimumSample: number;
  gatePct: number;
}

export async function pmfSummary(): Promise<PmfSummary> {
  const base = {
    responses: 0,
    very: 0,
    veryPct: 0,
    gateMet: false,
    belowMinimumSample: true,
    minimumSample: MIN_SAMPLE,
    gatePct: GATE_PCT,
  };
  try {
    // Delegate cast, the same escape hatch attention-override.ts uses: Prisma's
    // groupBy overload does not resolve cleanly for a two-column model, and the
    // shape we actually consume is three lines below.
    const grouped = await (
      prisma.pmfResponse as unknown as {
        groupBy: (args: unknown) => Promise<{ answer: string; _count?: { _all?: number } }[]>;
      }
    ).groupBy({ by: ["answer"], _count: { _all: true } });

    const responses = grouped.reduce((n, r) => n + (r._count?._all ?? 0), 0);
    if (responses === 0) return base;

    const very = grouped.find((r) => r.answer === "VERY")?._count?._all ?? 0;
    const veryPct = Math.round((very / responses) * 100);
    const belowMinimumSample = responses < MIN_SAMPLE;

    return {
      ...base,
      responses,
      very,
      veryPct,
      belowMinimumSample,
      gateMet: veryPct >= GATE_PCT && !belowMinimumSample,
    };
  } catch (err) {
    console.warn("[cohort] PMF summary failed:", err instanceof Error ? err.message : String(err));
    captureError(err, { tags: { scope: "pmf-summary" } });
    return base;
  }
}

export interface CohortRow {
  userId: string;
  email: string | null;
  tenureDays: number;
  mailVolume30d: number;
  attribution: string | null;
  plan: string;
  pmf: PmfAnswer | null;
}

/**
 * One table answering "who actually showed up".
 *
 * Ranked by mail volume because that is the ICP hypothesis: Klorn is for people
 * who get too much mail. If the top of this table is people receiving thirty
 * messages a month, the hypothesis is wrong and the pricing question changes
 * shape — which is exactly the kind of thing that should be visible before the
 * decision, not after.
 *
 * Asks the user nothing. Every column is already stored.
 */
export async function cohortReadout(now: Date = new Date()): Promise<CohortRow[]> {
  const since = new Date(now.getTime() - VOLUME_WINDOW_DAYS * DAY_MS);
  try {
    const users = (await prisma.user.findMany({
      select: { id: true, email: true, createdAt: true, plan: true, attribution: true },
    })) as {
      id: string;
      email: string | null;
      createdAt: Date;
      plan: string;
      attribution: string | null;
    }[];
    if (users.length === 0) return [];

    const [volumes, answers] = await Promise.all([
      prisma.emailMessage.groupBy({
        by: ["userId"],
        where: { receivedAt: { gte: since } },
        _count: { _all: true },
      }),
      prisma.pmfResponse.findMany({ select: { userId: true, answer: true } }),
    ]);

    const volumeBy = new Map(
      (volumes as { userId: string; _count?: { _all?: number } }[]).map((v) => [
        v.userId,
        v._count?._all ?? 0,
      ]),
    );
    const pmfBy = new Map(
      (answers as { userId: string; answer: string }[]).map((a) => [
        a.userId,
        a.answer as PmfAnswer,
      ]),
    );

    return users
      .map((u) => ({
        userId: u.id,
        email: u.email,
        tenureDays: Math.floor((now.getTime() - u.createdAt.getTime()) / DAY_MS),
        mailVolume30d: volumeBy.get(u.id) ?? 0,
        attribution: u.attribution,
        plan: u.plan,
        pmf: pmfBy.get(u.id) ?? null,
      }))
      .sort((a, b) => b.mailVolume30d - a.mailVolume30d);
  } catch (err) {
    console.warn("[cohort] readout failed:", err instanceof Error ? err.message : String(err));
    captureError(err, { tags: { scope: "cohort-readout" } });
    return [];
  }
}
