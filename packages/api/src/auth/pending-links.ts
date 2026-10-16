import crypto from "node:crypto";

/**
 * Parked OAuth authorization codes of account-link flows.
 *
 * An OAuth state carries only the user id that started a flow, so it does not
 * prove that the browser finishing it belongs to that user: an attacker can
 * start a link, send the consent URL to a victim, and receive the victim's
 * grant. The link callbacks therefore do not exchange the code. They park it
 * here under a random handle and hand the handle to the client, which redeems
 * it with its own session (POST /api/auth/link/complete). A code whose flow is
 * never completed by the right session is never exchanged, so no refresh
 * token is ever minted for it.
 *
 * In memory, like auth/exchange-codes.ts and desktopLoginTokens: one API
 * instance. A restart loses parked links, which the client sees as "expired,
 * start again".
 */

/** How long a parked code waits for its session. Normal completion takes seconds. */
export const PENDING_LINK_TTL_MS = 5 * 60 * 1000;

/** Store ceiling: past it a new park is refused, never an unbounded map. */
export const MAX_PENDING_LINKS = 500;

/**
 * Parks one user may hold at once; a new one evicts that user's oldest. A
 * state stays valid for 10 minutes and the callback parks whatever `code` it
 * is given, so without this one account replaying its own state could fill
 * the store and refuse every other user's link. A real user has one flow in
 * flight, plus a retry or two.
 */
export const MAX_PENDING_LINKS_PER_USER = 3;

const HANDLE_BYTES = 32;
const HANDLE_PATTERN = /^[0-9a-f]{64}$/;

/** The state markers of every account-link flow that parks its code. */
export const LINK_MARKERS = [
  "__oauth_state__",
  "__link_calendar__",
  "__link_inbox__",
  "__link_outlook__",
  "__link_outlook_calendar__",
] as const;

export type LinkMarker = (typeof LINK_MARKERS)[number];

export interface PendingLink {
  readonly userId: string;
  readonly marker: LinkMarker;
  readonly code: string;
  /** An allowlisted native scheme the flow was started with, if any. */
  readonly appScheme?: string;
  readonly expiresAt: number;
}

/**
 * How a finished link answers the completing client: the relative web path the
 * old callback redirected to, or the status and error it answered with.
 */
export type LinkFinish = { next: string } | { status: number; error: string };

// Keyed by SHA-256 of the handle, so the store never holds a redeemable value.
const pending = new Map<string, PendingLink>();

function keyOf(handle: string): string {
  return crypto.createHash("sha256").update(handle).digest("hex");
}

/** Drop the user's oldest parks until a new one fits under the per-user bound. */
function evictOldestOf(userId: string): void {
  const mine = [...pending.entries()]
    .filter(([, entry]) => entry.userId === userId)
    .sort(([, a], [, b]) => a.expiresAt - b.expiresAt);
  for (const [key] of mine.slice(0, Math.max(0, mine.length - MAX_PENDING_LINKS_PER_USER + 1))) {
    pending.delete(key);
  }
}

/**
 * Park a link and return its single-use handle (64 hex characters), or null
 * when the store is full. The caller must surface a null as a visible error.
 */
export function parkPendingLink(link: Omit<PendingLink, "expiresAt">): string | null {
  evictOldestOf(link.userId);
  if (pending.size >= MAX_PENDING_LINKS) return null;
  const handle = crypto.randomBytes(HANDLE_BYTES).toString("hex");
  const key = keyOf(handle);
  const entry: PendingLink = { ...link, expiresAt: Date.now() + PENDING_LINK_TTL_MS };
  pending.set(key, entry);
  const timer = setTimeout(() => {
    if (pending.get(key) === entry) pending.delete(key);
  }, PENDING_LINK_TTL_MS);
  timer.unref?.();
  return handle;
}

/**
 * Remove and return the link parked under `handle`. Null for anything unknown,
 * malformed, already taken or expired. Deleting on read makes every handle
 * single use, whoever presents it.
 */
export function takePendingLink(handle: unknown): PendingLink | null {
  if (typeof handle !== "string" || !HANDLE_PATTERN.test(handle)) return null;
  const key = keyOf(handle);
  const entry = pending.get(key);
  if (!entry) return null;
  pending.delete(key);
  return entry.expiresAt > Date.now() ? entry : null;
}

export function pendingLinkCount(): number {
  return pending.size;
}

export function _pendingLinkKeysForTests(): string[] {
  return [...pending.keys()];
}

export function _resetPendingLinksForTests(): void {
  pending.clear();
}
