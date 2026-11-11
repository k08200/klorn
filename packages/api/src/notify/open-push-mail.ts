/**
 * Which urgent-mail bell rows still deserve an alert (decision N6): the row
 * names one mail and is unread, and that mail is still an OPEN PUSH item —
 * handled, moved or archived mail never rings late. Each is shaped like every
 * other mail notification (decision N1, mail-push-content.ts).
 *
 * Shared by the Windows shell's catch-up (desktop-catchup.ts) and the server's
 * quiet-hours summary (quiet-hours-summary.ts), so both count the same mail.
 * The summary also skips mail already read (`skipReadMail`), as the Mac does;
 * the Windows catch-up does not ask for that and is unchanged.
 *
 * The urgent sweep reads the same lane rule (openPushItemIdsFailClosed): it rings
 * only mail that is an open PUSH item.
 */

import { prisma } from "../db.js";
import { resolveTierReason } from "../judge/tier-reason-strings.js";
import { describeFailure } from "../mail/providers/action-failure.js";
import { captureError } from "../sentry.js";
import { mailPushContent } from "./mail-push-content.js";
import { type NotificationLanguage, URGENT_EMAIL_TITLES } from "./notification-strings.js";

/** Lanes that ring as PUSH; "CALL" is the retired v1 name normalizeTier folds. */
const PUSH_TIERS = ["PUSH", "CALL"];

/** Urgent-mail bell rows (any language's title), unread, naming one mail. */
export function unreadUrgentMailRows(userId: string) {
  return {
    userId,
    type: "email",
    title: { in: [...URGENT_EMAIL_TITLES] },
    isRead: false,
    sourceEmailId: { not: null },
  };
}

export interface UrgentBellRow {
  id: string;
  sourceEmailId: string | null;
  createdAt: Date;
}

export interface OpenPushMail {
  /** The bell row id: the id the live frame carried. */
  bellId: string;
  emailId: string;
  attentionItemId: string;
  title: string;
  body: string;
  createdAt: Date;
}

/** The rows whose mail is still an open PUSH item, in N1 shape, newest first. */
export async function openPushMail(
  userId: string,
  rows: readonly UrgentBellRow[],
  language: NotificationLanguage,
  options: { skipReadMail?: boolean } = {},
): Promise<OpenPushMail[]> {
  const emailIds = [...new Set(rows.flatMap((r) => (r.sourceEmailId ? [r.sourceEmailId] : [])))];
  if (emailIds.length === 0) return [];

  const [openItems, emails] = await Promise.all([
    prisma.attentionItem.findMany({
      where: {
        userId,
        source: "EMAIL",
        sourceId: { in: emailIds },
        status: "OPEN",
        tier: { in: PUSH_TIERS },
      },
      select: { id: true, sourceId: true, tierReason: true },
    }),
    prisma.emailMessage.findMany({
      where: { userId, id: { in: emailIds }, ...(options.skipReadMail ? { isRead: false } : {}) },
      select: { id: true, from: true, subject: true },
    }),
  ]);
  const itemByEmail = new Map(openItems.map((i) => [i.sourceId, i]));
  const emailById = new Map(emails.map((e) => [e.id, e]));

  const mail: OpenPushMail[] = [];
  for (const row of rows) {
    const emailId = row.sourceEmailId;
    const email = emailId ? emailById.get(emailId) : undefined;
    const item = emailId ? itemByEmail.get(emailId) : undefined;
    if (!emailId || !email || !item) continue;
    const content = mailPushContent({
      from: email.from ?? "",
      subject: email.subject,
      reason: resolveTierReason(item.tierReason ?? null, language),
      language,
    });
    mail.push({
      bellId: row.id,
      emailId,
      attentionItemId: item.id,
      createdAt: row.createdAt,
      ...content,
    });
  }
  return mail.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** Whether openPushItemIdsFailClosed has reported a failed lookup in this process. */
let laneLookupFailureReported = false;

/**
 * The mail among `emailIds` that is an OPEN PUSH item now, mapped to that item's
 * id, in one query. The urgent sweep (automation-scheduler.ts) rings only this
 * mail: the keyword priority never outranks the judge's lane, so mail the judge
 * put in another lane never rings from the sweep, and mail the judge has not
 * reached yet waits for the judge's own push (email-firewall.ts rings PUSH, and
 * MEETING, when the item lands).
 *
 * Fail closed: on a failed lookup no mail counts (nothing rings; the next sync
 * reads again). The failure is never thrown, so the rest of the user's tick still
 * runs, and it is reported once per process (as findReingestedHistoryFailClosed
 * does), so a database incident is not one report per user per tick.
 */
export async function openPushItemIdsFailClosed(
  userId: string,
  emailIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (emailIds.length === 0) return new Map();
  try {
    const items = await prisma.attentionItem.findMany({
      where: {
        userId,
        source: "EMAIL",
        sourceId: { in: [...emailIds] },
        status: "OPEN",
        tier: { in: PUSH_TIERS },
      },
      select: { id: true, sourceId: true },
    });
    return new Map(items.map((item) => [item.sourceId, item.id]));
  } catch (err) {
    if (!laneLookupFailureReported) {
      laneLookupFailureReported = true;
      // describeFailure: the error's class and code only, never a message that
      // could quote the query's arguments.
      console.warn(
        `[urgent-sweep] lane lookup failed for ${userId}; no urgent mail rings this time: ${describeFailure(err)}`,
      );
      captureError(err, { tags: { scope: "automation.urgent-lane" }, extra: { userId } });
    }
    return new Map();
  }
}
