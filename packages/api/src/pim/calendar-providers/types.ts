/**
 * CalendarProviderActions — the provider-agnostic surface of a calendar account
 * (step C2 of docs/providers/unified-platform-plan.md; mirrors mail/providers).
 *
 * Shape: `connect` resolves an account's credentials ONCE and answers a
 * `CalendarSession` bound to them. That keeps the order the Google code always
 * had (credentials first, then the user's timezone, then the API) and the
 * number of token lookups per operation unchanged.
 *
 * Result contract, in caller-priority order:
 *   - `{ unsupported: true }` from `connect` - this provider has no calendar
 *     implementation yet. Callers refuse loudly; they must NOT treat it as
 *     "not connected" and fall back to a local-only write.
 *   - `null` from `connect` - the account is not connected (no token, a stale
 *     id, an undecryptable token). Callers keep their existing not-connected
 *     path.
 *   - a session - its methods resolve with data and THROW on a hard failure
 *     (network, 4xx/5xx), exactly as the googleapis calls they wrap did. Each
 *     caller already owns its error policy (soft `{ error }` for the agent,
 *     degrade-to-primary-only for conflicts, a notification for the scheduler),
 *     so the seam does not flatten them into one.
 */

import type { BusyConflict, ConflictSummary } from "../../google-calendar-time.js";
import type { CalendarProviderName } from "../calendar-rows.js";

/** Which calendar account an operation targets. `linkedAccountId` null = the primary Google login. */
export interface CalendarAccountRef {
  readonly userId: string;
  readonly linkedAccountId: string | null;
}

export type CalendarUnsupported = { unsupported: true; error: string };

/** An absolute ISO-8601 instant range. */
export interface CalendarWindow {
  readonly timeMin: string;
  readonly timeMax: string;
}

export interface CalendarListQuery {
  readonly timeMin: string;
  /** Open-ended when absent (the agent's "next N events"). */
  readonly timeMax?: string;
  readonly maxResults: number;
  /**
   * The zone the provider should render times in AND the zone a naive
   * (offset-less) time is read in. When absent, events come back without parsed
   * instants (`startTime`/`endTime` null) - callers that only display raw values
   * do not need a zone.
   */
  readonly timeZone?: string;
}

/** One event of a provider calendar, as the provider reported it. */
export interface ProviderCalendarEvent {
  /** The id in the source calendar; '' when the provider sent none. */
  readonly externalId: string;
  readonly summary: string | null;
  readonly description: string | null;
  readonly location: string | null;
  readonly meetingLink: string | null;
  /** A date-time, or a YYYY-MM-DD date for an all-day event; '' when absent. */
  readonly start: string;
  readonly end: string;
  readonly allDay: boolean;
  /** Instants; null unless the query named a `timeZone`, or when start/end is missing. */
  readonly startTime: Date | null;
  readonly endTime: Date | null;
}

export interface CalendarCreateInput {
  readonly summary: string;
  readonly description?: string;
  readonly location?: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly allDay: boolean;
  /** The user's IANA zone, applied to a naive (offset-less) start/end. */
  readonly timeZone: string;
  /** Invitees; the provider emails them when non-empty. */
  readonly attendees?: readonly string[];
}

/** Both or neither of startTime/endTime - a provider needs a consistent pair. */
export interface CalendarEventPatch {
  readonly summary?: string;
  readonly description?: string | null;
  readonly location?: string | null;
  readonly startTime?: string;
  readonly endTime?: string;
  readonly allDay?: boolean;
  readonly timeZone: string;
}

/** What the provider stored, after its own offset/zone resolution (the canonical values). */
export interface CalendarEventWritten {
  readonly eventId?: string | null;
  readonly htmlLink?: string | null;
  readonly canonicalStart: string | null;
  readonly canonicalEnd: string | null;
}

/** One person's free/busy. `blocks` null = their calendar is not visible: unknown, never free. */
export interface PersonFreeBusy {
  readonly email: string;
  readonly blocks: Array<{ start: string; end: string }> | null;
  /**
   * True when the provider returned ANY busy entry, including one missing its
   * start or end (which `blocks` leaves out). A malformed entry still reads as
   * busy: the safe direction, never a false "free".
   */
  readonly anyBusy: boolean;
}

export interface CalendarSession {
  readonly provider: CalendarProviderName;
  listEvents(query: CalendarListQuery): Promise<ProviderCalendarEvent[]>;
  createEvent(input: CalendarCreateInput): Promise<CalendarEventWritten>;
  updateEvent(eventId: string, patch: CalendarEventPatch): Promise<CalendarEventWritten>;
  deleteEvent(eventId: string): Promise<void>;
  /**
   * Busy blocks across every calendar the account writes to. A 403 means the
   * token predates the calendar.readonly scope; callers may degrade to
   * `primaryBusyBlocks`.
   */
  busyBlocks(window: CalendarWindow): Promise<BusyConflict[]>;
  /** Busy blocks of the account's primary calendar only - the degraded path. */
  primaryBusyBlocks(window: CalendarWindow): Promise<ConflictSummary[]>;
  /** Other people's free/busy by email, for the addresses this account can see. */
  peopleFreeBusy(emails: readonly string[], window: CalendarWindow): Promise<PersonFreeBusy[]>;
}

export interface CalendarProviderActions {
  readonly provider: CalendarProviderName;
  connect(account: CalendarAccountRef): Promise<CalendarSession | CalendarUnsupported | null>;
}

/** True when `connect` answered the explicit unsupported result. */
export function isCalendarUnsupported(
  result: CalendarSession | CalendarUnsupported | null,
): result is CalendarUnsupported {
  return result !== null && "unsupported" in result;
}
