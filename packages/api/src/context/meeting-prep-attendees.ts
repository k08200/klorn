/**
 * Attendees of the user's upcoming meetings, for meeting prep. CalendarEvent
 * stores no guest list, and the founder decision of 2026-11-01 (co-attendance)
 * keeps it that way: attendee addresses are read from the calendar provider
 * in memory and never written. This uses the listing co-attendance counting
 * already uses (google-meetings.ts: a field mask with no title, description or
 * location, at most MAX_COUNTED_ATTENDEES guests). No new scope: events.list
 * returns attendees under the calendar scopes the primary and every linked
 * Google account already hold. Whether a source can list attendees is its
 * session's answer (`listMeetingAttendees`); today only Google's can, so other
 * providers' meetings get no prep in this slice.
 *
 * Cost and failure bounds:
 *  - only the sources that own one of the given rows are connected and listed
 *    (no row, no call); sources are listed in parallel, the connect and each
 *    listing under their own timeout;
 *  - a listing is reused per user for ATTENDEE_CACHE_TTL_MS (a failed or
 *    partial one for FAILED_LISTING_TTL_MS), concurrent builds share one
 *    listing, and a source that cannot be connected (re-link pending, or no
 *    listing) counts as attempted, so it does not force a fresh listing on
 *    every page load;
 *  - the listing reaches LISTING_SLACK_MS past the prep horizon, so a reused
 *    listing still covers meetings that enter the horizon meanwhile;
 *  - the cache keeps only the meetings of the given rows (at most the reader's
 *    row cap), lives in process memory keyed by user id, is bounded, and is
 *    never persisted.
 */

import {
  calendarActionsForProvider,
  connectPrimaryCalendar,
  listLinkedCalendarAccounts,
} from "../pim/calendar-providers/dispatch.js";
import {
  type CalendarSession,
  isCalendarUnsupported,
  type ProviderMeeting,
} from "../pim/calendar-providers/types.js";
import type { CalendarReadRow } from "../pim/calendar-read.js";
import { withTimeout } from "../with-timeout.js";
import { PREP_HORIZON_MS } from "./meeting-prep-link.js";

const ATTENDEE_CACHE_TTL_MS = 10 * 60 * 1000;
const FAILED_LISTING_TTL_MS = 2 * 60 * 1000;
const ATTENDEE_CACHE_MAX_USERS = 500;
const CONNECT_TIMEOUT_MS = 5_000;
const LISTING_TIMEOUT_MS = 5_000;
/** How far past the prep horizon the reader asks for rows and the provider for meetings. */
export const LISTING_SLACK_MS = ATTENDEE_CACHE_TTL_MS;
const PRIMARY_SOURCE = "primary";

/** Per calendar source (see sourceKey): event id → meeting. */
type Listings = ReadonlyMap<string, ReadonlyMap<string, ProviderMeeting>>;

interface CachedListings {
  readonly at: number;
  readonly ttl: number;
  /** Every source this listing tried, listed or not. */
  readonly attempted: ReadonlySet<string>;
  readonly bySource: Listings;
}

const cache = new Map<string, CachedListings>();
const inFlight = new Map<string, Promise<Listings>>();

export function __resetMeetingPrepAttendeeCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}

/**
 * A calendar source's identity, as the row's own unique key states it: its
 * provider and its account ("primary" for the login calendar). No provider is
 * named here, so a connector that gains the listing gains prep.
 */
const sourceKey = (provider: string, accountId: string | null): string =>
  `${provider}:${accountId ?? PRIMARY_SOURCE}`;
const sourceOf = (row: CalendarReadRow): string => sourceKey(row.provider, row.sourceAccountId);

/** Error class and provider code only: a provider error can carry request details. */
function describeError(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" || typeof code === "number" ? `${name} code=${code}` : name;
}

/** Which accounts the rows live in: the login calendar, and linked accounts by id. */
interface NeededSources {
  readonly keys: ReadonlySet<string>;
  readonly primary: boolean;
  readonly linkedIds: readonly string[];
}

interface Source {
  readonly key: string;
  readonly session: CalendarSession;
}

const canList = (session: CalendarSession | null): session is CalendarSession =>
  session?.listMeetingAttendees !== undefined;

async function connectLinked(userId: string, ids: readonly string[]): Promise<Source[]> {
  if (ids.length === 0) return [];
  const accounts = (await listLinkedCalendarAccounts(userId)).filter(
    (a) => ids.includes(a.id) && !a.needsReconnect,
  );
  // Each account on its own: one broken linked account (a token that will not
  // decrypt, a revoked grant) must not take the other sources down with it.
  const sessions = await Promise.all(
    accounts.map(async (account): Promise<Source[]> => {
      try {
        const session = await calendarActionsForProvider(account.provider).connect({
          userId,
          linkedAccountId: account.id,
          linked: account,
        });
        if (!session || isCalendarUnsupported(session) || !canList(session)) return [];
        return [{ key: sourceKey(account.provider, account.id), session }];
      } catch (err) {
        console.warn(`[MEETING_PREP] linked calendar connect failed: ${describeError(err)}`);
        return [];
      }
    }),
  );
  return sessions.flat();
}

async function connectSources(userId: string, needed: NeededSources): Promise<Source[]> {
  const [primary, linked] = await Promise.all([
    needed.primary ? connectPrimaryCalendar(userId) : Promise.resolve(null),
    connectLinked(userId, needed.linkedIds),
  ]);
  const own = canList(primary)
    ? [{ key: sourceKey(primary.provider, null), session: primary }]
    : [];
  return [...own, ...linked];
}

async function connectOrNull(userId: string, needed: NeededSources): Promise<Source[] | null> {
  try {
    return await withTimeout(
      connectSources(userId, needed),
      CONNECT_TIMEOUT_MS,
      "meeting-prep.connect",
    );
  } catch (err) {
    console.warn(`[MEETING_PREP] calendar connect failed: ${describeError(err)}`);
    return null;
  }
}

function indexWanted(
  meetings: readonly ProviderMeeting[],
  wanted: ReadonlySet<string>,
): Map<string, ProviderMeeting> {
  const index = new Map<string, ProviderMeeting>();
  for (const meeting of meetings) {
    if (meeting.eventId && wanted.has(meeting.eventId)) index.set(meeting.eventId, meeting);
  }
  return index;
}

type SourceResult =
  | { readonly ok: true; readonly key: string; readonly index: Map<string, ProviderMeeting> }
  | { readonly ok: false };

async function listSource(
  { key, session }: Source,
  window: { timeMin: string; timeMax: string },
  wanted: ReadonlySet<string>,
): Promise<SourceResult> {
  try {
    const list = session.listMeetingAttendees?.bind(session);
    if (!list) return { ok: true, key, index: new Map() };
    const listing = await withTimeout(list(window), LISTING_TIMEOUT_MS, "meeting-prep.attendees");
    return { ok: true, key, index: indexWanted(listing.meetings, wanted) };
  } catch (err) {
    console.warn(`[MEETING_PREP] attendee listing failed: ${describeError(err)}`);
    return { ok: false };
  }
}

function remember(userId: string, entry: CachedListings): void {
  cache.delete(userId);
  if (cache.size >= ATTENDEE_CACHE_MAX_USERS) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(userId, entry);
}

async function listFresh(
  userId: string,
  needed: NeededSources,
  wanted: ReadonlySet<string>,
  now: Date,
): Promise<Listings> {
  const window = {
    timeMin: now.toISOString(),
    timeMax: new Date(now.getTime() + PREP_HORIZON_MS + LISTING_SLACK_MS).toISOString(),
  };
  const sources = await connectOrNull(userId, needed);
  const results = await Promise.all((sources ?? []).map((s) => listSource(s, window, wanted)));
  const bySource: Listings = new Map(
    results.flatMap((r) => (r.ok ? [[r.key, r.index] as const] : [])),
  );
  const failed = sources === null || results.some((r) => !r.ok);
  remember(userId, {
    at: now.getTime(),
    ttl: failed ? FAILED_LISTING_TTL_MS : ATTENDEE_CACHE_TTL_MS,
    attempted: needed.keys,
    bySource,
  });
  return bySource;
}

function listingsFor(
  userId: string,
  needed: NeededSources,
  wanted: ReadonlySet<string>,
  now: Date,
): Promise<Listings> {
  const hit = cache.get(userId);
  if (
    hit &&
    now.getTime() - hit.at < hit.ttl &&
    [...needed.keys].every((key) => hit.attempted.has(key))
  ) {
    return Promise.resolve(hit.bySource);
  }
  const pending = inFlight.get(userId);
  if (pending) return pending;
  const work = listFresh(userId, needed, wanted, now).finally(() => inFlight.delete(userId));
  inFlight.set(userId, work);
  return work;
}

/**
 * The provider meeting behind each row (by row id), for the rows whose source
 * listed it. A row with no match (a source without the listing, a failed
 * listing, an event the listing did not return) is simply absent.
 */
export async function upcomingAttendees(
  userId: string,
  rows: readonly CalendarReadRow[],
  now: Date,
): Promise<Map<string, ProviderMeeting>> {
  const matched = new Map<string, ProviderMeeting>();
  const listed = rows.filter((row) => row.externalId);
  if (listed.length === 0) return matched;
  const linkedIds = [
    ...new Set(listed.flatMap((r) => (r.sourceAccountId ? [r.sourceAccountId] : []))),
  ];
  const needed: NeededSources = {
    keys: new Set(listed.map(sourceOf)),
    primary: listed.some((row) => row.sourceAccountId === null),
    linkedIds,
  };
  const wanted = new Set(listed.flatMap((row) => (row.externalId ? [row.externalId] : [])));
  const bySource = await listingsFor(userId, needed, wanted, now);
  for (const row of listed) {
    const meeting = row.externalId ? bySource.get(sourceOf(row))?.get(row.externalId) : undefined;
    if (meeting) matched.set(row.id, meeting);
  }
  return matched;
}
