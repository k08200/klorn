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
 *
 * Since C7 a connector of another provider plugs its own flag into the same switch
 * through `CALENDAR_PROVIDER_ENABLED` (C4 registered `OUTLOOK: outlookCalendarEnabled`,
 * C3 `ICLOUD` and `NAVER: caldavCalendarEnabled`, C6 `DEVICE: deviceCalendarEnabled`): its rows are
 * visible only while its flag is on, whatever the Google linked flag says. GOOGLE
 * keeps LINKED_CALENDAR_SYNC_ENABLED and LOCAL is always visible. A provider with
 * no entry has no connector, so it has no rows and adds nothing to the query.
 *
 * The fragment uses only the top-level keys `sourceAccountId`, `provider` and
 * `OR`, so a caller must not put a top-level `OR` of its own next to it (wrap one
 * in `AND: [{ OR: [...] }]`).
 */

import type { Prisma } from "@prisma/client";
import {
  caldavCalendarEnabled,
  deviceCalendarEnabled,
  linkedCalendarSyncEnabled,
  outlookCalendarEnabled,
} from "../config.js";
import type { CalendarProviderName } from "./calendar-rows.js";

/** The providers whose rows have a flag of their own (every one but GOOGLE and LOCAL). */
export type GatedCalendarProvider = Exclude<CalendarProviderName, "GOOGLE" | "LOCAL">;

/** A provider to "is its connector enabled?", read at request time. */
export type ProviderEnabledMap = Readonly<Partial<Record<GatedCalendarProvider, () => boolean>>>;

/**
 * The registered connectors. C4 registered OUTLOOK (`outlookCalendarEnabled`:
 * OUTLOOK_CALENDAR_ENABLED and OUTLOOK_INBOX_ENABLED); C3 registered ICLOUD and
 * NAVER (`caldavCalendarEnabled`: CALDAV_CALENDAR_ENABLED, one flag for both CalDAV
 * providers); C6 registered DEVICE (`deviceCalendarEnabled`: DEVICE_CALENDAR_ENABLED,
 * the calendars a desktop app uploads); C5 (mobile) will share DEVICE and its flag
 * or add its own entry, and every reader, the by-id check and the tests pick it up. Exported so a connector's own tests can pass a
 * map of their own to `calendarSourceScope` and `isCalendarRowVisible`.
 */
export const CALENDAR_PROVIDER_ENABLED: ProviderEnabledMap = {
  OUTLOOK: outlookCalendarEnabled,
  ICLOUD: caldavCalendarEnabled,
  NAVER: caldavCalendarEnabled,
  DEVICE: deviceCalendarEnabled,
};

function registeredProviders(map: ProviderEnabledMap): GatedCalendarProvider[] {
  return Object.keys(map) as GatedCalendarProvider[];
}

function partition(map: ProviderEnabledMap): {
  enabled: GatedCalendarProvider[];
  hidden: GatedCalendarProvider[];
} {
  const all = registeredProviders(map);
  const enabled = all.filter((provider) => map[provider]?.() === true);
  return { enabled, hidden: all.filter((provider) => !enabled.includes(provider)) };
}

/**
 * A Prisma where-fragment: `{ sourceAccountId: null }` while the linked sync is
 * off, `{}` once it is on, each narrowed or widened by the registered providers'
 * own flags (see the header).
 */
export function calendarSourceScope(
  providerEnabled: ProviderEnabledMap = CALENDAR_PROVIDER_ENABLED,
): Prisma.CalendarEventWhereInput {
  const { enabled, hidden } = partition(providerEnabled);
  const hideDisabled = hidden.length > 0 ? { provider: { notIn: hidden } } : {};
  if (linkedCalendarSyncEnabled()) return hideDisabled;
  const primaryOnly = { sourceAccountId: null, ...hideDisabled };
  if (enabled.length === 0) return primaryOnly;
  return { OR: [primaryOnly, { provider: { in: enabled } }] };
}

/**
 * True when any linked row can reach a reader: the Google linked sync is on, or a
 * registered provider's own flag is. A reader that merges copies or caps after the
 * merge (pim/calendar-read.ts) must take that path whenever this is true, not only
 * while the Google flag is: a provider's rows can be visible with the Google flag
 * off, and two accounts of one provider can hold the same invite.
 */
export function anyLinkedRowVisible(
  providerEnabled: ProviderEnabledMap = CALENDAR_PROVIDER_ENABLED,
): boolean {
  return linkedCalendarSyncEnabled() || partition(providerEnabled).enabled.length > 0;
}

/** False for a row the scope above hides, for a row fetched by id. */
export function isCalendarRowVisible(
  row: { sourceAccountId?: string | null; provider?: string },
  providerEnabled: ProviderEnabledMap = CALENDAR_PROVIDER_ENABLED,
): boolean {
  // Own keys only: a provider string such as "constructor" must not find a function
  // on the prototype chain.
  const gate =
    row.provider !== undefined && Object.hasOwn(providerEnabled, row.provider)
      ? providerEnabled[row.provider as GatedCalendarProvider]
      : undefined;
  if (gate) return gate();
  if (!isReadOnlyCalendarRow(row)) return true;
  return linkedCalendarSyncEnabled();
}

/** True for a linked calendar's row: a read-only mirror, whatever reads it. */
export function isReadOnlyCalendarRow(row: { sourceAccountId?: string | null }): boolean {
  return (row.sourceAccountId ?? null) !== null;
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
  return isReadOnlyCalendarRow(row) ? { ...row, readOnly: true } : row;
}
