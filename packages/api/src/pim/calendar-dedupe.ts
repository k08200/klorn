/**
 * Read-time dedupe of CalendarEvent rows (step C2 of
 * docs/providers/unified-platform-plan.md).
 *
 * The database keeps one row per event PER SOURCE CALENDAR, so an invite that
 * sits in both the primary and a linked Google calendar is two rows. A reader
 * that lists or counts events must show it once. The key is (provider,
 * externalId), scoped by userId when the rows carry it; the primary copy wins
 * because it is the one the user can edit. Rows with no externalId (LOCAL) are
 * never merged.
 *
 * Known limit, for C7: Google does not always give two accounts' copies of an
 * invite the same event id (the iCalUID is the reliable cross-calendar key), so
 * a copy with a different id is still shown twice.
 */

export interface CalendarRowIdentity {
  readonly provider: string;
  readonly externalId: string | null;
  readonly sourceAccountId: string | null;
  readonly userId?: string;
}

function groupKey(row: CalendarRowIdentity): string | null {
  if (row.externalId == null || row.externalId === "") return null;
  return `${row.userId ?? ""}\u0000${row.provider}\u0000${row.externalId}`;
}

/** The primary copy (no linked account) of a group, else its first row. */
function preferred<T extends CalendarRowIdentity>(current: T | undefined, candidate: T): T {
  if (current === undefined) return candidate;
  const currentIsLinked = (current.sourceAccountId ?? null) !== null;
  const candidateIsLinked = (candidate.sourceAccountId ?? null) !== null;
  return currentIsLinked && !candidateIsLinked ? candidate : current;
}

export function dedupeCalendarEvents<T extends CalendarRowIdentity>(events: readonly T[]): T[] {
  const winners = new Map<string, T>();
  for (const event of events) {
    const key = groupKey(event);
    if (key !== null) winners.set(key, preferred(winners.get(key), event));
  }
  return events.filter((event) => {
    const key = groupKey(event);
    return key === null || winners.get(key) === event;
  });
}
