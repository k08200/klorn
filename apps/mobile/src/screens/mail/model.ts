/**
 * Mail's view model, pure: day sections, sender names and monograms, which
 * connected account (inbox) a row came from, reply addressing, the send
 * receipt hash, and the Subscriptions read rates. No React, no DOM.
 */
import type { EmailListItem, FirewallResponse, InboxOption, LiveTier } from "@klorn/contract";
import { isApiError, isEntitlementRefusal } from "../../api/client";
import type { EmailSubscriptionWire } from "../../api/wire";
import type { MessageKey } from "../../i18n";
import { senderLabel } from "./lane-sheet-model";

export { senderLabel };

// ── Day sections ────────────────────────────────────────────────────────────

export interface DaySection<T> {
  /** "today" | "yesterday" | an ISO day "2026-10-14". */
  key: string;
  rows: T[];
}

function localDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Newest-first rows → sections by the device's calendar day, order kept. */
export function groupByDay<T extends { date: string }>(
  rows: readonly T[],
  now: Date,
): DaySection<T>[] {
  const today = localDayKey(now);
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  const yesterday = localDayKey(y);
  const sections: DaySection<T>[] = [];
  for (const row of rows) {
    const day = localDayKey(new Date(row.date));
    const key = day === today ? "today" : day === yesterday ? "yesterday" : day;
    const last = sections[sections.length - 1];
    if (last && last.key === key) last.rows.push(row);
    else sections.push({ key, rows: [row] });
  }
  return sections;
}

/** The row's time: a clock today, the weekday this week, else a short date. */
export function rowTimeKind(date: Date, now: Date): "clock" | "weekday" | "date" {
  if (localDayKey(date) === localDayKey(now)) return "clock";
  const days = (now.getTime() - date.getTime()) / 86_400_000;
  return days < 6 ? "weekday" : "date";
}

// ── Senders ─────────────────────────────────────────────────────────────────

/** First letter (grapheme) of a name, upper-cased for Latin. */
export function monogram(name: string): string {
  const clean = name.replace(/^[\s"'(<[]+/, "").trim();
  const first = Array.from(clean)[0] ?? "?";
  return first.toLocaleUpperCase();
}

/** "박서연 · 한빛파트너스" → { name: "박서연", org: "한빛파트너스" } (the artboard's sender row). */
export function splitSender(label: string): { name: string; org: string | null } {
  const parts = label.split(" · ");
  if (parts.length >= 2 && parts[0]) return { name: parts[0], org: parts.slice(1).join(" · ") };
  return { name: label, org: null };
}

/** One of the five artboard avatar tints, stable per sender. */
export function avatarTone(key: string): 0 | 1 | 2 | 3 | 4 {
  let h = 0;
  for (const ch of key) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return (h % 5) as 0 | 1 | 2 | 3 | 4;
}

/** The bare address inside a From header ("Name <a@b>" → "a@b"). */
export function addressOf(from: string): string {
  const m = /<([^>]+)>/.exec(from);
  return (m?.[1] ?? from).trim();
}

/** Same rule as the server's /reply route: "Re: " unless already a reply. */
export function replySubject(subject: string): string {
  return subject.startsWith("Re:") ? subject : `Re: ${subject}`;
}

// ── Accounts ("inboxes") ────────────────────────────────────────────────────

/** The connected account a row came from: null id = the primary account. */
export function accountOf(
  linkedInboxAccountId: string | null | undefined,
  inboxes: readonly InboxOption[],
): InboxOption | null {
  const id = linkedInboxAccountId ?? null;
  return inboxes.find((inbox) => inbox.id === id) ?? null;
}

/**
 * The accounts a NEW mail can leave from (POST /api/email/send
 * `linkedInboxAccountId`): connected and not waiting for a reconnect, primary
 * first. Generic IMAP has no SMTP endpoint on the server, so it never sends;
 * Naver / iCloud send only while the server's IMAP send is on — the route then
 * answers 501 and the confirm sheet asks for another account. A reply always
 * leaves from the mail's own account (the server reads it from the row).
 */
export function sendableAccounts(inboxes: readonly InboxOption[]): InboxOption[] {
  return inboxes
    .filter((inbox) => !inbox.needsReconnect && inbox.provider !== "IMAP")
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "primary" ? -1 : 1));
}

/** The send body's `linkedInboxAccountId`: null = the primary inbox. */
export function sendAccountId(from: InboxOption | null): string | null {
  return from && from.kind === "linked" ? from.id : null;
}

/**
 * The message for a refused or failed write. Only the plan gate (403
 * ENTITLEMENT_REQUIRED) says "needs Pro" — the one message that carries the
 * See-plans link (`PRO_REFUSAL_KEY`); every other 403 is a plain failure.
 */
export const PRO_REFUSAL_KEY = "reader.draft.notEntitled" satisfies MessageKey;

export function draftErrorKey(err: unknown): MessageKey {
  if (isApiError(err) && err.isOffline) return "reader.draft.offline";
  if (isApiError(err) && err.status === 429) return "reader.draft.rateLimited";
  if (isEntitlementRefusal(err)) return PRO_REFUSAL_KEY;
  return "reader.draft.unavailable";
}

/**
 * The server says this account may not send (the paywall is on and the plan is
 * FREE). Nobody should be handed an editor for a mail that would only be
 * refused on send. Absent (an older server, the paywall off) or still loading
 * means "not blocked"; the 403 on send stays the backstop.
 */
export function mailWriteBlocked(user: { entitled?: boolean } | null | undefined): boolean {
  return user?.entitled === false;
}

/** What the confirm sheet says when a send did not complete; `unknown` forbids a blind retry. */
export function sendFailure(
  err: unknown,
  mail: { kind: "reply" | "new"; accountId: string | null },
): { unknown: boolean; message: MessageKey } {
  const status = isApiError(err) ? err.status : null;
  // 502 = the provider could not say whether it went out.
  if (status === 502) return { unknown: true, message: "reader.send.unknown" };
  const message: MessageKey =
    isApiError(err) && err.isOffline
      ? "reader.send.offline"
      : isEntitlementRefusal(err)
        ? PRO_REFUSAL_KEY
        : status === 501 && mail.kind === "new"
          ? "reader.send.unsupportedAccount"
          : status === 404 && mail.kind === "new" && mail.accountId
            ? "reader.send.accountGone"
            : "reader.send.failed";
  return { unknown: false, message };
}

export interface AccountWords {
  work: string;
  personalGmail: string;
  naver: string;
  primary: string;
}

function accountCandidate(inbox: InboxOption, words: AccountWords): string {
  switch (inbox.provider) {
    case "GOOGLE":
      return inbox.purpose === "work"
        ? words.work
        : inbox.purpose === "personal"
          ? words.personalGmail
          : "Gmail";
    case "OUTLOOK":
      return "Outlook";
    case "NAVER":
      return words.naver;
    case "ICLOUD":
      return "iCloud";
    default:
      return inbox.email ?? words.primary;
  }
}

/**
 * A short name for a connected account, as the artboards write it ("회사",
 * "개인 Gmail", "네이버"): from its provider and declared purpose. Two
 * accounts that would read the same fall back to their addresses, so the
 * label always names exactly one account.
 */
export function accountShortLabel(
  inbox: InboxOption,
  all: readonly InboxOption[],
  words: AccountWords,
): string {
  const mine = accountCandidate(inbox, words);
  const clash = all.some(
    (other) => other !== inbox && other.id !== inbox.id && accountCandidate(other, words) === mine,
  );
  return clash ? (inbox.email ?? mine) : mine;
}

// ── Attention items ─────────────────────────────────────────────────────────

export interface AttentionFacts {
  itemId: string;
  tierReason: string | null;
}

/**
 * EmailMessage id → its OPEN attention item (id + why). Done / Later act on
 * the attention item, and the list rows only carry the email id.
 */
export function attentionByEmail(
  firewall: FirewallResponse | undefined,
): Map<string, AttentionFacts> {
  const map = new Map<string, AttentionFacts>();
  if (!firewall) return map;
  for (const items of Object.values(firewall.tiers)) {
    for (const item of items) {
      const emailId = item.email?.emailDbId ?? (item.source === "EMAIL" ? item.sourceId : null);
      if (emailId && !map.has(emailId)) {
        map.set(emailId, { itemId: item.id, tierReason: item.tierReason });
      }
    }
  }
  return map;
}

// ── Lists ───────────────────────────────────────────────────────────────────

/** Rows the user cleared on this device (Done / Later) are kept out until `until`. */
export function visibleRows(
  rows: readonly EmailListItem[],
  hidden: ReadonlyMap<string, number>,
  now: number,
): EmailListItem[] {
  return rows.filter((row) => {
    const until = hidden.get(row.id);
    return until === undefined || until <= now;
  });
}

/** De-duplicates pages (a mail can shift pages while new mail arrives). */
export function flattenPages(pages: ReadonlyArray<{ emails: EmailListItem[] }>): EmailListItem[] {
  const seen = new Set<string>();
  const out: EmailListItem[] = [];
  for (const page of pages) {
    for (const email of page.emails) {
      if (seen.has(email.id)) continue;
      seen.add(email.id);
      out.push(email);
    }
  }
  return out;
}

/** The previous (newer) / next (older) mail around `id` in the list the reader came from. */
export function neighbours(
  rows: readonly { id: string }[],
  id: string,
): { newerId: string | null; olderId: string | null } {
  const i = rows.findIndex((r) => r.id === id);
  if (i < 0) return { newerId: null, olderId: null };
  return { newerId: rows[i - 1]?.id ?? null, olderId: rows[i + 1]?.id ?? null };
}

/** "전체" = every lane the list shows by default (SILENT is recorded, never rendered). */
export function allLanesTotal(
  counts: Record<LiveTier, { total: number }> | undefined,
): number | null {
  if (!counts) return null;
  return counts.PUSH.total + counts.MEETING.total + counts.QUEUE.total + counts.INFO.total;
}

// ── Send receipt ────────────────────────────────────────────────────────────

/**
 * The deterministic-floor payload hash for a send, byte-for-byte the server's
 * `sendEmailPayloadHash` (packages/api/src/judge/attention-floor.ts,
 * RECEIPT_SCHEMA_VERSION "v1"): sha256 over the canonical JSON of exactly
 * what the confirm sheet showed. The receipt the app shows after a send
 * carries it, so "what I approved" and "what went out" can be compared.
 */
export function sendPayloadCanonical(input: { to: string; subject: string; body: string }): string {
  return JSON.stringify({
    v: "v1",
    action: "send_email",
    to: input.to.normalize("NFC").trim().toLowerCase(),
    subject: input.subject.normalize("NFC"),
    body: input.body.normalize("NFC"),
  });
}

export async function sendPayloadHash(input: {
  to: string;
  subject: string;
  body: string;
}): Promise<string> {
  const bytes = new TextEncoder().encode(sendPayloadCanonical(input));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Recipients ──────────────────────────────────────────────────────────────

const ADDRESS = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/** Comma/semicolon separated recipients, each a plain address; null when any is malformed. */
export function parseRecipients(raw: string): string[] | null {
  const parts = raw
    .split(/[,;]/)
    .map((p) => addressOf(p))
    .filter(Boolean);
  if (parts.length === 0) return null;
  return parts.every((p) => ADDRESS.test(p)) ? parts : null;
}

// ── Subscriptions ───────────────────────────────────────────────────────────

/** Read share in whole percent (unread mail counts as not read). */
export function readPercent(sub: Pick<EmailSubscriptionWire, "count" | "unreadCount">): number {
  if (sub.count <= 0) return 0;
  return Math.round(((sub.count - Math.min(sub.unreadCount, sub.count)) / sub.count) * 100);
}

/** "거의 안 읽는" = under 10% read — the artboard's red bar. */
export const RARELY_READ_PERCENT = 10;

export function rarelyRead(subs: readonly EmailSubscriptionWire[]): EmailSubscriptionWire[] {
  return subs.filter((s) => readPercent(s) < RARELY_READ_PERCENT);
}

export function readTone(percent: number): "danger" | "warn" | "ok" {
  return percent < RARELY_READ_PERCENT ? "danger" : percent < 50 ? "warn" : "ok";
}

export function subscriptionStats(subs: readonly EmailSubscriptionWire[]): {
  senders: number;
  mail: number;
  readPercent: number;
} {
  const mail = subs.reduce((n, s) => n + s.count, 0);
  const unread = subs.reduce((n, s) => n + Math.min(s.unreadCount, s.count), 0);
  return {
    senders: subs.length,
    mail,
    readPercent: mail === 0 ? 0 : Math.round(((mail - unread) / mail) * 100),
  };
}

export function subscriptionKey(
  sub: Pick<EmailSubscriptionWire, "sender" | "linkedInboxAccountId">,
): string {
  return `${sub.linkedInboxAccountId ?? "primary"}:${sub.sender}`;
}
