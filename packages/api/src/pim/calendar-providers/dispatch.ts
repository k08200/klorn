/**
 * Provider dispatch for calendar accounts (step C2 of
 * docs/providers/unified-platform-plan.md; mirrors mail/providers/dispatch.ts).
 *
 * `calendarActionsForProvider` answers "which implementation serves this
 * account?" from its provider. The primary calendar is always the Google OAuth
 * login; a linked account dispatches on the `provider` column of the row the
 * listing already read, so choosing an implementation costs no lookup.
 */

import type { LinkedCalendarAccount } from "@prisma/client";
import { caldavCalendarEnabled, outlookCalendarEnabled } from "../../config.js";
import { prisma } from "../../db.js";
import type { CalendarProviderName } from "../calendar-rows.js";
import { caldavCalendarActions } from "./caldav.js";
import { googleCalendarActions } from "./google.js";
import { outlookCalendarActions } from "./outlook.js";
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

const CALDAV_ACTIONS: Readonly<Record<"ICLOUD" | "NAVER", CalendarProviderActions>> = {
  ICLOUD: caldavCalendarActions("ICLOUD"),
  NAVER: caldavCalendarActions("NAVER"),
};

export function calendarActionsForProvider(
  provider: CalendarProviderName,
): CalendarProviderActions {
  // OUTLOOK (step C4) is real only while OUTLOOK_CALENDAR_ENABLED and
  // OUTLOOK_INBOX_ENABLED are both on, read per call so a flip needs no restart;
  // otherwise it is the unsupported stub in the table, exactly as before C4.
  if (provider === "OUTLOOK" && outlookCalendarEnabled()) return outlookCalendarActions;
  // ICLOUD and NAVER (step C3, CalDAV) likewise, behind CALDAV_CALENDAR_ENABLED.
  if ((provider === "ICLOUD" || provider === "NAVER") && caldavCalendarEnabled()) {
    return CALDAV_ACTIONS[provider];
  }
  return ACTIONS_BY_PROVIDER[provider];
}

/**
 * The primary calendar's session, or null when Google is not connected. The
 * primary login is always Google, so the `unsupported` result cannot occur here.
 */
export async function connectPrimaryCalendar(userId: string): Promise<CalendarSession | null> {
  const session = await googleCalendarActions.connect({ userId, linkedAccountId: null });
  return session && !isCalendarUnsupported(session) ? session : null;
}

/**
 * Every linked calendar account of the user, of every provider, oldest first, as
 * full rows: the one read a conflict check or a sync pays, which also hands each
 * provider the credentials it connects with.
 */
export async function listLinkedCalendarAccounts(userId: string): Promise<LinkedCalendarAccount[]> {
  return prisma.linkedCalendarAccount.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });
}

/** A linked calendar account with a live session. */
export interface ConnectedLinkedCalendar {
  readonly id: string;
  readonly email: string;
  readonly session: CalendarSession;
}

/**
 * Open a session on each of the user's linked calendar accounts, dispatching on
 * the provider already read with the list: a provider with no implementation yet
 * answers unsupported and its account is skipped, and so is one whose token is
 * unusable. `skipNeedsReconnect` leaves out accounts flagged for a re-link: the
 * sync does not retry a revoked token every cycle, while conflict checks still
 * try it (a successful refresh clears the flag). One read in total plus, per
 * account, the token decrypt.
 */
export async function connectLinkedCalendars(
  userId: string,
  options: { skipNeedsReconnect: boolean },
): Promise<ConnectedLinkedCalendar[]> {
  const accounts = await listLinkedCalendarAccounts(userId);
  const connected: ConnectedLinkedCalendar[] = [];
  for (const account of accounts) {
    if (options.skipNeedsReconnect && account.needsReconnect) continue;
    const actions = calendarActionsForProvider(account.provider);
    const session = await actions.connect({ userId, linkedAccountId: account.id, linked: account });
    if (session && !isCalendarUnsupported(session)) {
      connected.push({ id: account.id, email: account.email, session });
    }
  }
  return connected;
}
