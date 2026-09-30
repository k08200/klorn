/**
 * CalendarEvent row identity — steps C1 and C2 (expand phase) of
 * docs/providers/unified-platform-plan.md.
 *
 * CalendarEvent is being made provider-aware: every row carries `provider`,
 * `externalId` (the id in the source calendar), `sourceAccountId` (which
 * linked account it came from) and `sourceKey` (the per-source dedupe key,
 * 'primary' or the linked account id) next to the legacy `googleId`. This
 * module is the ONE place that decides those four values, and the one place
 * Google events are upserted, so the writers cannot drift apart. The primary
 * calendar still keys on googleId until the contract phase; a linked
 * calendar's rows key on (userId, provider, sourceKey, externalId).
 */

import { INTERACTIVE_TX_OPTIONS, prisma } from "../db.js";

/** Mirrors the Prisma `CalendarProvider` enum (kept string-typed like InboxProviderName). */
export type CalendarProviderName = "GOOGLE" | "OUTLOOK" | "ICLOUD" | "NAVER" | "DEVICE" | "LOCAL";

/** `sourceKey` of the primary calendar and of LOCAL rows. */
export const PRIMARY_SOURCE_KEY = "primary";

/**
 * The per-source dedupe key for a row: the linked account id, or 'primary'. The
 * database CHECK `sourceKey = COALESCE(sourceAccountId, 'primary')` holds only
 * because every writer derives it here.
 */
export function sourceKeyFor(sourceAccountId: string | null): string {
  return sourceAccountId ?? PRIMARY_SOURCE_KEY;
}

export interface CalendarEventSource {
  readonly provider: CalendarProviderName;
  /** The id in the source calendar; null for LOCAL rows. */
  readonly externalId: string | null;
  /** The LinkedCalendarAccount it was synced from; null for the primary calendar and LOCAL rows. */
  readonly sourceAccountId: string | null;
  /** 'primary' or the linked account id: the per-source part of the row's unique key. */
  readonly sourceKey: string;
}

/** An event that lives in the user's primary Google calendar. */
export function googleEventSource(googleId: string): CalendarEventSource {
  return {
    provider: "GOOGLE",
    externalId: googleId,
    sourceAccountId: null,
    sourceKey: sourceKeyFor(null),
  };
}

/** An event that lives in a linked Google calendar (C2). */
export function linkedGoogleEventSource(
  linkedAccountId: string,
  externalId: string,
): CalendarEventSource {
  return {
    provider: "GOOGLE",
    externalId,
    sourceAccountId: linkedAccountId,
    sourceKey: sourceKeyFor(linkedAccountId),
  };
}

/** An event created in Klorn with no external calendar (sample/demo rows, Google-less manual events). */
export function localEventSource(): CalendarEventSource {
  return {
    provider: "LOCAL",
    externalId: null,
    sourceAccountId: null,
    sourceKey: sourceKeyFor(null),
  };
}

/**
 * The source for a row whose Google id may be absent: a Google id makes it a
 * GOOGLE row, none (null, undefined or empty) makes it LOCAL — the same rule
 * the migration's backfill applied to existing rows.
 */
export function eventSourceForGoogleId(googleId: string | null | undefined): CalendarEventSource {
  return googleId ? googleEventSource(googleId) : localEventSource();
}

/** The synced fields of a calendar event, as every sync site maps them. */
export interface CalendarEventFields {
  readonly title: string;
  readonly description: string | null;
  readonly startTime: Date;
  readonly endTime: Date;
  readonly location: string | null;
  readonly meetingLink: string | null;
  readonly allDay: boolean;
}

/**
 * Upsert one primary-calendar Google event. Matching stays on (userId,
 * googleId) — the same Google event can live in two users' calendars, so the
 * match is scoped to the user. Create writes the full identity; update
 * re-stamps provider/externalId so a row written by the previous release
 * (which knew neither) converges on the next sync.
 */
export async function upsertGoogleEventRow(
  userId: string,
  googleId: string,
  fields: CalendarEventFields,
): Promise<void> {
  const source = googleEventSource(googleId);
  await prisma.calendarEvent.upsert({
    where: { userId_googleId: { userId, googleId } },
    create: { userId, ...fields, googleId, ...source },
    update: { ...fields, provider: source.provider, externalId: source.externalId },
  });
}

/**
 * Upsert one event of a LINKED Google calendar. The row is matched by the
 * per-source unique, never by googleId: linked rows keep googleId NULL, so an
 * invite that also sits in the primary calendar stays a separate row and the
 * primary row is never touched. Identity and ownership never move on update.
 */
export async function upsertLinkedGoogleEventRow(
  userId: string,
  linkedAccountId: string,
  externalId: string,
  fields: CalendarEventFields,
): Promise<void> {
  if (!linkedAccountId) throw new Error("upsertLinkedGoogleEventRow needs a linked account id");
  const source = linkedGoogleEventSource(linkedAccountId, externalId);
  await prisma.calendarEvent.upsert({
    where: {
      userId_provider_sourceKey_externalId: {
        userId,
        provider: source.provider,
        sourceKey: source.sourceKey,
        externalId,
      },
    },
    create: { userId, ...fields, ...source },
    update: { ...fields },
  });
}

/**
 * Remove the rows of events Google reports as cancelled (C2b), and resolve the
 * attention items mirrored from them, in ONE transaction. Only ids Google named
 * are touched - never a row merely absent from a listing, because the 100-event
 * cap can truncate the window. The match is the row's whole identity: this user,
 * GOOGLE, the source calendar (`linkedAccountId` null is the primary calendar)
 * and the event id, so another account's row with the same id, another user's,
 * and LOCAL rows (no externalId) are never reached. A PRIMARY row the previous
 * release wrote during the C1 deploy overlap has no externalId yet (the next
 * upsert would stamp it), so it is matched by its googleId; a linked row never has
 * a googleId. Items the user already dismissed keep their outcome; AttentionItem
 * has no foreign key to an event, so they are resolved by (source, sourceId) like
 * every other mirror. Returns the number of rows removed.
 */
export async function removeCancelledGoogleEventRows(
  userId: string,
  linkedAccountId: string | null,
  externalIds: readonly string[],
  now: Date = new Date(),
): Promise<number> {
  if (externalIds.length === 0) return 0;
  return prisma.$transaction(async (tx) => {
    const rows = await tx.calendarEvent.findMany({
      where: {
        userId,
        provider: "GOOGLE",
        sourceKey: sourceKeyFor(linkedAccountId),
        ...(linkedAccountId === null
          ? {
              OR: [
                { externalId: { in: [...externalIds] } },
                { externalId: null, googleId: { in: [...externalIds] } },
              ],
            }
          : { externalId: { in: [...externalIds] } }),
      },
      select: { id: true },
    });
    if (rows.length === 0) return 0;
    const ids = rows.map((row) => row.id);
    await tx.attentionItem.updateMany({
      where: {
        userId,
        source: "CALENDAR_EVENT",
        sourceId: { in: ids },
        status: { in: ["OPEN", "SNOOZED"] },
      },
      data: { status: "RESOLVED", resolvedAt: now },
    });
    const removed = await tx.calendarEvent.deleteMany({ where: { userId, id: { in: ids } } });
    return removed.count;
  }, INTERACTIVE_TX_OPTIONS);
}
