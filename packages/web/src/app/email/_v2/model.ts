/**
 * Mail v2 list model (productization plan §1, P5, MAIL_V2) — the pure half:
 * what the lane control offers, how a view becomes a list request, and how a
 * row's account and time are worded. No React and no DOM, so the api vitest
 * suite pins it (packages/api/src/__tests__/web-mail-v2-model.test.ts).
 */

import type {
  EmailLaneCounts,
  EmailListItem,
  InboxOption,
  InboxProvider,
  LiveTier,
} from "@klorn/contract";
import { CORE_TIERS } from "../../../lib/tiers";

/** What the list is scoped to: one live lane, or every lane. */
export type LaneView = LiveTier | "ALL";

/** The legacy filters that survive as a secondary menu. */
export type SecondaryFilter = "none" | "reply-needed" | "unread" | "attachments" | "threads";

/** "all", "primary", or a linked inbox id — the list API's `inbox` values. */
export type AccountScope = string;

export const DEFAULT_LANE: LaneView = "QUEUE";
export const ALL_ACCOUNTS: AccountScope = "all";

/** The lane control, in order. SILENT is deliberately absent (plan §1). */
const LANE_SEGMENTS: readonly LaneView[] = [
  ...CORE_TIERS.filter((lane) => lane !== "SILENT"),
  "ALL",
];
const LANE_VIEWS: readonly LaneView[] = [...LANE_SEGMENTS, "SILENT"];

export const SECONDARY_FILTERS: readonly SecondaryFilter[] = [
  "none",
  "reply-needed",
  "unread",
  "attachments",
  "threads",
];

export function isLaneView(value: unknown): value is LaneView {
  return (LANE_VIEWS as readonly unknown[]).includes(value);
}

/**
 * The segments to render. SILENT is reachable only through "Show silenced";
 * while it is the current view it joins the row so the control still says
 * where the user is, and leaves again when they move on.
 */
export function laneSegments(current: LaneView): readonly LaneView[] {
  return current === "SILENT" ? LANE_VIEWS : LANE_SEGMENTS;
}

export interface ListView {
  lane: LaneView;
  account: AccountScope;
  filter: SecondaryFilter;
  search: string;
}

/** Path and query for one page of the view. Threads have their own endpoint. */
export function listRequestPath(view: ListView, page: number): string {
  const params = new URLSearchParams();
  const search = view.search.trim();
  if (search) params.set("search", search);
  params.set("page", String(page));
  if (view.filter === "threads") return `/api/email/threads?${params.toString()}`;
  if (view.filter !== "none") params.set("filter", view.filter);
  if (view.account !== ALL_ACCOUNTS) params.set("inbox", view.account);
  params.set("tier", view.lane);
  return `/api/email?${params.toString()}`;
}

/** True when the view is narrowed by anything other than its lane. */
export function isNarrowed(view: ListView): boolean {
  return view.filter !== "none" || view.account !== ALL_ACCOUNTS || view.search.trim() !== "";
}

/**
 * Whether rows carry their lane chip. Inside one lane the chip repeats the
 * selected segment on every row, so it shows only where the view mixes lanes
 * or is not the standing set: All, a search, and "Show silenced".
 */
export function showsLaneChip(view: ListView): boolean {
  return view.lane === "ALL" || view.lane === "SILENT" || view.search.trim() !== "";
}

/**
 * The lane a row shows. A row whose lane differs from the selected segment
 * (it was just moved, and has not left the list yet) keeps its chip: there the
 * chip is news, not repetition.
 */
export function rowLane(view: ListView, tier: LiveTier | null): LiveTier | null {
  if (tier === null) return null;
  return showsLaneChip(view) || tier !== view.lane ? tier : null;
}

export interface ViewTally {
  /** Mail in this exact view (lane, account, filter, search). */
  total: number;
  /** Unread among them; null when the lane counts cannot answer for this view. */
  unread: number | null;
}

/**
 * The header line's numbers. `total` is the list's own total; `unread` comes
 * from the lane counts already loaded for the selected account, so it is known
 * only while the view is a plain lane (no filter, no search) — never a guess.
 */
export function viewTally(
  view: ListView,
  counts: EmailLaneCounts | null,
  listTotal: number,
): ViewTally {
  if (!counts || view.filter !== "none" || view.search.trim() !== "") {
    return { total: listTotal, unread: null };
  }
  const unread =
    view.lane === "ALL"
      ? Object.values(counts).reduce((sum, lane) => sum + lane.unread, 0)
      : counts[view.lane].unread;
  return { total: listTotal, unread };
}

/** The ids from `fromId` to `toId` inclusive, in list order; just `toId` when either is gone. */
export function rangeIds(ids: readonly string[], fromId: string | null, toId: string): string[] {
  const from = fromId === null ? -1 : ids.indexOf(fromId);
  const to = ids.indexOf(toId);
  if (from < 0 || to < 0) return [toId];
  return ids.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/** Path and query for the reader's context in the view it was opened from. */
export function readerContextPath(emailId: string, view: ListView): string {
  const params = new URLSearchParams();
  params.set("tier", view.lane);
  if (view.account !== ALL_ACCOUNTS) params.set("inbox", view.account);
  // Threads are not a lane page; the reader walks the lane itself there.
  if (view.filter !== "none" && view.filter !== "threads") params.set("filter", view.filter);
  const search = view.search.trim();
  if (search) params.set("search", search);
  return `/api/email/${encodeURIComponent(emailId)}/reader-context?${params.toString()}`;
}

/** The reader's "next mail" queue for this view (GET /api/email/next?queue=). */
export function readerQueue(filter: SecondaryFilter): string {
  return filter === "none" || filter === "threads" ? "all" : filter;
}

export interface AccountOption {
  /** The list API's `inbox` value for this account. */
  scope: AccountScope;
  /** The linked inbox id rows carry; null for the primary account. */
  linkedId: string | null;
  provider: InboxProvider;
  email: string | null;
  /**
   * Short tag for the row badge ("work@"), set only when the provider alone
   * would not tell two accounts apart.
   */
  nickname: string | null;
  needsReconnect: boolean;
}

const NICKNAME_MAX = 12;

function nicknameOf(email: string | null): string | null {
  const local = email?.split("@")[0]?.trim();
  if (!local) return null;
  return `${local.length > NICKNAME_MAX ? `${local.slice(0, NICKNAME_MAX)}…` : local}@`;
}

export function accountOptions(inboxes: readonly InboxOption[]): AccountOption[] {
  const perProvider = new Map<string, number>();
  for (const inbox of inboxes) {
    perProvider.set(inbox.provider, (perProvider.get(inbox.provider) ?? 0) + 1);
  }
  return inboxes.map((inbox) => ({
    scope: inbox.kind === "primary" || !inbox.id ? "primary" : inbox.id,
    linkedId: inbox.kind === "primary" ? null : inbox.id,
    provider: inbox.provider,
    email: inbox.email,
    nickname: (perProvider.get(inbox.provider) ?? 0) > 1 ? nicknameOf(inbox.email) : null,
    needsReconnect: inbox.needsReconnect,
  }));
}

/** The account a row arrived in; null when it is not among the known ones. */
export function rowAccount(
  row: Pick<EmailListItem, "linkedInboxAccountId">,
  accounts: readonly AccountOption[],
): AccountOption | null {
  return accounts.find((account) => account.linkedId === row.linkedInboxAccountId) ?? null;
}

/** "Ada Lovelace <ada@x.com>" → "Ada Lovelace"; a bare address stays as is. */
export function senderName(raw: string): string {
  const name = raw
    .replace(/<[^>]*>/g, "")
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .trim();
  return name || raw.replace(/[<>]/g, "").trim();
}

const DAY_MS = 86_400_000;
const WEEKDAY_WINDOW_DAYS = 6;

/** Calendar day of `date` in `timeZone`, as days since the epoch. */
function dayNumber(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return Math.floor(Date.UTC(value("year"), value("month") - 1, value("day")) / DAY_MS);
}

/**
 * Row time, shortest form that is still unambiguous: the clock time today, the
 * weekday within the last week, then the date (with the year once it differs).
 * Returns "" for an unparseable date rather than inventing one.
 */
export function formatRowTime(iso: string, now: Date, locale: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const format = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, { timeZone, ...options }).format(date);
  const age = dayNumber(now, timeZone) - dayNumber(date, timeZone);
  if (age <= 0) return format({ hour: "numeric", minute: "2-digit" });
  if (age <= WEEKDAY_WINDOW_DAYS) return format({ weekday: "short" });
  const sameYear =
    format({ year: "numeric" }) ===
    new Intl.DateTimeFormat(locale, { timeZone, year: "numeric" }).format(now);
  return format(
    sameYear
      ? { month: "short", day: "numeric" }
      : { year: "2-digit", month: "short", day: "numeric" },
  );
}
