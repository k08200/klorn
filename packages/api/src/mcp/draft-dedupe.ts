/**
 * The short memory behind create_draft's retry guard (step A4 of
 * docs/providers/unified-platform-plan.md): the same draft (same user, same email,
 * same body, same subject) asked for again inside the window is the first draft,
 * not a second one. An agent that retries after a slow or dropped response would
 * otherwise leave a pile of identical drafts in the user's mailbox.
 *
 * In-process, so per instance: with N instances behind the load balancer a retry
 * that lands elsewhere can still create a second draft. That is the same trade-off
 * as the write cap (mcp/write-call.ts), and the failure is a duplicate, never a
 * wrong draft. Nothing here is persisted and nothing holds mail content: the key is
 * a SHA-256 digest and the value is the provider's own draft id, provider name and
 * the recipient address the first call returned.
 *
 * Bounded twice: entries older than the window are swept on every insert, and the
 * map never holds more than MAX_REMEMBERED_DRAFTS (the oldest goes first).
 */

import { sha256Hex } from "./write-audit.js";

/** How long a created draft answers an identical request. Proposed value, no measurement behind it. */
export const DRAFT_DEDUPE_WINDOW_MS = 10 * 60_000;
/** Hard ceiling on remembered drafts. Inserts are capped per user, so this is a backstop. */
export const MAX_REMEMBERED_DRAFTS = 2000;

/** What the first call answered, enough to answer the retry identically. */
export interface RememberedDraft {
  draftId: string;
  provider: string;
  to: string;
}

interface Entry {
  draft: RememberedDraft;
  at: number;
}

export interface DraftKeyParts {
  userId: string;
  /** The email row's provider id, so the Klorn id and the provider id name the same draft. */
  emailKey: string;
  /** SHA-256 hex of the body. */
  bodyHash: string;
  /** The subject the draft carries. */
  subject: string;
}

const recent = new Map<string, Entry>();

/** A fixed-size digest of the draft's identity. JSON-encoded parts, so no part can bleed into another. */
export function draftKey({ userId, emailKey, bodyHash, subject }: DraftKeyParts): string {
  return sha256Hex(JSON.stringify([userId, emailKey, bodyHash, subject]));
}

const isFresh = (entry: Entry, now: number): boolean => now - entry.at < DRAFT_DEDUPE_WINDOW_MS;

/** Drafts currently held (observability and the bound tests). */
export function recentDraftCount(): number {
  return recent.size;
}

/** The draft an identical request created inside the window, or null. */
export function findRecentDraft(key: string, now: number = Date.now()): RememberedDraft | null {
  const entry = recent.get(key);
  return entry && isFresh(entry, now) ? entry.draft : null;
}

function sweepExpired(now: number): void {
  for (const [key, entry] of recent) {
    if (!isFresh(entry, now)) recent.delete(key);
  }
}

function evictOldestBeyondLimit(): void {
  while (recent.size >= MAX_REMEMBERED_DRAFTS) {
    const oldest = recent.keys().next();
    if (oldest.done) return;
    recent.delete(oldest.value);
  }
}

/** Remember a created draft. A key that is still fresh keeps its FIRST draft. */
export function rememberDraft(key: string, draft: RememberedDraft, now: number = Date.now()): void {
  sweepExpired(now);
  if (recent.has(key)) return;
  evictOldestBeyondLimit();
  recent.set(key, { draft, at: now });
}
