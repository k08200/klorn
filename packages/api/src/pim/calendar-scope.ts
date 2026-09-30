/**
 * The C2 kill switch for linked calendar rows (docs/providers/unified-platform-plan.md).
 *
 * Linked rows exist only while LINKED_CALENDAR_SYNC_ENABLED is on. Turning the
 * flag off stops the sync, but rows already written would keep showing in every
 * reader. So every CalendarEvent reader spreads `calendarSourceScope()` into its
 * `where` (or checks `isCalendarRowVisible` on a row it fetched by id): with the
 * flag off only the primary calendar and LOCAL rows are visible, immediately, and
 * with it on nothing is added. calendar-provider-writers-guard.test.ts fails for a
 * reader that does neither.
 */

import { linkedCalendarSyncEnabled } from "../config.js";

/** A Prisma where-fragment: `{ sourceAccountId: null }` while the flag is off, else `{}`. */
export function calendarSourceScope(): { sourceAccountId?: null } {
  return linkedCalendarSyncEnabled() ? {} : { sourceAccountId: null };
}

/** False for a linked row while the flag is off. */
export function isCalendarRowVisible(row: { sourceAccountId?: string | null }): boolean {
  return linkedCalendarSyncEnabled() || (row.sourceAccountId ?? null) === null;
}

/**
 * The row as the wire carries it: a linked row gains `readOnly: true`, every
 * other row is returned untouched so the primary calendar's JSON stays
 * byte-identical (the field is absent, not false). Clients should hide edit and
 * delete on a readOnly row; the routes refuse them anyway (409).
 */
export function withReadOnlyFlag<T extends { sourceAccountId?: string | null }>(
  row: T,
): T | (T & { readOnly: true }) {
  return (row.sourceAccountId ?? null) === null ? row : { ...row, readOnly: true };
}
