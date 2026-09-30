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
