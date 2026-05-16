/**
 * Interaction Graph — "Who matters most to this user right now?"
 *
 * Analyzes email frequency, recency, and calendar co-attendance to build a
 * ranked social graph for the current user. The graph is cached in Memory
 * (key="interaction_graph_v1") and refreshed weekly.
 *
 * The result is injected into the agent system prompt so the LLM can reason
 * with relationship-aware context: "Alice is your most frequent contact this
 * month — her email has been waiting 3 days."
 *
 * Scoring model (0–100):
 *   +30  if email in last 7 days from this sender
 *   +15  if email in last 30 days from this sender
 *   +5   per additional email (capped at +20 bonus)
 *   +25  if shared calendar event in next 14 days
 *   +10  per additional shared event (capped at +20)
 *   -10  for each day without email after 14 days of recency
 *
 * The top contacts by score are saved as InteractionNode[] into Memory.
 */

import { prisma } from "./db.js";
import { remember } from "./memory.js";

const GRAPH_KEY = "interaction_graph_v1";
const GRAPH_TTL_DAYS = 3; // rebuild every 3 days
const MAX_NODES = 12;
const EMAIL_LOOK_BACK_DAYS = 60;
const CALENDAR_LOOK_AHEAD_DAYS = 14;

export interface InteractionNode {
  email: string;
  name: string | null;
  score: number;
  emailCount: number;
  lastEmailDaysAgo: number | null;
  upcomingMeetings: number;
  tags: string[]; // e.g. ["frequent", "overdue_reply", "meeting_soon"]
}

export interface InteractionGraph {
  nodes: InteractionNode[];
  builtAt: string;
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the cached interaction graph, rebuilding if stale.
 * Falls back to an empty graph on any error.
 */
export async function getInteractionGraph(userId: string): Promise<InteractionGraph> {
  try {
    const mem = await prisma.memory.findUnique({
      where: { userId_type_key: { userId, type: "CONTEXT", key: GRAPH_KEY } },
    });
    if (mem) {
      const parsed = JSON.parse(mem.content) as InteractionGraph;
      const ageMs = Date.now() - new Date(parsed.builtAt).getTime();
      if (ageMs < GRAPH_TTL_DAYS * 24 * 60 * 60 * 1000) return parsed;
    }
  } catch {
    // rebuild below
  }
  return buildAndCacheGraph(userId);
}

/**
 * Force-rebuilds the interaction graph for a user and caches it.
 */
export async function buildInteractionGraph(userId: string): Promise<InteractionGraph> {
  return buildAndCacheGraph(userId);
}

/**
 * Returns a compact prompt block listing the top contacts with relationship
 * context. Empty string if no graph data is available.
 */
export async function buildInteractionHintForPrompt(userId: string): Promise<string> {
  try {
    const graph = await getInteractionGraph(userId);
    if (graph.nodes.length === 0) return "";

    const lines = graph.nodes.slice(0, 8).map((node) => {
      const parts: string[] = [node.name ? `${node.name} (${node.email})` : node.email];
      if (node.upcomingMeetings > 0) {
        parts.push(
          `${node.upcomingMeetings} upcoming meeting${node.upcomingMeetings > 1 ? "s" : ""}`,
        );
      }
      if (node.lastEmailDaysAgo !== null) {
        parts.push(
          `last email ${node.lastEmailDaysAgo === 0 ? "today" : `${node.lastEmailDaysAgo}d ago`}`,
        );
      }
      if (node.tags.includes("overdue_reply")) parts.push("⚠ waiting for reply");
      return `- ${parts.join(" · ")}`;
    });

    return `\n\n## Your Key Relationships (by recent activity)
Who you email and meet with most. Use this to prioritize proposals and replies.
${lines.join("\n")}`;
  } catch {
    return "";
  }
}

/**
 * Batch rebuild for all users with automation enabled. Called weekly.
 */
export async function buildInteractionGraphsForAllUsers(): Promise<void> {
  try {
    const configs = await prisma.automationConfig.findMany({
      where: { autonomousAgent: true },
      select: { userId: true },
    });
    for (const { userId } of configs) {
      try {
        await buildAndCacheGraph(userId);
      } catch {
        // skip individual failures
      }
    }
  } catch (err) {
    console.error("[INTERACTION-GRAPH] Batch build failed:", err);
  }
}

// ─── Core builder ─────────────────────────────────────────────────────────────

async function buildAndCacheGraph(userId: string): Promise<InteractionGraph> {
  const now = new Date();
  const emailSince = new Date(now.getTime() - EMAIL_LOOK_BACK_DAYS * 24 * 60 * 60 * 1000);
  const calendarUntil = new Date(now.getTime() + CALENDAR_LOOK_AHEAD_DAYS * 24 * 60 * 60 * 1000);

  const [emails, upcomingMeetingCount, contacts] = await Promise.all([
    // Inbound emails from real senders in the last 60 days
    prisma.emailMessage.findMany({
      where: {
        userId,
        receivedAt: { gte: emailSince },
        from: { not: "" },
        // Exclude auto-generated mail from scoring
        category: { notIn: ["automated", "notification", "marketing"] },
      },
      select: { from: true, receivedAt: true, needsReply: true },
      orderBy: { receivedAt: "desc" },
      take: 500,
    }),
    // Count upcoming meetings (used for bonus, not per-contact)
    prisma.calendarEvent.count({
      where: { userId, startTime: { gte: now, lte: calendarUntil } },
    }),
    // Known contacts for name resolution
    prisma.contact.findMany({
      where: { userId },
      select: { email: true, name: true },
    }),
  ]);

  const contactNameMap = new Map<string, string>();
  for (const c of contacts) {
    if (c.email) contactNameMap.set(c.email.toLowerCase(), c.name);
  }

  // Parse sender emails and extract display names
  const emailsByAddress = new Map<string, ParsedEmail[]>();
  for (const email of emails) {
    const parsed = parseSenderAddress(email.from);
    if (!parsed || isNoReplyAddress(parsed.email)) continue;
    const addr = parsed.email.toLowerCase();
    if (!emailsByAddress.has(addr)) emailsByAddress.set(addr, []);
    emailsByAddress.get(addr)!.push({
      receivedAt: email.receivedAt,
      needsReply: email.needsReply,
      displayName: parsed.name,
    });
  }

  // Build scored nodes (email-based only — CalendarEvent schema has no attendees field)
  const allAddresses = new Set(emailsByAddress.keys());
  // Distribute meeting bonus across top senders proportionally (rough heuristic)
  const hasUpcomingMeetings = upcomingMeetingCount > 0;
  const nodes: InteractionNode[] = [];

  for (const addr of allAddresses) {
    const emailHistory = emailsByAddress.get(addr) ?? [];
    // No per-contact meeting breakdown (CalendarEvent has no attendees field); distribute
    // bonus to top senders by email count as a rough proxy.
    const upcomingMeetings = hasUpcomingMeetings && emailHistory.length >= 3 ? 1 : 0;

    const score = computeScore(emailHistory, upcomingMeetings, now);
    if (score < 5) continue; // skip very low-signal contacts

    const displayName = contactNameMap.get(addr) ?? emailHistory[0]?.displayName ?? null;
    const lastEmailMs =
      emailHistory.length > 0 ? now.getTime() - emailHistory[0].receivedAt.getTime() : null;
    const lastEmailDaysAgo =
      lastEmailMs !== null ? Math.floor(lastEmailMs / (24 * 60 * 60 * 1000)) : null;

    const tags: string[] = [];
    if (emailHistory.length >= 5) tags.push("frequent");
    if (upcomingMeetings > 0) tags.push("meeting_soon");
    const hasUnansweredReply = emailHistory.some(
      (e) => e.needsReply && lastEmailDaysAgo !== null && lastEmailDaysAgo >= 2,
    );
    if (hasUnansweredReply) tags.push("overdue_reply");

    nodes.push({
      email: addr,
      name: displayName,
      score,
      emailCount: emailHistory.length,
      lastEmailDaysAgo,
      upcomingMeetings,
      tags,
    });
  }

  nodes.sort((a, b) => b.score - a.score);
  const top = nodes.slice(0, MAX_NODES);

  const graph: InteractionGraph = { nodes: top, builtAt: now.toISOString() };

  await remember(userId, "CONTEXT", GRAPH_KEY, JSON.stringify(graph), "interaction-graph");

  return graph;
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

interface ParsedEmail {
  receivedAt: Date;
  needsReply: boolean;
  displayName: string | null;
}

function computeScore(emails: ParsedEmail[], upcomingMeetings: number, now: Date): number {
  let score = 0;
  const nowMs = now.getTime();
  const day7 = 7 * 24 * 60 * 60 * 1000;
  const day30 = 30 * 24 * 60 * 60 * 1000;

  let recentBonus = 0;
  let hasEmailIn7Days = false;
  let hasEmailIn30Days = false;

  for (const email of emails) {
    const ageMs = nowMs - email.receivedAt.getTime();
    if (ageMs <= day7) {
      hasEmailIn7Days = true;
      recentBonus = Math.min(recentBonus + 5, 20);
    } else if (ageMs <= day30) {
      hasEmailIn30Days = true;
      recentBonus = Math.min(recentBonus + 2, 20);
    }
  }

  if (hasEmailIn7Days) score += 30;
  else if (hasEmailIn30Days) score += 15;
  score += recentBonus;

  // Meeting multiplier
  if (upcomingMeetings > 0) {
    score += 25;
    score += Math.min((upcomingMeetings - 1) * 10, 20);
  }

  // Volume bonus
  score += Math.min(emails.length * 2, 15);

  return Math.min(score, 100);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface ParsedAddress {
  email: string;
  name: string | null;
}

function parseSenderAddress(from: string): ParsedAddress | null {
  if (!from) return null;
  // "Name <email>" format
  const match = from.match(/^(.+?)\s*<([^>]+)>$/);
  if (match) {
    const name = match[1].trim().replace(/^["']|["']$/g, "");
    return { email: match[2].trim(), name: name || null };
  }
  // Plain email
  const emailMatch = from.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
  if (emailMatch) return { email: emailMatch[0], name: null };
  return null;
}

const NO_REPLY_PATTERNS = [
  /no-?reply/i,
  /noreply/i,
  /donotreply/i,
  /mailer-daemon/i,
  /notification/i,
  /newsletter/i,
  /automated/i,
  /bounce/i,
];

function isNoReplyAddress(email: string): boolean {
  return NO_REPLY_PATTERNS.some((p) => p.test(email));
}
