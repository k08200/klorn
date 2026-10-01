/**
 * ICLOUD and NAVER implementations of CalendarProviderActions, read-only, over
 * CalDAV (step C3 of docs/providers/unified-platform-plan.md).
 *
 * Reachable only for a linked ICLOUD or NAVER account, and only while
 * CALDAV_CALENDAR_ENABLED is on: the dispatcher (dispatch.ts) answers the
 * unsupported result otherwise. The account holds an app-specific password
 * (`caldavPasswordCipher`, encrypted with encryptToken); it is decrypted when a
 * session opens and only ever sent, as Basic auth, to a host the provider's
 * allowlist names (pim/caldav/caldav-http.ts). The write methods refuse.
 *
 *   - discovery and queries: pim/caldav/caldav-client.ts
 *   - the window and its completeness: pim/caldav/caldav-listing.ts
 *   - iCalendar to occurrences: pim/caldav/ical-events.ts
 */

import { decryptToken } from "../../crypto-tokens.js";
import type { BusyConflict, ConflictSummary } from "../../google-calendar-time.js";
import { type HostResolver, resolveHostAddresses } from "../../net/pinned-host.js";
import { getUserTimeZone } from "../../user-timezone.js";
import {
  CALDAV_REQUEST_TIMEOUT_MS,
  type CaldavConnection,
  type CaldavTransport,
} from "../caldav/caldav-http.js";
import { listAccountWindow } from "../caldav/caldav-listing.js";
import {
  CALDAV_PROVIDERS,
  type CaldavProviderConfig,
  type CaldavProviderKey,
  caldavUsernameOf,
} from "../caldav/caldav-providers.js";
import { httpsPinnedTransport } from "../caldav/caldav-transport.js";
import type { CaldavOccurrence } from "../caldav/ical-events.js";
import {
  type CalendarListQuery,
  type CalendarProviderActions,
  CalendarReadOnlyError,
  type CalendarSession,
  type CalendarWindow,
  type CalendarWindowListing,
} from "./types.js";

/** The whole time budget of one listing (discovery and every calendar). */
export const CALDAV_SYNC_DEADLINE_MS = 45_000;
/** An open-ended query (no timeMax) reads this many days. */
const OPEN_ENDED_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Occurrences read for a free/busy window. */
const BUSY_WINDOW_MAX_EVENTS = 250;
/** The label a busy block carries to the model: never a calendar's own name, which is user text. */
const BUSY_CALENDAR_LABEL = "calendar";

export interface CaldavDeps {
  readonly transport: CaldavTransport;
  readonly resolve: HostResolver;
  readonly now: () => number;
}

const DEFAULT_DEPS: CaldavDeps = {
  transport: httpsPinnedTransport,
  resolve: resolveHostAddresses,
  now: () => Date.now(),
};

function refuseWrite(provider: CaldavProviderKey): () => Promise<never> {
  return () => Promise.reject(new CalendarReadOnlyError(provider));
}

interface Credentials {
  readonly config: CaldavProviderConfig;
  readonly userId: string;
  readonly username: string;
  readonly password: string;
}

function connection(credentials: Credentials, deps: CaldavDeps): CaldavConnection {
  return {
    provider: credentials.config,
    username: credentials.username,
    password: credentials.password,
    deadline: deps.now() + CALDAV_SYNC_DEADLINE_MS,
    requestTimeoutMs: CALDAV_REQUEST_TIMEOUT_MS,
    transport: deps.transport,
    resolve: deps.resolve,
    now: deps.now,
  };
}

function windowOf(query: CalendarListQuery): CalendarWindow {
  const timeMax =
    query.timeMax ??
    new Date(Date.parse(query.timeMin) + OPEN_ENDED_WINDOW_DAYS * DAY_MS).toISOString();
  return { timeMin: query.timeMin, timeMax };
}

interface CaldavWindowListing extends CalendarWindowListing {
  readonly events: CaldavOccurrence[];
}

async function listWindow(
  credentials: Credentials,
  deps: CaldavDeps,
  query: CalendarListQuery,
): Promise<CaldavWindowListing> {
  const listedAt = new Date(deps.now());
  const window = windowOf(query);
  // Floating times are read in the user's zone: the query's, else the configured one.
  const zone = query.timeZone ?? (await getUserTimeZone(credentials.userId));
  const listing = await listAccountWindow(
    connection(credentials, deps),
    { start: new Date(window.timeMin), end: new Date(window.timeMax) },
    zone,
    query.maxResults,
  );
  return { events: listing.occurrences, complete: listing.complete, window, listedAt };
}

async function busyOccurrences(
  credentials: Credentials,
  deps: CaldavDeps,
  window: CalendarWindow,
): Promise<CaldavOccurrence[]> {
  const listing = await listWindow(credentials, deps, {
    ...window,
    maxResults: BUSY_WINDOW_MAX_EVENTS,
  });
  return listing.events.filter((event) => event.busy);
}

function caldavSession(credentials: Credentials, deps: CaldavDeps): CalendarSession {
  const provider = credentials.config.provider;
  return {
    provider,
    listWindow: (query) => listWindow(credentials, deps, query),
    async listEvents(query) {
      return (await listWindow(credentials, deps, query)).events;
    },
    createEvent: refuseWrite(provider),
    updateEvent: refuseWrite(provider),
    deleteEvent: refuseWrite(provider),
    async busyBlocks(window): Promise<BusyConflict[]> {
      return (await busyOccurrences(credentials, deps, window)).map((event) => ({
        start: event.start,
        end: event.end,
        calendar: BUSY_CALENDAR_LABEL,
      }));
    },
    async primaryBusyBlocks(window): Promise<ConflictSummary[]> {
      return (await busyOccurrences(credentials, deps, window)).map((event) => ({
        id: null,
        summary: "",
        start: event.start,
        end: event.end,
      }));
    },
    // CalDAV gives no view of other people's calendars: unknown, never free.
    async peopleFreeBusy(emails) {
      return emails.map((email) => ({ email, blocks: null, anyBusy: false }));
    },
  };
}

function credentialsOf(
  config: CaldavProviderConfig,
  userId: string,
  row: { provider: string; email: string; caldavPasswordCipher: string | null },
): Credentials | null {
  if (row.provider !== config.provider || !row.caldavPasswordCipher) return null;
  const username = caldavUsernameOf(config, row.email);
  if (!username) return null;
  try {
    return { config, userId, username, password: decryptToken(row.caldavPasswordCipher) };
  } catch {
    // A rotten cipher is "not connected", like an undecryptable OAuth token.
    return null;
  }
}

/** The actions for one CalDAV provider. `deps` is for tests: the transport and resolver. */
export function caldavCalendarActions(
  provider: CaldavProviderKey,
  deps: Partial<CaldavDeps> = {},
): CalendarProviderActions {
  const config = CALDAV_PROVIDERS[provider];
  const resolved: CaldavDeps = { ...DEFAULT_DEPS, ...deps };
  return {
    provider,
    async connect(account) {
      // The primary calendar is the Google login; a CalDAV account only ever links.
      if (account.linkedAccountId === null) return null;
      const credentials = credentialsOf(config, account.userId, account.linked);
      return credentials ? caldavSession(credentials, resolved) : null;
    },
  };
}
