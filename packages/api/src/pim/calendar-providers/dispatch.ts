/**
 * Provider dispatch for calendar accounts (step C2 of
 * docs/providers/unified-platform-plan.md; mirrors mail/providers/dispatch.ts).
 *
 * `calendarActionsFor` answers "which implementation serves this account?" from
 * a linked-calendar id: the primary calendar (null id) is always the Google
 * OAuth login, a linked row dispatches on its `provider` column, and a missing
 * row deliberately resolves to GOOGLE - `connect` then answers null (not
 * connected), which is the right behaviour for a stale id.
 *
 * Callers that already hold the provider skip the lookup with
 * `calendarActionsForProvider`.
 */

import { prisma } from "../../db.js";
import type { CalendarProviderName } from "../calendar-rows.js";
import { googleCalendarActions } from "./google.js";
import {
  type CalendarProviderActions,
  type CalendarSession,
  isCalendarUnsupported,
} from "./types.js";
import { unsupportedCalendarActions } from "./unsupported.js";

const ACTIONS_BY_PROVIDER: Readonly<Record<CalendarProviderName, CalendarProviderActions>> = {
  GOOGLE: googleCalendarActions,
  OUTLOOK: unsupportedCalendarActions("OUTLOOK"),
  ICLOUD: unsupportedCalendarActions("ICLOUD"),
  NAVER: unsupportedCalendarActions("NAVER"),
  DEVICE: unsupportedCalendarActions("DEVICE"),
  LOCAL: unsupportedCalendarActions("LOCAL"),
};

export function calendarActionsForProvider(
  provider: CalendarProviderName,
): CalendarProviderActions {
  return ACTIONS_BY_PROVIDER[provider];
}

export async function calendarActionsFor(
  userId: string,
  linkedAccountId: string | null | undefined,
): Promise<CalendarProviderActions> {
  if (!linkedAccountId) return googleCalendarActions;
  const row = await prisma.linkedCalendarAccount.findFirst({
    where: { id: linkedAccountId, userId },
    select: { provider: true },
  });
  return calendarActionsForProvider((row?.provider as CalendarProviderName) ?? "GOOGLE");
}

/**
 * The primary calendar's session, or null when Google is not connected. The
 * primary login is always Google, so the `unsupported` result cannot occur here.
 */
export async function connectPrimaryCalendar(userId: string): Promise<CalendarSession | null> {
  const actions = await calendarActionsFor(userId, null);
  const session = await actions.connect({ userId, linkedAccountId: null });
  return session && !isCalendarUnsupported(session) ? session : null;
}

/** A linked calendar account as the seam lists it: enough to decide whether and how to connect. */
export interface LinkedCalendarAccountRef {
  readonly id: string;
  readonly email: string;
  readonly provider: CalendarProviderName;
  readonly needsReconnect: boolean;
}

/** Every linked calendar account of the user, of every provider, oldest first. */
export async function listLinkedCalendarAccounts(
  userId: string,
): Promise<LinkedCalendarAccountRef[]> {
  const rows = await prisma.linkedCalendarAccount.findMany({
    where: { userId },
    select: { id: true, email: true, provider: true, needsReconnect: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    provider: row.provider as CalendarProviderName,
    needsReconnect: row.needsReconnect,
  }));
}

/** A linked calendar account with a live session. */
export interface ConnectedLinkedCalendar {
  readonly id: string;
  readonly email: string;
  readonly session: CalendarSession;
}

/**
 * Open a session on each of the user's linked calendar accounts, through the
 * same dispatch as every other account: a provider with no implementation yet
 * answers unsupported and its account is skipped, and so is one whose token is
 * unusable. `skipNeedsReconnect` leaves out accounts flagged for a re-link: the
 * sync does not retry a revoked token every cycle, while conflict checks still
 * try it (a successful refresh clears the flag).
 */
export async function connectLinkedCalendars(
  userId: string,
  options: { skipNeedsReconnect: boolean },
): Promise<ConnectedLinkedCalendar[]> {
  const accounts = await listLinkedCalendarAccounts(userId);
  const connected: ConnectedLinkedCalendar[] = [];
  for (const account of accounts) {
    if (options.skipNeedsReconnect && account.needsReconnect) continue;
    const actions = await calendarActionsFor(userId, account.id);
    const session = await actions.connect({ userId, linkedAccountId: account.id });
    if (session && !isCalendarUnsupported(session)) {
      connected.push({ id: account.id, email: account.email, session });
    }
  }
  return connected;
}
