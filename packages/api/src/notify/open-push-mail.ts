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
 */

import { prisma } from "../db.js";
import { resolveTierReason } from "../judge/tier-reason-strings.js";
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
