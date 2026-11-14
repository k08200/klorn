/**
 * Meeting prep (Context Engine slice 1): for each of the user's meetings in
 * the next 24 hours that has external attendees, what to review first — open
 * commitments with them, their unanswered mail, recent threads — ranked and
 * capped by context/meeting-prep-link.ts. Behind CONTEXT_MEETING_PREP_ENABLED
 * (off / cohort / on; see meeting-prep-surface.ts).
 *
 * Reads only the caller's own rows (every query is scoped to `userId`) and the
 * caller's own calendar listing; nothing crosses users. No model call: every
 * item is a stored fact with its source. Cost per build: no meeting in the
 * window means one calendar row read and nothing else; otherwise one provider
 * listing per calendar source (cached, see meeting-prep-attendees.ts), the
 * user's own addresses, and — only when a meeting has an external attendee —
 * one mail query, the reply-state reads for that mail, and one commitment query.
 */

import type { MeetingPrepBlock } from "@klorn/contract";
import { prisma } from "../db.js";
import { escapeLikePattern } from "../db-like.js";
import { lastReplyByThread } from "../mail/thread-last-reply.js";
import { readCalendarRows } from "../pim/calendar-read.js";
import { loadOwnAddresses } from "../pim/coattendance/coattendance-store.js";
import { isConfirmedCommitment } from "../pim/commitment-confirmation.js";
import { LISTING_SLACK_MS, upcomingAttendees } from "./meeting-prep-attendees.js";
import {
  buildPrepBlock,
  type Counterparts,
  externalCounterparts,
  type OwnIdentity,
  ownIdentityOf,
  PREP_HORIZON_MS,
  type PrepCommitment,
  type PrepMail,
  type PrepMeetingInput,
} from "./meeting-prep-link.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Recent threads: mail from the attendees in this window. */
const MAIL_LOOKBACK_MS = 14 * DAY_MS;
/** A dated commitment stops counting this long after its deadline. */
const COMMITMENT_DUE_LOOKBACK_MS = 14 * DAY_MS;
/** An undated commitment counts this long after it was recorded. */
const UNDATED_COMMITMENT_LOOKBACK_MS = 30 * DAY_MS;
/** Calendar rows read; MAX_MEETINGS_PER_BLOCK of them can make the block. */
const EVENT_SCAN = 40;
const MAIL_SCAN = 200;
const COMMITMENT_SCAN = 100;
const EXCLUDED_LABELS = ["SPAM", "TRASH"];

function senderFilter(field: "fromAddress" | "counterpartyEmail", c: Counterparts) {
  return [
    { [field]: { in: [...c.addresses] } },
    ...c.domains.map((domain) => ({ [field]: { endsWith: escapeLikePattern(`@${domain}`) } })),
  ];
}

interface MailRow {
  readonly id: string;
  readonly threadId: string | null;
  readonly receivedAt: Date;
  readonly needsReply: boolean;
  readonly repliedAt: Date | null;
}

/**
 * Which of the mail that wants a reply is still unanswered: no reply anywhere
 * in its thread since it arrived, not archived or dismissed, and its attention
 * item (if any) still open — the evening review's rule.
 */
async function openMailIds(
  userId: string,
  rows: readonly MailRow[],
  since: Date,
): Promise<Set<string>> {
  const asking = rows.filter((row) => row.needsReply && !row.repliedAt);
  if (asking.length === 0) return new Set();
  const askingIds = asking.map((row) => row.id);
  const [labels, attention] = await Promise.all([
    prisma.decisionLabel.findMany({
      where: { userId, source: "EMAIL", sourceId: { in: rows.map((row) => row.id) } },
      select: {
        sourceId: true,
        repliedAt: true,
        providerRepliedAt: true,
        archivedAt: true,
        providerArchivedAt: true,
        dismissedAt: true,
      },
    }),
    prisma.attentionItem.findMany({
      where: { userId, source: "EMAIL", sourceId: { in: askingIds } },
      select: { sourceId: true, status: true },
    }),
  ]);
  const ledger = new Map(labels.map((label) => [label.sourceId, label]));
  const closed = new Set(attention.filter((a) => a.status !== "OPEN").map((a) => a.sourceId));
  const lastReply = await lastReplyByThread(
    userId,
    rows,
    ledger,
    new Map(rows.map((row) => [row.id, row.repliedAt])),
    since,
  );
  const open = new Set<string>();
  for (const row of asking) {
    const label = ledger.get(row.id);
    if (label?.archivedAt || label?.providerArchivedAt || label?.dismissedAt) continue;
    if (closed.has(row.id)) continue;
    if ((lastReply.get(row.threadId ?? row.id) ?? 0) >= row.receivedAt.getTime()) continue;
    open.add(row.id);
  }
  return open;
}

async function readMail(userId: string, c: Counterparts, now: Date): Promise<PrepMail[]> {
  const since = new Date(now.getTime() - MAIL_LOOKBACK_MS);
  const rows = await prisma.emailMessage.findMany({
    where: {
      userId,
      receivedAt: { gte: since, lte: now },
      OR: senderFilter("fromAddress", c),
      // Mailings and junk never compete for the scan cap.
      listUnsubscribeUrl: null,
      listUnsubscribeMailto: null,
      NOT: { labels: { hasSome: EXCLUDED_LABELS } },
    },
    select: {
      id: true,
      threadId: true,
      from: true,
      fromAddress: true,
      subject: true,
      receivedAt: true,
      needsReply: true,
      repliedAt: true,
    },
    orderBy: { receivedAt: "desc" },
    take: MAIL_SCAN,
  });
  const open = await openMailIds(userId, rows, since);
  return rows.map((row) => ({
    id: row.id,
    threadId: row.threadId,
    from: row.from,
    fromAddress: row.fromAddress,
    subject: row.subject,
    receivedAt: row.receivedAt,
    open: open.has(row.id),
    bulk: false,
  }));
}

/**
 * Open commitments with the counterparts, or recorded in a thread of their mail
 * (the user's own promises have no counterparty address), soonest deadline first.
 */
async function readCommitments(
  userId: string,
  c: Counterparts,
  threadIds: readonly string[],
  now: Date,
): Promise<PrepCommitment[]> {
  const rows = await prisma.commitment.findMany({
    where: {
      userId,
      status: "OPEN",
      owner: { in: ["USER", "COUNTERPARTY"] },
      OR: [
        ...senderFilter("counterpartyEmail", c),
        ...(threadIds.length > 0 ? [{ threadId: { in: [...threadIds] } }] : []),
      ],
      AND: [
        {
          OR: [
            { dueAt: { gte: new Date(now.getTime() - COMMITMENT_DUE_LOOKBACK_MS) } },
            {
              dueAt: null,
              createdAt: { gte: new Date(now.getTime() - UNDATED_COMMITMENT_LOOKBACK_MS) },
            },
          ],
        },
      ],
    },
    select: {
      id: true,
      title: true,
      owner: true,
      counterpartyEmail: true,
      counterpartyName: true,
      dueAt: true,
      createdAt: true,
      confidence: true,
      confirmedAt: true,
      threadId: true,
    },
    orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
    take: COMMITMENT_SCAN,
  });
  return rows.flatMap((row) =>
    row.owner === "USER" || row.owner === "COUNTERPARTY"
      ? [
          {
            id: row.id,
            title: row.title,
            owner: row.owner,
            counterpartyEmail: row.counterpartyEmail,
            counterpartyName: row.counterpartyName,
            dueAt: row.dueAt,
            createdAt: row.createdAt,
            confirmed: isConfirmedCommitment(row),
            threadId: row.threadId,
          },
        ]
      : [],
  );
}

async function readMeetings(userId: string, now: Date): Promise<PrepMeetingInput[]> {
  const rows = await readCalendarRows({
    userId,
    when: {
      // The slack keeps a reused attendee listing covering meetings that enter
      // the horizon meanwhile; the linker still preps only the next 24 hours.
      startTime: { gte: now, lt: new Date(now.getTime() + PREP_HORIZON_MS + LISTING_SLACK_MS) },
      allDay: false,
    },
    limit: EVENT_SCAN,
  });
  if (rows.length === 0) return [];
  const attendees = await upcomingAttendees(userId, rows, now);
  return rows.flatMap((row) => {
    const meeting = attendees.get(row.id);
    if (!meeting) return [];
    return [
      {
        eventId: row.id,
        title: row.title,
        // The row's times: the user's calendar as Klorn shows it.
        startTime: row.startTime,
        endTime: row.endTime,
        cancelled: meeting.cancelled,
        attendeesOmitted: meeting.attendeesOmitted,
        organizedBySelf: meeting.organizedBySelf,
        attendees: meeting.attendees,
      },
    ];
  });
}

/** Every external address and domain across the meetings; empty when none qualifies. */
function unionCounterparts(
  meetings: readonly PrepMeetingInput[],
  own: OwnIdentity,
  now: Date,
): Counterparts {
  const addresses = new Set<string>();
  const domains = new Set<string>();
  for (const meeting of meetings) {
    const c = externalCounterparts(meeting, own, now);
    for (const address of c?.addresses ?? []) addresses.add(address);
    for (const domain of c?.domains ?? []) domains.add(domain);
  }
  return { addresses: [...addresses], domains: [...domains] };
}

/**
 * The prep block for the next 24 hours, or null when there is nothing to prep.
 * Throws on a database error; a calendar provider failure means no meeting.
 */
export async function buildMeetingPrep(
  userId: string,
  now: Date,
): Promise<MeetingPrepBlock | null> {
  const meetings = await readMeetings(userId, now);
  if (meetings.length === 0) return null;
  const own = ownIdentityOf(await loadOwnAddresses(userId));
  const counterparts = unionCounterparts(meetings, own, now);
  if (counterparts.addresses.length === 0) return null;
  const mail = await readMail(userId, counterparts, now);
  const threadIds = [...new Set(mail.flatMap((m) => (m.threadId ? [m.threadId] : [])))];
  const commitments = await readCommitments(userId, counterparts, threadIds, now);
  const block = buildPrepBlock(meetings, { mail, commitments }, own, now);
  return block.meetings.length > 0 ? block : null;
}
