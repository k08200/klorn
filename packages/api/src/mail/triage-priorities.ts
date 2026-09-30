/**
 * Triage priorities (2026-09-11): the user's own words about what matters —
 * "investor mail is always urgent", "newsletters can wait", "anything from
 * 김대표 goes straight to me". Outlook's Prioritize My Inbox and Superhuman's
 * Personalization sell exactly this; Klorn had only a reply-side guideline
 * and no user text in the classification prompts at all.
 *
 * One field per USER (priorities are a person's, not a mailbox's), capped
 * and whitespace-collapsed here so the prompts stay one paragraph. It
 * reaches two prompts: the lane judge (poc-judge.ts, feature scores) and
 * the summarize pass (email-summarize.ts, category / priority). Both stay
 * byte-identical when the field is empty — the eval baseline is untouched.
 */

import { prisma } from "../db.js";

export const TRIAGE_PRIORITIES_MAX = 500;

/**
 * The PATCH body → the stored text (null clears). Collapses runs of
 * whitespace (a multi-line note becomes one line), strips control
 * characters, and refuses text beyond the cap instead of truncating —
 * a silently cut sentence is a rule the user thinks exists and doesn't.
 */
export function normalizeTriagePriorities(
  input: unknown,
): { text: string | null } | { error: string } {
  if (input === null || input === undefined) return { text: null };
  if (typeof input !== "string") return { error: "text must be a string" };
  // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate reject filter
  const cleaned = input.replace(/[\u0000-\u001f\u007f]/g, "");
  const text = cleaned.replace(/\s+/g, " ").trim();
  if (!text) return { text: null };
  if (text.length > TRIAGE_PRIORITIES_MAX) {
    return { error: `text must be at most ${TRIAGE_PRIORITIES_MAX} characters` };
  }
  return { text };
}

/**
 * The sentence appended to the summarize preamble. The user's words are
 * quoted as THEIR statement — a preference the analysis follows, not a
 * system instruction — and stay within the quotes.
 */
export function prioritiesPreambleSentence(text: string | null | undefined): string {
  if (!text) return "";
  return ` The user has stated what matters to them (their own words, authoritative for priority and urgency): "${escapeQuotes(text)}".`;
}

/**
 * The block for the lane judge's user prompt, placed BEFORE the untrusted
 * email section so it reads as the recipient's standing instruction. Only
 * the four scores may move — the JSON shape must not.
 */
export function prioritiesJudgeBlock(text: string | null | undefined): string {
  if (!text) return "";
  return `\n\nThe recipient's own priorities (their words — weigh urgency and senderTrust by them, keep the JSON shape): "${escapeQuotes(text)}"`;
}

function escapeQuotes(text: string): string {
  return text.replace(/"/g, "'");
}

// One read per user per minute, not one per email: the judge builds its
// context per email and a 200-mail backfill must not turn into 200 lookups
// of the same row. Invalidated on write so a saved change lands on the
// very next judgement.
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { text: string | null; expiresAt: number }>();

export async function fetchTriagePriorities(userId: string): Promise<string | null> {
  const hit = cache.get(userId);
  const now = Date.now();
  if (hit && hit.expiresAt > now) return hit.text;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { triagePriorities: true },
  });
  const text = user?.triagePriorities ?? null;
  cache.set(userId, { text, expiresAt: now + CACHE_TTL_MS });
  return text;
}

export function invalidateTriagePriorities(userId: string): void {
  cache.delete(userId);
}

/** Test seam — the cache is module state. */
export function resetTriagePrioritiesCacheForTests(): void {
  cache.clear();
}
