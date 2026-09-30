/**
 * CalendarProviderActions for providers with no calendar implementation yet:
 * OUTLOOK (C4), ICLOUD and NAVER (C3), DEVICE (C5/C6), and LOCAL, which is a
 * row-only source with no remote calendar at all.
 *
 * `connect` answers `{ unsupported: true }` so a caller refuses loudly instead
 * of reading it as "not connected" and falling back to a local-only write.
 */

import type { CalendarProviderName } from "../calendar-rows.js";
import type { CalendarProviderActions, CalendarUnsupported } from "./types.js";

function refuse(provider: CalendarProviderName): CalendarUnsupported {
  return {
    unsupported: true,
    error: `Calendar provider ${provider} is not supported from Klorn yet.`,
  };
}

export function unsupportedCalendarActions(
  provider: CalendarProviderName,
): CalendarProviderActions {
  return { provider, connect: async () => refuse(provider) };
}
