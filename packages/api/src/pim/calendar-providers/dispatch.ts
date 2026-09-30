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
