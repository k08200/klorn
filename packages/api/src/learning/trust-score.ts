/**
 * Contact Trust Score
 *
 * Tracks how reliably a counterparty fulfills their commitments.
 * Built on top of the Commitment Ledger — every time a COUNTERPARTY
 * commitment is marked DONE we record whether it was on-time or late.
 *
 * Badges:
 *   reliable        ≥80% on-time, ≥3 data points
 *   mostly_reliable ≥50% on-time, ≥3 data points
 *   unreliable      <50% on-time, ≥3 data points
 *   unknown         <3 data points
 *
 * Usage:
 *   - Call updateTrustScore() when a COUNTERPARTY commitment is completed.
 *   - Call getTrustScore() to display a badge in Inbox commitment cards.
 *   - Call getTrustScoreHint() to inject context into agent prompts.
 */

import { prisma } from "../db.js";

export type TrustBadge = "reliable" | "mostly_reliable" | "unreliable" | "unknown";

export interface TrustScoreResult {
  contactEmail: string;
  displayName: string | null;
  totalCount: number;
  onTimeCount: number;
  lateCount: number;
  onTimeRate: number; // 0.0-1.0
  avgDelayDays: number;
  badge: TrustBadge;
  label: string;
}

import {
  TRUST_HALF_LIFE_DAYS,
  TRUST_MIN_DATA_POINTS,
  TRUST_MOSTLY_RELIABLE_THRESHOLD,
  TRUST_RELIABLE_THRESHOLD,
} from "../config.js";

const MIN_DATA_POINTS = TRUST_MIN_DATA_POINTS;
const STALE_THRESHOLD_DAYS = Math.max(30, TRUST_HALF_LIFE_DAYS * 2);

/**
 * Returns true if the trust row is too old to be load-bearing. We do not yet
 * carry per-event timestamps so we can't do full exponential decay; until that
 * migration lands, we treat anything not touched in the last 2 half-lives as
 * stale and demote it to "unknown" so a year-old "reliable" badge can't
 * outlive a fresh pattern of misses.
 */
function isStale(lastUpdatedAt: Date | null | undefined): boolean {
  if (!lastUpdatedAt) return false;
  const ageMs = Date.now() - lastUpdatedAt.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return ageDays > STALE_THRESHOLD_DAYS;
}

// ─── Write ───────────────────────────────────────────────────────────────────

/**
 * Record one commitment outcome for a counterparty.
 * Call this when a COUNTERPARTY-owned commitment transitions to DONE.
 *
 * @param daysLate  0 if on-time, positive integer if late
 */
export async function updateTrustScore(
  userId: string,
  contactEmail: string,
  displayName: string | null,
  wasOnTime: boolean,
  daysLate = 0,
): Promise<void> {
  const email = contactEmail.toLowerCase().trim();
  if (!email) return;

  try {
    await prisma.contactTrustScore.upsert({
      where: { userId_contactEmail: { userId, contactEmail: email } },
      create: {
        userId,
        contactEmail: email,
        displayName,
        totalCount: 1,
        onTimeCount: wasOnTime ? 1 : 0,
        lateCount: wasOnTime ? 0 : 1,
        totalDelayDays: Math.max(0, daysLate),
        lastUpdatedAt: new Date(),
      },
      update: {
        ...(displayName ? { displayName } : {}),
        totalCount: { increment: 1 },
        ...(wasOnTime ? { onTimeCount: { increment: 1 } } : { lateCount: { increment: 1 } }),
        ...(daysLate > 0 ? { totalDelayDays: { increment: daysLate } } : {}),
        lastUpdatedAt: new Date(),
      },
    });
  } catch (err) {
    console.warn("[trust-score] updateTrustScore failed:", contactEmail, err);
  }
}

// ─── Read ────────────────────────────────────────────────────────────────────

export async function getTrustScore(
  userId: string,
  contactEmail: string,
): Promise<TrustScoreResult | null> {
  const email = contactEmail.toLowerCase().trim();
  try {
    const row = await prisma.contactTrustScore.findUnique({
      where: { userId_contactEmail: { userId, contactEmail: email } },
    });
    if (!row || row.totalCount === 0) return null;
    return computeResult(row);
  } catch {
    return null;
  }
}

export async function getTrustScoresBulk(
  userId: string,
  contactEmails: string[],
): Promise<Map<string, TrustScoreResult>> {
  const emails = contactEmails.map((e) => e.toLowerCase().trim()).filter(Boolean);
  if (emails.length === 0) return new Map();

  try {
    const rows = await prisma.contactTrustScore.findMany({
      where: { userId, contactEmail: { in: emails } },
    });
    const map = new Map<string, TrustScoreResult>();
    for (const row of rows) {
      map.set(row.contactEmail, computeResult(row));
    }
    return map;
  } catch {
    return new Map();
  }
}

// ─── Agent Prompt Hint ───────────────────────────────────────────────────────

/**
 * Returns a compact text snippet for injection into agent prompts.
 * Only includes contacts with ≥3 data points so the agent doesn't
 * over-interpret thin data.
 */
export async function buildTrustHintForPrompt(userId: string): Promise<string> {
  try {
    const rows = await prisma.contactTrustScore.findMany({
      where: { userId, totalCount: { gte: MIN_DATA_POINTS } },
      orderBy: { lastUpdatedAt: "desc" },
      take: 10,
    });
    if (rows.length === 0) return "";

    const lines = rows.map((row) => {
      const r = computeResult(row);
      const name = r.displayName || r.contactEmail;
      if (r.badge === "reliable")
        return `- ${name}: reliable (${Math.round(r.onTimeRate * 100)}% on-time)`;
      if (r.badge === "mostly_reliable") {
        const delay = r.avgDelayDays > 0 ? `, avg +${Math.round(r.avgDelayDays)}d late` : "";
        return `- ${name}: mostly reliable (${Math.round(r.onTimeRate * 100)}% on-time${delay})`;
      }
      return `- ${name}: unreliable (${Math.round(r.onTimeRate * 100)}% on-time, avg +${Math.round(r.avgDelayDays)}d late) — factor in extra buffer`;
    });

    return `\n## Contact Reliability\nBased on tracked commitments:\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function computeResult(row: {
  contactEmail: string;
  displayName: string | null;
  totalCount: number;
  onTimeCount: number;
  lateCount: number;
  totalDelayDays: number;
  lastUpdatedAt?: Date | null;
}): TrustScoreResult {
  const onTimeRate = row.totalCount > 0 ? row.onTimeCount / row.totalCount : 0;
  const avgDelayDays = row.lateCount > 0 ? row.totalDelayDays / row.lateCount : 0;
  const stale = isStale(row.lastUpdatedAt ?? null);

  const badge: TrustBadge = stale
    ? "unknown"
    : row.totalCount < MIN_DATA_POINTS
      ? "unknown"
      : onTimeRate >= TRUST_RELIABLE_THRESHOLD
        ? "reliable"
        : onTimeRate >= TRUST_MOSTLY_RELIABLE_THRESHOLD
          ? "mostly_reliable"
          : "unreliable";

  return {
    contactEmail: row.contactEmail,
    displayName: row.displayName,
    totalCount: row.totalCount,
    onTimeCount: row.onTimeCount,
    lateCount: row.lateCount,
    onTimeRate,
    avgDelayDays,
    badge,
    label: formatLabel(badge, onTimeRate, avgDelayDays, row.totalCount),
  };
}

function formatLabel(
  badge: TrustBadge,
  onTimeRate: number,
  avgDelayDays: number,
  totalCount: number,
): string {
  if (badge === "unknown") {
    return `${totalCount} commitment${totalCount !== 1 ? "s" : ""} tracked — more data needed`;
  }
  const pct = Math.round(onTimeRate * 100);
  if (badge === "reliable") {
    return `${pct}% on-time across ${totalCount} commitments`;
  }
  if (badge === "mostly_reliable") {
    const delay = avgDelayDays > 0.5 ? `, avg +${Math.round(avgDelayDays)}d late` : "";
    return `${pct}% on-time${delay}`;
  }
  const delay = avgDelayDays > 0.5 ? ` — avg ${Math.round(avgDelayDays)}d late` : "";
  return `${pct}% on-time${delay} — pattern of delays`;
}
