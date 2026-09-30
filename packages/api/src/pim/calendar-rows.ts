/**
 * CalendarEvent row identity — step C1 (expand phase) of
 * docs/providers/unified-platform-plan.md.
 *
 * CalendarEvent is being made provider-aware: every row carries `provider`,
 * `externalId` (the id in the source calendar) and `sourceAccountId` (which
 * linked account it came from) next to the legacy `googleId`. This module is
 * the ONE place that decides those three values, and the one place the Google
 * sync upserts rows, so the writers cannot drift apart. Reads still key on
 * googleId until the contract phase.
 */

import { prisma } from "../db.js";

/** Mirrors the Prisma `CalendarProvider` enum (kept string-typed like InboxProviderName). */
export type CalendarProviderName = "GOOGLE" | "OUTLOOK" | "ICLOUD" | "NAVER" | "DEVICE" | "LOCAL";

export interface CalendarEventSource {
  readonly provider: CalendarProviderName;
  /** The id in the source calendar; null for LOCAL rows. */
  readonly externalId: string | null;
  /** The LinkedCalendarAccount it was synced from; null for the primary calendar and LOCAL rows. */
  readonly sourceAccountId: string | null;
}

/** An event that lives in the user's primary Google calendar. */
export function googleEventSource(googleId: string): CalendarEventSource {
  return { provider: "GOOGLE", externalId: googleId, sourceAccountId: null };
}

/** An event created in Klorn with no external calendar (sample/demo rows, Google-less manual events). */
export function localEventSource(): CalendarEventSource {
  return { provider: "LOCAL", externalId: null, sourceAccountId: null };
}

/**
 * The source for a row whose Google id may be absent: a Google id makes it a
 * GOOGLE row, none (null, undefined or empty) makes it LOCAL — the same rule
 * the migration's backfill applied to existing rows.
 */
export function eventSourceForGoogleId(googleId: string | null | undefined): CalendarEventSource {
  return googleId ? googleEventSource(googleId) : localEventSource();
}

/** The synced fields of a Google event, as the three sync sites map them. */
export interface GoogleEventFields {
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
  fields: GoogleEventFields,
): Promise<void> {
  const source = googleEventSource(googleId);
  await prisma.calendarEvent.upsert({
    where: { userId_googleId: { userId, googleId } },
    create: { userId, ...fields, googleId, ...source },
    update: { ...fields, provider: source.provider, externalId: source.externalId },
  });
}
