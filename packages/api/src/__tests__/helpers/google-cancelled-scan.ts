/**
 * The cancellation scan's Google request (C2b), written out ONCE for the tests.
 * It is its own events.list - never the sync listing - so the shape is asserted
 * exactly: no timeMin/timeMax (a time filter could drop a cancelled event that
 * has no start), singleEvents false (no recurring expansion filling the page
 * cap), ordered by `updated` so a truncated scan can resume where it stopped.
 */

export const CANCELLED_SCAN_FIELDS = "nextPageToken,items(id,status,updated,recurringEventId)";

/** The request body of one page of the scan. */
export function cancelledScanRequest(updatedMin: string, pageToken?: string) {
  return {
    calendarId: "primary",
    updatedMin,
    singleEvents: false,
    showDeleted: true,
    orderBy: "updated",
    maxResults: 250,
    fields: CANCELLED_SCAN_FIELDS,
    ...(pageToken ? { pageToken } : {}),
  };
}

/** The call options: a bounded wait and no retries, so a hung call cannot hold a sync tick. */
export const CANCELLED_SCAN_OPTIONS = { timeout: 10_000, retry: false };
