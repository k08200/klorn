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
 * calendar's rows key on (userId, provider, sourceKey, externalId), for every
 * provider (Google, C2; Outlook, C4).
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

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

/**
 * An event that lives in a LINKED calendar of any provider: a linked Google
 * account (C2) or an Outlook one (C4). The provider is part of the row's identity,
 * so the same event id in two providers is two rows, never one.
 */
export function linkedEventSource(
  provider: CalendarProviderName,
  linkedAccountId: string,
  externalId: string,
): CalendarEventSource {
  return {
    provider,
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
 * Upsert one event of a LINKED calendar (Google, C2; Outlook, C4; iCloud and
 * Naver, C3). The row is matched by the per-source unique, never by googleId:
 * linked rows keep googleId NULL, so an invite that also sits in the primary
 * calendar, or in another provider's calendar, stays a separate row and no other
 * row is ever touched. Identity and ownership never move on update.
 * `caldavCalendarKey` (CalDAV only) records which calendar of the account listed
 * the event, so a calendar missing from a later discovery is not read as empty;
 * every other provider passes none and its rows are written exactly as before.
 */
export async function upsertLinkedEventRow(
  provider: CalendarProviderName,
  userId: string,
  linkedAccountId: string,
  externalId: string,
  fields: CalendarEventFields,
  caldavCalendarKey?: string,
): Promise<void> {
  if (!linkedAccountId) throw new Error("upsertLinkedEventRow needs a linked account id");
  const source = linkedEventSource(provider, linkedAccountId, externalId);
  const calendar = caldavCalendarKey === undefined ? {} : { caldavCalendarKey };
  await prisma.calendarEvent.upsert({
    where: {
      userId_provider_sourceKey_externalId: {
        userId,
        provider: source.provider,
        sourceKey: source.sourceKey,
        externalId,
      },
    },
    create: { userId, ...fields, ...source, ...calendar },
    update: { ...fields, ...calendar },
  });
}

/** One new row of a linked source: its id in the source and its fields. */
export interface LinkedEventRowInput {
  readonly externalId: string;
  readonly fields: CalendarEventFields;
}

/**
 * Insert NEW rows of one linked source in one statement, inside the caller's
 * transaction: the device snapshot (C6) writes a whole calendar at once. Identity
 * comes from `linkedEventSource` like every other linked row; a row that already
 * exists under the per-source unique is skipped, never duplicated or moved (the
 * caller updates existing rows itself, scoped to the same source).
 */
export async function createLinkedEventRows(
  client: Prisma.TransactionClient,
  provider: CalendarProviderName,
  userId: string,
  linkedAccountId: string,
  rows: readonly LinkedEventRowInput[],
): Promise<number> {
  if (!linkedAccountId) throw new Error("createLinkedEventRows needs a linked account id");
  if (rows.length === 0) return 0;
  const created = await client.calendarEvent.createMany({
    data: rows.map((row) => ({
      userId,
      ...row.fields,
      ...linkedEventSource(provider, linkedAccountId, row.externalId),
    })),
    skipDuplicates: true,
  });
  return created.count;
}

/**
 * The rows of ONE Google source calendar of one user: GOOGLE rows whose source key
 * is the linked account's (`linkedAccountId` null is the primary calendar). The
 * `where` every removal by id (cancelled events, C2b) starts from, so the source
 * key is derived here and nowhere else; LOCAL rows and another provider's, user's
 * or account's rows are outside it.
 */
export function googleSourceScope(userId: string, linkedAccountId: string | null) {
  return {
    userId,
    provider: "GOOGLE" as const,
    sourceKey: sourceKeyFor(linkedAccountId),
  };
}

/**
 * The rows of ONE linked account of one user, of one provider: the `where` the
 * CalDAV window reconcile (C3) starts from. The source key is derived here like
 * every other; the primary calendar, LOCAL rows and another account's, provider's
 * or user's rows are outside it.
 */
export function linkedSourceScope(
  provider: CalendarProviderName,
  userId: string,
  linkedAccountId: string,
) {
  if (!linkedAccountId) throw new Error("linkedSourceScope needs a linked account id");
  return {
    userId,
    provider,
    sourceAccountId: linkedAccountId,
    sourceKey: sourceKeyFor(linkedAccountId),
  };
}
