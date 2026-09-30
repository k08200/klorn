/**
 * OUTLOOK implementation of CalendarProviderActions, read-only, over Microsoft
 * Graph (step C4 of docs/providers/unified-platform-plan.md).
 *
 * Reachable only for a linked OUTLOOK calendar account, and only while
 * OUTLOOK_CALENDAR_ENABLED and OUTLOOK_INBOX_ENABLED are both on: the
 * dispatcher (dispatch.ts) answers the unsupported result otherwise. The
 * account's tokens carry Calendars.Read and nothing else, so a write would be
 * refused by Microsoft itself; the write methods refuse first.
 *
 *   - events: outlook-events.ts (GET /me/calendarView)
 *   - free/busy: outlook-freebusy.ts (POST /me/calendar/getSchedule)
 *   - tokens: outlook-token.ts
 */

import { listCalendarView, toProviderEvent } from "./outlook-events.js";
import { busyBlocksVia, peopleFreeBusyVia, primaryBusyVia } from "./outlook-freebusy.js";
import { GraphRequestError } from "./outlook-graph.js";
import {
  createOutlookCalendarTokenSource,
  type OutlookCalendarTokenSource,
} from "./outlook-token.js";
import {
  type CalendarProviderActions,
  CalendarReadOnlyError,
  type CalendarSession,
} from "./types.js";

function refuseWrite(): Promise<never> {
  return Promise.reject(new CalendarReadOnlyError("OUTLOOK"));
}

const HTTP_UNAUTHORIZED = 401;

/**
 * Run one Graph operation with the account's token. A 401 gets ONE forced refresh
 * and ONE retry with the new token before it is allowed to reach the failure
 * policy, which flags the account for reconnect: a token that still looked fresh
 * can be dead without the grant being revoked. A second 401, or a refresh that is
 * refused, propagates. The operations are reads, so repeating one is harmless.
 */
async function withToken<T>(
  tokens: OutlookCalendarTokenSource,
  run: (token: string) => Promise<T>,
): Promise<T> {
  const token = await tokens.accessToken();
  try {
    return await run(token);
  } catch (err) {
    if (!(err instanceof GraphRequestError) || err.status !== HTTP_UNAUTHORIZED) throw err;
    const renewed = await tokens.renewAfterUnauthorized(token);
    if (renewed === null) throw err;
    return run(renewed);
  }
}

function outlookSession(tokens: OutlookCalendarTokenSource, accountEmail: string): CalendarSession {
  return {
    provider: "OUTLOOK",
    async listEvents(query) {
      if (query.maxResults < 1) return [];
      const events = await withToken(tokens, (token) => listCalendarView(token, query));
      return events.map((event) => toProviderEvent(event, query.timeZone));
    },
    createEvent: refuseWrite,
    updateEvent: refuseWrite,
    deleteEvent: refuseWrite,
    async busyBlocks(window) {
      return withToken(tokens, (token) => busyBlocksVia(token, accountEmail, window));
    },
    async primaryBusyBlocks(window) {
      return withToken(tokens, (token) => primaryBusyVia(token, window));
    },
    async peopleFreeBusy(emails, window) {
      return withToken(tokens, (token) => peopleFreeBusyVia(token, emails, window));
    },
  };
}

export const outlookCalendarActions: CalendarProviderActions = {
  provider: "OUTLOOK",
  async connect(account) {
    // The primary calendar is the Google login; Outlook only ever links.
    if (account.linkedAccountId === null) return null;
    const tokens = createOutlookCalendarTokenSource(account.userId, account.linked);
    return tokens ? outlookSession(tokens, account.linked.email) : null;
  },
};
