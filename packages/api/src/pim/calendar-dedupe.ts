/**
 * Read-time dedupe of CalendarEvent rows (step C2 of
 * docs/providers/unified-platform-plan.md).
 *
 * The database keeps one row per event PER SOURCE CALENDAR, so an invite that
 * sits in both the primary and a linked Google calendar is two rows. A reader
 * that lists or counts events must show it once. The key is (provider,
 * externalId), scoped by userId when the rows carry it; the primary copy wins
 * because it is the one the user can edit; among linked copies the lowest
 * `sourceKey` wins, then the lowest `id`, so the choice never depends on the order
 * a query happened to return rows in. Rows with no externalId (LOCAL) are never
 * merged.
 *
 * Known limit, for C7: Google does not always give two accounts' copies of an
 * invite the same event id (the iCalUID is the reliable cross-calendar key), so
 * a copy with a different id is still shown twice.
 */

export interface CalendarRowIdentity {
  readonly provider: string;
  readonly externalId: string | null;
  readonly sourceAccountId: string | null;
  /** 'primary' or the linked account id; absent on selects that omit it (sourceAccountId is used then). */
  readonly sourceKey?: string;
  /** Final tiebreak; absent on selects that omit it. */
  readonly id?: string;
  readonly userId?: string;
}

function groupKey(row: CalendarRowIdentity): string | null {
  if (row.externalId == null || row.externalId === "") return null;
  return `${row.userId ?? ""}\u0000${row.provider}\u0000${row.externalId}`;
}

/** Primary first, then the lowest sourceKey, then the lowest id. */
function precedence(row: CalendarRowIdentity): readonly [number, string, string] {
  const linked = (row.sourceAccountId ?? null) !== null;
  return [linked ? 1 : 0, row.sourceKey ?? row.sourceAccountId ?? "", row.id ?? ""];
}

function compareRows(a: CalendarRowIdentity, b: CalendarRowIdentity): number {
  const [aLinked, aKey, aId] = precedence(a);
  const [bLinked, bKey, bId] = precedence(b);
  if (aLinked !== bLinked) return aLinked - bLinked;
  if (aKey !== bKey) return aKey < bKey ? -1 : 1;
  if (aId !== bId) return aId < bId ? -1 : 1;
  return 0;
}

/** The winner of a group: the lower-precedence row, the earlier one when they tie. */
function preferred<T extends CalendarRowIdentity>(current: T | undefined, candidate: T): T {
  if (current === undefined) return candidate;
  return compareRows(candidate, current) < 0 ? candidate : current;
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
