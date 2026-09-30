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

function outlookSession(tokens: OutlookCalendarTokenSource, accountEmail: string): CalendarSession {
  return {
    provider: "OUTLOOK",
    async listEvents(query) {
      if (query.maxResults < 1) return [];
      const events = await listCalendarView(await tokens.accessToken(), query);
      return events.map((event) => toProviderEvent(event, query.timeZone));
    },
    createEvent: refuseWrite,
    updateEvent: refuseWrite,
    deleteEvent: refuseWrite,
    async busyBlocks(window) {
      return busyBlocksVia(await tokens.accessToken(), accountEmail, window);
    },
    async primaryBusyBlocks(window) {
      return primaryBusyVia(await tokens.accessToken(), window);
    },
    async peopleFreeBusy(emails, window) {
      return peopleFreeBusyVia(await tokens.accessToken(), emails, window);
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
