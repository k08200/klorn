/**
 * Which urgent-mail bell rows still deserve an alert (decision N6): the row
 * names one mail and is unread, and that mail is still an OPEN PUSH item —
 * handled, moved or archived mail never rings late. Each is shaped like every
 * other mail notification (decision N1, mail-push-content.ts).
 *
 * Shared by the Windows shell's catch-up (desktop-catchup.ts) and the server's
 * quiet-hours summary (quiet-hours-summary.ts), so both count the same mail.
 * Both skip mail already read (`skipReadMail`), as the Mac does.
 *
 * The urgent sweep (urgentSweepItemIdsFailClosed) rings open PUSH items too, and one
 * more case these readers do not count: urgent mail the keyword fallback left in
 * QUEUE because the judge's LLM did not run. A held push of such mail is therefore
 * not caught up after quiet hours or by the Windows shell (as before #1687).
 */

import type { NotificationReason } from "@klorn/contract";
import { prisma } from "../db.js";
import { NOT_AGENT_SET } from "../judge/agent-tier.js";
import { isAutomatedSender } from "../judge/keyword-policy.js";
import type { PocJudgement } from "../judge/poc-judge.js";
import { isJudgeV3PolicyEnabled } from "../judge/v3/flags.js";
import { describeFailure } from "../mail/providers/action-failure.js";
import { captureError } from "../sentry.js";
import { type MailPushContent, mailPushContent } from "./mail-push-content.js";
import {
  type MailForReason,
  REASON_ITEM_SELECT,
  type ReasonItemRow,
  reasonsForMail,
} from "./notification-reason.js";
import { type NotificationLanguage, URGENT_EMAIL_TITLES } from "./notification-strings.js";

/** Lanes that ring as PUSH; "CALL" is the retired v1 name normalizeTier folds. */
const PUSH_TIERS = ["PUSH", "CALL"];

/**
 * The decision ledger's mark for the judge's no-LLM path (poc-judge.ts,
 * keywordFallbackJudgement): the LLM did not judge the mail (outage, spend cap,
 * unusable key), keywords did. The other non-LLM sources are not that path: the
 * marketing fast-path, the user's pin and learned rule, and the sender prior run
 * before the LLM whatever its health, and the prior and the learned rule defer
 * urgent-looking mail to the LLM.
 */
const KEYWORD_FALLBACK: PocJudgement["source"] = "keyword-fallback";

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
      select: { id: true, sourceId: true, ...REASON_ITEM_SELECT },
    }),
    prisma.emailMessage.findMany({
      where: { userId, id: { in: emailIds }, ...(options.skipReadMail ? { isRead: false } : {}) },
      select: { id: true, from: true, subject: true },
    }),
  ]);
  const itemByEmail = new Map(openItems.map((i) => [i.sourceId, i]));
  const emailById = new Map(emails.map((e) => [e.id, e]));
  // Why each rang, the same rule as the live push (notification-reason.ts).
  const reasons = await reasonsOrNone(
    userId,
    emails.filter((e) => itemByEmail.has(e.id)).map((e) => ({ id: e.id, subject: e.subject })),
    itemByEmail,
    language,
  );

  const mail: OpenPushMail[] = [];
  for (const row of rows) {
    const emailId = row.sourceEmailId;
    const email = emailId ? emailById.get(emailId) : undefined;
    const item = emailId ? itemByEmail.get(emailId) : undefined;
    if (!emailId || !email || !item) continue;
    const content = mailPushContent({
      from: email.from ?? "",
      subject: email.subject,
      reason: reasons.get(emailId) ?? null,
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

type LaneLookup = "item" | "ledger";

/** The lane lookups whose failure the urgent sweep has reported in this process. */
const reportedLookupFailures = new Set<LaneLookup>();

/**
 * Report a failed lane lookup once per process and per lookup (as
 * findReingestedHistoryFailClosed does), so a database incident is not one report
 * per user per tick, and an early item-read blip does not hide a later ledger
 * failure that silences the fallback ring.
 */
function reportLaneLookupFailure(lookup: LaneLookup, userId: string, err: unknown): void {
  if (reportedLookupFailures.has(lookup)) return;
  reportedLookupFailures.add(lookup);
  // describeFailure: the error's class and code only, never a message that
  // could quote the query's arguments.
  console.warn(
    `[urgent-sweep] ${lookup} lookup failed for ${userId}; mail it could not check does not ring this time: ${describeFailure(err)}`,
  );
  captureError(err, { tags: { scope: "automation.urgent-lane" }, extra: { userId, lookup } });
}

/** An urgent mail the sweep is considering: its id and its sender. */
export interface UrgentSweepMail {
  id: string;
  from: string | null;
}

/**
 * The mail among `mail` the urgent sweep (automation-scheduler.ts) may ring,
 * mapped to its OPEN item's id. The keyword priority never outranks the judge's
 * lane, so it is:
 *  - mail whose OPEN item is PUSH: a safety net for PUSH mail the firewall push
 *    did not ring;
 *  - mail the keyword fallback put in QUEUE (DecisionLabel.decidedBy
 *    "keyword-fallback"): the judge's LLM did not run for it (outage, spend cap,
 *    unusable key), and the fallback cannot score an urgent mail from an
 *    ordinary person to PUSH, so without this nothing would ring it. Only while
 *    that lane is still the fallback's: no human override or confirmation
 *    (isManualOverride, the ledger outcome) and no MCP agent move
 *    (NOT_AGENT_SET). An LLM re-judge rewrites decidedBy (fallback-rejudge.ts),
 *    and the mail stops counting. Never mail from an automated sender: the
 *    fallback's own floor keeps that from interrupting (poc-judge.ts,
 *    applyAutomatedSenderPushFloor), and the ledger records the source, not
 *    the floor.
 * MEETING, INFO and SILENT mail never rings here, whoever decided it. Mail the
 * judge has not reached yet waits for the judge's own push (email-firewall.ts
 * rings PUSH, and MEETING, when the item lands).
 *
 * One item read for the batch, plus one ledger read only when some of that mail
 * sits in QUEUE. Fail closed: a failed item read counts no mail, a failed ledger
 * read counts only the PUSH mail (the next sync reads again). Never thrown, so
 * the rest of the user's tick still runs.
 */
export async function urgentSweepItemIdsFailClosed(
  userId: string,
  mail: readonly UrgentSweepMail[],
): Promise<ReadonlyMap<string, string>> {
  if (mail.length === 0) return new Map();
  let items: Array<{ id: string; sourceId: string; tier: string | null }>;
  try {
    items = await prisma.attentionItem.findMany({
      where: {
        userId,
        source: "EMAIL",
        sourceId: { in: mail.map((m) => m.id) },
        status: "OPEN",
        OR: [
          { tier: { in: PUSH_TIERS } },
          { tier: "QUEUE", isManualOverride: false, ...NOT_AGENT_SET },
        ],
      },
      select: { id: true, sourceId: true, tier: true },
    });
  } catch (err) {
    reportLaneLookupFailure("item", userId, err);
    return new Map();
  }

  const humanSent = new Set(mail.filter((m) => !isAutomatedSender(m.from ?? "")).map((m) => m.id));
  const pushItems = items.filter((item) => item.tier !== null && PUSH_TIERS.includes(item.tier));
  const queueItems = items.filter((item) => item.tier === "QUEUE" && humanSent.has(item.sourceId));
  const fallbackIds = await keywordFallbackSourceIds(
    userId,
    queueItems.map((item) => item.sourceId),
  );
  const ringable = [...pushItems, ...queueItems.filter((item) => fallbackIds.has(item.sourceId))];
  return new Map(ringable.map((item) => [item.sourceId, item.id]));
}

/**
 * The mail among `sourceIds` whose lane the keyword fallback set and nobody has
 * judged since (ledger outcome still null, as fallback-rejudge.ts reads it). No
 * read when there is nothing to look up. Fail closed: a failed read counts none.
 */
async function keywordFallbackSourceIds(
  userId: string,
  sourceIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (sourceIds.length === 0) return new Set();
  try {
    const labels = await prisma.decisionLabel.findMany({
      where: {
        userId,
        source: "EMAIL",
        sourceId: { in: [...sourceIds] },
        decidedBy: KEYWORD_FALLBACK,
        outcome: null,
      },
      select: { sourceId: true },
    });
    return new Set(labels.map((row) => row.sourceId));
  } catch (err) {
    reportLaneLookupFailure("ledger", userId, err);
    return new Set();
  }
}

/**
 * The content of the urgent sweep's push about ONE mail: the same formatter
 * and reason rule as the firewall ring (mail-push-content.ts,
 * notification-reason.ts), so every surface says the same thing. The reason
 * comes from the mail's open item; a failed read rings without a reason line
 * rather than not at all, and is reported.
 */
/**
 * Reasons for these mails; on a failed read none (reported), so the mail
 * still rings, without a reason line, exactly as it would have before.
 */
async function reasonsOrNone(
  userId: string,
  mails: readonly MailForReason[],
  items: ReadonlyMap<string, ReasonItemRow>,
  language: string,
): Promise<ReadonlyMap<string, NotificationReason | null>> {
  try {
    return await reasonsForMail(userId, mails, items, {
      language,
      now: new Date(),
      policyUser: isJudgeV3PolicyEnabled(userId),
    });
  } catch (err) {
    console.warn(
      `[NOTIFY] reason lookup failed for ${userId}; ringing without a reason line: ${describeFailure(err)}`,
    );
    captureError(err, { tags: { scope: "notify.mail-reason" }, extra: { userId } });
    return new Map();
  }
}

export async function urgentLeadPushContent(
  userId: string,
  lead: { id: string; from: string | null; subject: string | null },
  language: string,
): Promise<MailPushContent> {
  let items: Array<{ sourceId: string } & ReasonItemRow> = [];
  try {
    items = await prisma.attentionItem.findMany({
      where: { userId, source: "EMAIL", sourceId: { in: [lead.id] }, status: "OPEN" },
      select: { sourceId: true, ...REASON_ITEM_SELECT },
    });
  } catch (err) {
    console.warn(
      `[urgent-sweep] reason lookup failed for ${userId}; ringing without a reason line: ${describeFailure(err)}`,
    );
    captureError(err, { tags: { scope: "automation.urgent-reason" }, extra: { userId } });
  }
  const reasons = await reasonsOrNone(
    userId,
    [{ id: lead.id, subject: lead.subject }],
    new Map(items.map((item) => [item.sourceId, item])),
    language,
  );
  const reason = reasons.get(lead.id) ?? null;
  return mailPushContent({ from: lead.from ?? "", subject: lead.subject, reason, language });
}
