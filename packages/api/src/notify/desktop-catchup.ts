/**
 * Catch-up for the Windows desktop shell (decision N6, LOCKED 2026-11-08).
 *
 * A live `notification` frame sent while the shell was quit, asleep or offline
 * is lost (websocket.ts keeps no replay). On its next bell refetch the shell
 * asks here about the urgent-mail bell rows it has not announced yet, and gets
 * back the ones that still deserve a toast:
 *   - an urgent-mail bell row of this user (any language's title), naming one
 *     mail (sourceEmailId), unread, from the last 72 hours;
 *   - whose mail is still an OPEN PUSH item and not read in the mailbox
 *     (handled, moved, archived or already-read mail never toasts late);
 *   - shaped like every other mail notification (decision N1,
 *     mail-push-content.ts).
 * The last two are open-push-mail.ts, shared with the server's quiet-hours
 * summary (quiet-hours-summary.ts).
 * The same gate a live frame passes decides: a category opt-out returns
 * nothing, quiet hours return `held` so the shell waits and asks again later.
 * The shell keeps the once-per-id ledger and decides one toast vs. a summary
 * (packages/web lib/native/desktop-push-catchup.ts).
 */

import type { DesktopCatchUpResponse } from "@klorn/contract";
import { prisma } from "../db.js";
import { evaluateNotificationGate } from "./notification-prefs.js";
import { getUserNotificationLanguage, notificationCopy } from "./notification-strings.js";
import { openPushMail, unreadUrgentMailRows } from "./open-push-mail.js";

/** Only PUSH mail from the last 72 hours is caught up (decision N6). */
export const DESKTOP_CATCHUP_WINDOW_MS = 72 * 60 * 60 * 1000;
/** The bell fetches 30 rows; one question never names more. */
export const DESKTOP_CATCHUP_MAX_IDS = 30;
const ID_MAX = 64;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** The bell row ids in `?ids=a,b,c`, or null when the list is malformed. */
export function parseCatchUpIds(raw: unknown): string[] | null {
  if (typeof raw !== "string") return null;
  if (raw.trim() === "") return [];
  const ids = [...new Set(raw.split(",").map((id) => id.trim()))];
  if (ids.length > DESKTOP_CATCHUP_MAX_IDS) return null;
  const valid = ids.every((id) => id.length > 0 && id.length <= ID_MAX && ID_PATTERN.test(id));
  return valid ? ids : null;
}

export async function desktopCatchUp(
  userId: string,
  ids: readonly string[],
  now: Date = new Date(),
): Promise<DesktopCatchUpResponse> {
  const language = await getUserNotificationLanguage(userId);
  const summaryTitle = notificationCopy(language).missedWhileClosed("{count}");
  if (ids.length === 0) return { held: false, summaryTitle, items: [] };

  const gate = await evaluateNotificationGate(userId, "email_urgent", now);
  if (!gate.allowed) {
    return { held: gate.reason === "quiet_hours", summaryTitle, items: [] };
  }

  const rows = await prisma.notification.findMany({
    where: {
      ...unreadUrgentMailRows(userId),
      id: { in: [...ids] },
      createdAt: { gte: new Date(now.getTime() - DESKTOP_CATCHUP_WINDOW_MS) },
    },
    select: { id: true, sourceEmailId: true, createdAt: true },
  });
  // Mail already read in the mailbox (Gmail, or a bulk mark-read that leaves
  // the bell row unread) was seen: no late toast for it, as on the Mac
  // (HeldBanners) and in the quiet-hours summary.
  const mail = await openPushMail(userId, rows, language, { skipReadMail: true });
  const items = mail.map((m) => ({
    id: m.bellId,
    emailId: m.emailId,
    title: m.title,
    body: m.body,
    createdAt: m.createdAt.toISOString(),
  }));
  return { held: false, summaryTitle, items };
}
