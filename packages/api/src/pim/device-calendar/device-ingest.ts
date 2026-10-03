/**
 * Storing one device calendar snapshot (step C6 of
 * docs/providers/unified-platform-plan.md).
 *
 * A desktop app sends, for one calendar the user turned on, every event of a
 * bounded window (device-snapshot.ts checked it). The first snapshot of a calendar
 * creates its source, a LinkedCalendarAccount with provider DEVICE (the opt-in,
 * decision P4); a new source past DEVICE_MAX_SOURCES_PER_USER is refused, a known
 * one always taken. Then, in ONE transaction:
 *   - the source row is upserted (its title, and `updatedAt` as the upload time).
 *     That upsert takes the source's row lock, so two snapshots of one calendar
 *     never interleave;
 *   - rows the snapshot names are created, or updated when a field changed; a row
 *     is found by its external id wherever it lies, so an event moved into the
 *     window updates its row instead of colliding with it;
 *   - the snapshot is the whole truth for its window and its source only: rows of
 *     that source inside the window (the same overlap rule as the snapshot) that it
 *     lacks are removed and their open attention items resolved, through C3's
 *     deletion valve (`isOverDeletionValve`: more than half of the window's rows,
 *     when over 5, is refused). A refusal keeps every row, still applies the
 *     creates and updates, and is logged and sent to Sentry once per source per
 *     process. Another source's, provider's or user's rows are never candidates.
 *   - rows of the source that ended more than DEVICE_ROW_RETENTION_DAYS ago are
 *     removed the same way (no window can reach them any more).
 * Rows are read-only mirrors like every linked row (`sourceAccountId` is set).
 */

import { INTERACTIVE_TX_OPTIONS, prisma } from "../../db.js";
import { captureError } from "../../sentry.js";
import {
  type CalendarEventFields,
  createLinkedEventRows,
  type LinkedEventRowInput,
  linkedSourceScope,
} from "../calendar-rows.js";
import { isOverDeletionValve } from "../calendar-window-reconcile.js";
import {
  DEVICE_WINDOW_MAX_LAG_DAYS,
  type DeviceSnapshot,
  type DeviceSnapshotWindow,
  overlapsDeviceWindow,
} from "./device-snapshot.js";
import { deviceSourceEmail } from "./device-source-key.js";
import { DEVICE_MAX_SOURCES_PER_USER } from "./device-sources.js";

/**
 * A source's row that ended longer ago than this is removed with the next snapshot:
 * no window a device may send reaches that far back, so nothing could ever confirm
 * or remove it again (P4: keep no more of a device's calendar than it still shows).
 */
export const DEVICE_ROW_RETENTION_DAYS = DEVICE_WINDOW_MAX_LAG_DAYS;
const DAY_MS = 86_400_000;

/** Sources remembered as reported; past it the oldest is forgotten (and reported again). */
const MAX_TRACKED_VALVE_REPORTS = 10_000;
const reportedSources = new Set<string>();

export function _resetDeviceValveReportsForTests(): void {
  reportedSources.clear();
}

export type DeviceIngestOutcome =
  | { readonly kind: "over-cap" }
  | {
      readonly kind: "stored";
      readonly created: number;
      readonly updated: number;
      readonly removed: number;
      readonly resolved: number;
      readonly valveRefused: boolean;
      /** Rows past DEVICE_ROW_RETENTION_DAYS removed. */
      readonly expired: number;
    };

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

interface StoredRow extends CalendarEventFields {
  readonly id: string;
  readonly externalId: string | null;
}

const ROW_SELECT = {
  id: true,
  externalId: true,
  title: true,
  description: true,
  startTime: true,
  endTime: true,
  location: true,
  meetingLink: true,
  allDay: true,
} as const;

/** False for a NEW source the user has no room for; a known source is always taken. */
async function hasRoomFor(userId: string, email: string): Promise<boolean> {
  const known = await prisma.linkedCalendarAccount.findUnique({
    where: { userId_provider_email: { userId, provider: "DEVICE", email } },
    select: { id: true },
  });
  if (known) return true;
  const count = await prisma.linkedCalendarAccount.count({
    where: { userId, provider: "DEVICE" },
  });
  return count < DEVICE_MAX_SOURCES_PER_USER;
}

function sameFields(row: StoredRow, fields: CalendarEventFields): boolean {
  return (
    row.title === fields.title &&
    row.description === fields.description &&
    row.startTime.getTime() === fields.startTime.getTime() &&
    row.endTime.getTime() === fields.endTime.getTime() &&
    row.location === fields.location &&
    row.meetingLink === fields.meetingLink &&
    row.allDay === fields.allDay
  );
}

/** The source's rows inside the window, and its rows the snapshot names wherever they lie. */
async function sourceRows(
  tx: Tx,
  userId: string,
  accountId: string,
  snapshot: DeviceSnapshot,
): Promise<StoredRow[]> {
  return tx.calendarEvent.findMany({
    where: {
      ...linkedSourceScope("DEVICE", userId, accountId),
      OR: [
        { startTime: { lt: snapshot.window.end }, endTime: { gte: snapshot.window.start } },
        { externalId: { in: snapshot.events.map((event) => event.externalId) } },
      ],
    },
    select: ROW_SELECT,
  });
}

async function applyUpserts(
  tx: Tx,
  userId: string,
  accountId: string,
  snapshot: DeviceSnapshot,
  existing: readonly StoredRow[],
): Promise<{ created: number; updated: number }> {
  const byExternalId = new Map(existing.map((row) => [row.externalId, row]));
  const fresh: LinkedEventRowInput[] = [];
  let updated = 0;
  for (const event of snapshot.events) {
    const row = byExternalId.get(event.externalId);
    if (!row) {
      fresh.push(event);
    } else if (!sameFields(row, event.fields)) {
      const result = await tx.calendarEvent.updateMany({
        where: { id: row.id, userId, sourceAccountId: accountId },
        data: { ...event.fields },
      });
      updated += result.count;
    }
  }
  const created = await createLinkedEventRows(tx, "DEVICE", userId, accountId, fresh);
  return { created, updated };
}

interface Removal {
  readonly removed: number;
  readonly resolved: number;
  readonly refused: { readonly gone: number; readonly inWindow: number } | null;
}

async function removeVanished(
  tx: Tx,
  userId: string,
  accountId: string,
  snapshot: DeviceSnapshot,
  existing: readonly StoredRow[],
  now: Date,
): Promise<Removal> {
  const window: DeviceSnapshotWindow = snapshot.window;
  const named = new Set(snapshot.events.map((event) => event.externalId));
  const inWindow = existing.filter((row) =>
    overlapsDeviceWindow(row.startTime, row.endTime, window),
  );
  const gone = inWindow.filter((row) => row.externalId === null || !named.has(row.externalId));
  if (gone.length === 0) return { removed: 0, resolved: 0, refused: null };

  // C3's share counts every row of the source in the window, the ones just written included.
  const windowIds = new Set([...inWindow.map((row) => row.externalId), ...named]);
  if (isOverDeletionValve(gone.length, windowIds.size)) {
    return { removed: 0, resolved: 0, refused: { gone: gone.length, inWindow: windowIds.size } };
  }
  const removal = await removeRows(
    tx,
    userId,
    accountId,
    gone.map((row) => row.id),
    now,
  );
  return { ...removal, refused: null };
}

/** Remove rows of the source by id and resolve their open attention items. */
async function removeRows(
  tx: Tx,
  userId: string,
  accountId: string,
  ids: readonly string[],
  now: Date,
): Promise<{ removed: number; resolved: number }> {
  const resolved = await tx.attentionItem.updateMany({
    where: {
      userId,
      source: "CALENDAR_EVENT",
      sourceId: { in: [...ids] },
      status: { in: ["OPEN", "SNOOZED"] },
    },
    data: { status: "RESOLVED", resolvedAt: now },
  });
  const removed = await tx.calendarEvent.deleteMany({
    where: { userId, sourceAccountId: accountId, id: { in: [...ids] } },
  });
  return { removed: removed.count, resolved: resolved.count };
}

/** See DEVICE_ROW_RETENTION_DAYS. Outside the valve: these rows are not "absent". */
async function pruneExpired(tx: Tx, userId: string, accountId: string, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - DEVICE_ROW_RETENTION_DAYS * DAY_MS);
  const expired = await tx.calendarEvent.findMany({
    where: { ...linkedSourceScope("DEVICE", userId, accountId), endTime: { lt: cutoff } },
    select: { id: true },
  });
  if (expired.length === 0) return 0;
  const ids = expired.map((row) => row.id);
  return (await removeRows(tx, userId, accountId, ids, now)).removed;
}

function reportValve(
  userId: string,
  accountId: string,
  counts: { gone: number; inWindow: number },
) {
  if (reportedSources.has(accountId)) return;
  if (reportedSources.size >= MAX_TRACKED_VALVE_REPORTS) {
    const oldest = reportedSources.values().next().value;
    if (oldest !== undefined) reportedSources.delete(oldest);
  }
  reportedSources.add(accountId);
  console.warn(
    `[CALENDAR] device deletion valve: refused removing ${counts.gone} of ${counts.inWindow} rows in the window` +
      ` for ${userId}:${accountId} (rows kept; reported once per source per process)`,
  );
  captureError(new Error("Device calendar removal refused by the deletion valve"), {
    tags: { scope: "calendar.device.deletion_valve", provider: "DEVICE" },
    extra: { userId, linkedAccountId: accountId, vanished: counts.gone, inWindow: counts.inWindow },
  });
}

/** See the header. A database failure propagates (the transaction rolls back). */
export async function ingestDeviceSnapshot(
  userId: string,
  key: string,
  snapshot: DeviceSnapshot,
  now: Date,
): Promise<DeviceIngestOutcome> {
  const email = deviceSourceEmail(key);
  if (!(await hasRoomFor(userId, email))) return { kind: "over-cap" };

  const outcome = await prisma.$transaction(async (tx) => {
    const account = await tx.linkedCalendarAccount.upsert({
      where: { userId_provider_email: { userId, provider: "DEVICE", email } },
      // The schema default is GOOGLE: a device source must say what it is.
      create: { userId, provider: "DEVICE", email, displayName: snapshot.calendarTitle },
      update: { displayName: snapshot.calendarTitle },
      select: { id: true },
    });
    const existing = await sourceRows(tx, userId, account.id, snapshot);
    const written = await applyUpserts(tx, userId, account.id, snapshot, existing);
    const removal = await removeVanished(tx, userId, account.id, snapshot, existing, now);
    const expired = await pruneExpired(tx, userId, account.id, now);
    return { accountId: account.id, ...written, ...removal, expired };
  }, INTERACTIVE_TX_OPTIONS);

  if (outcome.refused) reportValve(userId, outcome.accountId, outcome.refused);
  if (outcome.removed > 0 || outcome.expired > 0) {
    console.log(
      `[CALENDAR] device events removed ${userId}:${outcome.accountId} rows=${outcome.removed} expired=${outcome.expired} attentionResolved=${outcome.resolved}`,
    );
  }
  return {
    kind: "stored",
    created: outcome.created,
    updated: outcome.updated,
    removed: outcome.removed,
    resolved: outcome.resolved,
    valveRefused: outcome.refused !== null,
    expired: outcome.expired,
  };
}
