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
import { captureError } from "./sentry.js";

const GRAPH_KEY = "interaction_graph_v1";
const GRAPH_TTL_DAYS = 3; // rebuild every 3 days
const MAX_NODES = 12;
const EMAIL_LOOK_BACK_DAYS = 60;
const CALENDAR_LOOK_AHEAD_DAYS = 14;
// A handful of real outbound engagements saturates learnedImportance to 1.
const ENGAGEMENT_SATURATION = 4;
// How much a directly-engaged contact lifts a *quiet peer* at the same org.
// Propagated importance is deliberately much softer than measured engagement —
// it's a cold-start prior, never a decision.
const PROPAGATION_DISCOUNT = 0.4;
// A domain must have at least this many DISTINCT engaged contacts before its
// importance propagates. One reply to one person (who may have a vanity domain,
// or be a social-engineering pretext) must never lift trust for every stranger
// at that domain — propagation is meant to model working with an *organization*.
const PROPAGATION_MIN_ENGAGED = 2;

/**
 * Consumer mail providers where a shared domain means nothing — millions of
 * strangers share "gmail.com". Propagation is skipped for these so a single
 * engaged gmail contact can't lift trust for the entire internet. Only true
 * organizational domains propagate. Lowercase, exact-match on the domain.
 */
const PUBLIC_EMAIL_DOMAINS = new Set<string>([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "hotmail.co.uk",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "yahoo.co.jp",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "gmx.de",
  "web.de",
  "mail.com",
  "zoho.com",
  "fastmail.com",
  "yandex.com",
  "yandex.ru",
  "mail.ru",
  "qq.com",
  "163.com",
  "126.com",
  "139.com",
  "sina.com",
  "sohu.com",
  "rediffmail.com",
  "naver.com",
  "daum.net",
  "hanmail.net",
  "nate.com",
  "kakao.com",
]);

/**
 * Organizational domain of an address, or null when it's a public mail provider
 * (or unparseable). Only org domains are eligible for importance propagation.
 */
function orgDomainOf(addr: string): string | null {
  const at = addr.lastIndexOf("@");
  if (at < 0) return null;
  const domain = addr
    .slice(at + 1)
    .trim()
    .toLowerCase();
  if (!domain.includes(".") || PUBLIC_EMAIL_DOMAINS.has(domain)) return null;
  return domain;
}

/** Round to 2 decimals — keeps stored propagated priors compact and stable. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Case-insensitive node/address match that tolerates a malformed cache row
 * (non-string email) instead of throwing — a corrupt cache must fail soft on
 * the classification hot path, never wipe the whole judge-context fan-out.
 */
export function nodeMatchesEmail(node: InteractionNode, lowerAddress: string): boolean {
  return typeof node.email === "string" && node.email.toLowerCase() === lowerAddress;
}

export interface InteractionNode {
  email: string;
  name: string | null;
  score: number;
  emailCount: number;
  lastEmailDaysAgo: number | null;
  upcomingMeetings: number;
  tags: string[]; // e.g. ["frequent", "overdue_reply", "meeting_soon"]
  // Learned engagement from real user actions (outbound reply/send +, dismiss −),
  // normalized 0..1. The measured "you actually engage with this person" signal —
  // consumed (flag-gated) as soft grounding for the judge's senderTrust score.
  learnedImportance?: number;
  outboundCount?: number; // raw outbound engagements (for interpretable grounding text)
  dismissCount?: number; // raw dismisses (the negative signal — user keeps clearing this sender)
  // Propagated (inferred) importance for a quiet contact at an org the user
  // actively engages with — a soft cold-start prior, NOT a measured signal.
  // Only set when the contact has no direct engagement of their own.
  propagatedImportance?: number;
}

export interface InteractionGraph {
  nodes: InteractionNode[];
  builtAt: string;
  // org domain → max direct learnedImportance among engaged contacts there.
  // Lets the judge give a cold-start sender (not yet a node) a soft prior when
  // the user demonstrably engages with their organization. Gated at consumption.
  orgImportance?: Record<string, number>;
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
  } catch (err) {
    console.warn("[INTERACTION-GRAPH] stale-check read failed (rebuilding):", err);
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
 * Cache-only read of the whole graph, freshness-guarded — NEVER rebuilds (safe
 * on the classification hot path, which calls it per email; a sync burst would
 * otherwise fan out N simultaneous mailbox scans). The weekly batch + agent
 * paths keep the cache warm. null when the cache is missing, stale, or
 * unparsable. Callers that only need one sender should use
 * getCachedInteractionNode.
 */
export async function getCachedInteractionGraph(userId: string): Promise<InteractionGraph | null> {
  try {
    const mem = await prisma.memory.findUnique({
      where: { userId_type_key: { userId, type: "CONTEXT", key: GRAPH_KEY } },
    });
    if (!mem) return null;
    const parsed = JSON.parse(mem.content) as InteractionGraph;
    const ageMs = Date.now() - new Date(parsed.builtAt).getTime();
    if (!(ageMs < GRAPH_TTL_DAYS * 24 * 60 * 60 * 1000)) return null;
    // Guard against a legacy/partial cache shape — downstream .find calls index
    // node.email, so a non-array nodes field must fail soft here, not throw on
    // the classification hot path.
    if (!Array.isArray(parsed.nodes)) return null;
    return parsed;
  } catch (err) {
    // console + captureError: captureError alone is silent when Sentry is off.
    console.warn("[INTERACTION-GRAPH] getCachedInteractionGraph failed:", err);
    captureError(err, { tags: { scope: "interaction-graph-cache-read" } });
    return null;
  }
}

/**
 * Cache-only lookup of one contact's node. Absence means "not a top contact",
 * NOT "stranger" — the graph only keeps the top MAX_NODES + engaged contacts.
 */
export async function getCachedInteractionNode(
  userId: string,
  email: string,
): Promise<InteractionNode | null> {
  const address = email.toLowerCase().trim();
  if (!address) return null;
  const graph = await getCachedInteractionGraph(userId);
  if (!graph) return null;
  return graph.nodes.find((n) => nodeMatchesEmail(n, address)) ?? null;
}

/**
 * Cold-start propagated prior for a sender who isn't a graph node yet: the max
 * measured engagement at their organization, discounted. Returns 0 when the
 * sender's domain is public or has no engaged peer. Cache-only (judge-safe).
 */
export function propagatedImportanceForDomain(
  graph: InteractionGraph | null,
  senderAddress: string,
): number {
  if (!graph?.orgImportance) return 0;
  const org = orgDomainOf(senderAddress);
  if (!org) return 0;
  const orgMax = graph.orgImportance[org];
  return orgMax ? round2(orgMax * PROPAGATION_DISCOUNT) : 0;
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
  } catch (err) {
    console.warn("[INTERACTION-GRAPH] buildInteractionHintForPrompt failed:", err);
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
      } catch (err) {
        console.warn("[INTERACTION-GRAPH] per-user build failed for", userId, err);
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

  const [emails, upcomingMeetingCount, contacts, engagement] = await Promise.all([
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
    // Learned engagement counters per contact (the measured action signal)
    prisma.contactEngagementScore.findMany({
      where: { userId },
      select: { contactEmail: true, outboundCount: true, dismissCount: true },
    }),
  ]);

  const contactNameMap = new Map<string, string>();
  for (const c of contacts) {
    if (c.email) contactNameMap.set(c.email.toLowerCase(), c.name);
  }

  // addr → learned engagement (outbound reply/send +, dismiss −)
  const engagementByAddr = new Map<string, { outboundCount: number; dismissCount: number }>();
  for (const e of engagement) {
    engagementByAddr.set(e.contactEmail.toLowerCase(), {
      outboundCount: e.outboundCount,
      dismissCount: e.dismissCount,
    });
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
    const eng = engagementByAddr.get(addr);
    // Keep a meaningful inbound sender OR anyone the user actually engages with —
    // a few real replies shouldn't be dropped just for low inbound volume.
    if (score < 5 && !eng) continue;

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

    // Outbound engagement lifts importance; dismisses (half-weight) pull it down.
    const learnedImportance = eng
      ? Math.max(
          0,
          Math.min(1, (eng.outboundCount - eng.dismissCount * 0.5) / ENGAGEMENT_SATURATION),
        )
      : undefined;
    if (eng && eng.outboundCount > 0) tags.push("you_engage");

    nodes.push({
      email: addr,
      name: displayName,
      score,
      emailCount: emailHistory.length,
      lastEmailDaysAgo,
      upcomingMeetings,
      tags,
      learnedImportance,
      outboundCount: eng?.outboundCount,
      dismissCount: eng?.dismissCount,
    });
  }

  // ── Learned-importance propagation (VIP cluster hops) ──────────────────────
  // A contact the user actively engages with makes their *organization* matter:
  // org domain → strongest measured engagement there. Computed over ALL engaged
  // nodes (not just the cached top) so the map is complete. Public providers are
  // excluded by orgDomainOf — sharing "gmail.com" is not a relationship. Only
  // domains with ≥PROPAGATION_MIN_ENGAGED distinct engaged contacts qualify, so a
  // single reply can't inflate trust for a whole domain (a spoofing / farming
  // guard — a domain propagates only once the user works with an *org*, not one
  // person). Positive engagement only: a dismiss-only contact (importance 0) is
  // not a relationship and must not tag peers as engaged.
  const orgEngaged = new Map<string, { max: number; contacts: Set<string> }>();
  for (const n of nodes) {
    if (!n.learnedImportance) continue; // measured, positive engagement only (0/undefined out)
    const org = orgDomainOf(n.email);
    if (!org) continue;
    const e = orgEngaged.get(org) ?? { max: 0, contacts: new Set<string>() };
    e.max = Math.max(e.max, n.learnedImportance);
    e.contacts.add(n.email);
    orgEngaged.set(org, e);
  }
  const orgImportance = new Map<string, number>();
  for (const [org, e] of orgEngaged) {
    if (e.contacts.size >= PROPAGATION_MIN_ENGAGED) orgImportance.set(org, e.max);
  }

  nodes.sort((a, b) => b.score - a.score);
  const top = nodes.slice(0, MAX_NODES);
  // Measured engagement must always reach the judge — never let a contact the
  // user actively replies to (but who rarely emails them, so low score) get
  // pruned by the top-N score cut. Append any engaged stragglers.
  for (const n of nodes) {
    if (n.learnedImportance !== undefined && !top.includes(n)) top.push(n);
  }

  // Give quiet in-graph peers at an engaged org a soft propagated prior (for the
  // graph visual + judge grounding). Direct engagement always wins over this.
  for (const n of top) {
    if (n.learnedImportance !== undefined) continue;
    const org = orgDomainOf(n.email);
    const orgMax = org ? orgImportance.get(org) : undefined;
    if (!orgMax) continue; // 0 or undefined → no real org signal, don't tag
    n.propagatedImportance = round2(orgMax * PROPAGATION_DISCOUNT);
    n.tags.push("org_engaged");
  }

  const graph: InteractionGraph = {
    nodes: top,
    builtAt: now.toISOString(),
    orgImportance: Object.fromEntries(orgImportance),
  };

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
