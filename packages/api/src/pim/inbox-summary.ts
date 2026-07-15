/**
 * Server-side ranking for the inbox Command Center summary.
 *
 * Top 3 reads from the AttentionItem queue: rows with status=OPEN, ordered
 * by priority desc then surfacedAt desc. Each row is mapped back to its
 * source (PendingAction / Task / CalendarEvent / Notification) for the
 * display metadata the UI still needs.
 *
 * The "today" section stays as a separate snapshot read — overdue tasks,
 * today-due tasks, today's events. It's a calendar view, not a queue, so
 * AttentionItem is the wrong substrate for it.
 */

import { resolveActionTarget } from "../agentcore/action-target.js";
import {
  upsertAttentionForCalendarEvent,
  upsertAttentionForCommitment,
  upsertAttentionForNotification,
  upsertAttentionForPendingAction,
  upsertAttentionForTask,
} from "../attention-mirror.js";
import { prisma } from "../db.js";
import { captureError } from "../sentry.js";

export interface TaskInput {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueDate: string | null;
}

export interface EventInput {
  id: string;
  title: string;
  startTime: string;
  endTime?: string;
  location?: string | null;
}

export type AttentionItem =
  | {
      kind: "pending_action";
      id: string;
      toolName: string;
      label: string;
      conversationId: string;
      reasoning: string | null;
      decision: DecisionDetails;
    }
  | {
      kind: "overdue_task";
      id: string;
      title: string;
      dueDate: string;
      daysOverdue: number;
      decision: DecisionDetails;
    }
  | {
      kind: "today_event";
      id: string;
      title: string;
      startTime: string;
      minutesAway: number;
      location: string | null;
      decision: DecisionDetails;
    }
  | {
      kind: "agent_proposal";
      id: string;
      title: string;
      message: string;
      link: string | null;
      decision: DecisionDetails;
    }
  | {
      kind: "commitment";
      id: string;
      title: string;
      description: string | null;
      commitmentKind: string;
      owner: string;
      dueAt: string | null;
      dueText: string | null;
      confidence: number;
      attentionType: "COMMITMENT_DUE" | "COMMITMENT_OVERDUE" | "COMMITMENT_UNCONFIRMED";
      decision: DecisionDetails;
    };

export interface DecisionEvidenceFact {
  label: string;
  value: string;
}

export interface DecisionDetails {
  priority: number;
  confidence: number;
  suggestedAction: string | null;
  costOfIgnoring: string | null;
  evidence: DecisionEvidenceFact[];
}

export interface TodaySection {
  events: EventInput[];
  overdueTasks: TaskInput[];
  todayTasks: TaskInput[];
}

export interface InboxSummary {
  top3: AttentionItem[];
  today: TodaySection;
}

const TOP_LIMIT = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

function startOfToday(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function endOfToday(now: number): number {
  return startOfToday(now) + DAY_MS;
}

function dueDateMs(t: TaskInput): number | null {
  if (!t.dueDate) return null;
  const ms = new Date(t.dueDate).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function isOverdue(t: TaskInput, now: number): boolean {
  const due = dueDateMs(t);
  if (due === null) return false;
  return due < startOfToday(now);
}

function isDueToday(t: TaskInput, now: number): boolean {
  const due = dueDateMs(t);
  if (due === null) return false;
  return due >= startOfToday(now) && due < endOfToday(now);
}

function isTodayEvent(e: EventInput, now: number): boolean {
  const start = new Date(e.startTime).getTime();
  if (!Number.isFinite(start)) return false;
  return start >= startOfToday(now) && start < endOfToday(now);
}

/**
 * Bundle the "오늘 봐야 할 것" section. Events for today, overdue tasks, and
 * today-due tasks — each pre-sorted, with no overlap between overdue and today.
 */
export function buildTodaySection(input: {
  tasks: TaskInput[];
  events: EventInput[];
  now?: number;
}): TodaySection {
  const now = input.now ?? Date.now();
  const events = input.events
    .filter((e) => isTodayEvent(e, now))
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  const overdueTasks = input.tasks
    .filter((t) => t.status !== "DONE" && isOverdue(t, now))
    .sort((a, b) => (dueDateMs(a) ?? 0) - (dueDateMs(b) ?? 0));
  const todayTasks = input.tasks
    .filter((t) => t.status !== "DONE" && isDueToday(t, now))
    .sort((a, b) => (dueDateMs(a) ?? 0) - (dueDateMs(b) ?? 0));
  return { events, overdueTasks, todayTasks };
}

// ─── Queue read helpers ────────────────────────────────────────────────────

type AttentionRow = {
  id: string;
  source: "PENDING_ACTION" | "TASK" | "CALENDAR_EVENT" | "NOTIFICATION" | "COMMITMENT";
  sourceId: string;
  type: string;
  priority: number;
  confidence: number;
  suggestedAction: string | null;
  costOfIgnoring: string | null;
  evidence: unknown;
};

type PendingActionRow = {
  id: string;
  userId: string;
  conversationId: string;
  status: string;
  toolName: string;
  // JSONB after migration 20260519060000; legacy callers may still pass strings.
  toolArgs: unknown;
  reasoning: string | null;
  createdAt: Date;
};

type TaskRow = {
  id: string;
  userId: string;
  title: string;
  status: string;
  priority: string;
  dueDate: Date | null;
};

type CalendarEventRow = {
  id: string;
  userId: string;
  title: string;
  startTime: Date;
  endTime: Date;
  location: string | null;
};

type NotificationRow = {
  id: string;
  type: string;
  title: string;
  message: string;
  isRead: boolean;
  link: string | null;
  pendingActionId: string | null;
};

type CommitmentRow = {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  status: string;
  kind: string;
  owner: string;
  dueAt: Date | null;
  dueText: string | null;
  confidence: number;
};

function decisionFromRow(row: AttentionRow): DecisionDetails {
  return {
    priority: row.priority,
    confidence: row.confidence,
    suggestedAction: row.suggestedAction,
    costOfIgnoring: row.costOfIgnoring,
    evidence: evidenceFacts(row.evidence),
  };
}

function evidenceFacts(value: unknown): DecisionEvidenceFact[] {
  if (!value || typeof value !== "object") return [];
  const facts = (value as { facts?: unknown }).facts;
  if (!Array.isArray(facts)) return [];
  return facts
    .map((fact) => {
      if (!fact || typeof fact !== "object") return null;
      const row = fact as { label?: unknown; value?: unknown };
      if (typeof row.label !== "string" || typeof row.value !== "string") return null;
      return { label: row.label, value: row.value };
    })
    .filter((fact): fact is DecisionEvidenceFact => fact !== null)
    .slice(0, 4);
}

async function buildPendingItem(
  row: AttentionRow,
  pa: PendingActionRow,
): Promise<AttentionItem | null> {
  if (pa.status !== "PENDING") return null;
  let targetLabel: string | null = null;
  try {
    // toolArgs is JSONB after migration 20260519060000 (already parsed),
    // but legacy rows can still be JSON strings — handle both.
    const parsed =
      typeof pa.toolArgs === "string"
        ? (JSON.parse(pa.toolArgs) as Record<string, unknown>)
        : ((pa.toolArgs ?? {}) as Record<string, unknown>);
    targetLabel = await resolveActionTarget(pa.toolName, parsed);
  } catch {
    // Malformed toolArgs — leave label null
  }
  const baseLabel = pa.toolName.replace(/_/g, " ");
  return {
    kind: "pending_action",
    id: pa.id,
    toolName: pa.toolName,
    label: targetLabel ? `${baseLabel}: ${targetLabel}` : baseLabel,
    conversationId: pa.conversationId,
    reasoning: pa.reasoning,
    decision: decisionFromRow(row),
  };
}

function buildOverdueTaskItem(row: AttentionRow, task: TaskRow, now: number): AttentionItem | null {
  if (task.status === "DONE" || !task.dueDate) return null;
  const due = task.dueDate.getTime();
  if (!Number.isFinite(due)) return null;
  if (due >= startOfToday(now)) return null; // not overdue
  const daysOverdue = Math.max(1, Math.floor((startOfToday(now) - due) / DAY_MS));
  return {
    kind: "overdue_task",
    id: task.id,
    title: task.title,
    dueDate: task.dueDate.toISOString(),
    daysOverdue,
    decision: decisionFromRow(row),
  };
}

function buildTodayEventItem(
  row: AttentionRow,
  event: CalendarEventRow,
  now: number,
): AttentionItem | null {
  const start = event.startTime.getTime();
  if (!Number.isFinite(start)) return null;
  if (start < now) return null; // already started — RESOLVED on next mirror pass
  return {
    kind: "today_event",
    id: event.id,
    title: event.title,
    startTime: event.startTime.toISOString(),
    minutesAway: Math.round((start - now) / 60_000),
    location: event.location,
    decision: decisionFromRow(row),
  };
}

function buildAgentProposalItem(row: AttentionRow, notif: NotificationRow): AttentionItem | null {
  if (notif.isRead) return null;
  if (notif.pendingActionId) return null; // mirrored via the PA row instead
  if (notif.type !== "agent_proposal") return null;
  return {
    kind: "agent_proposal",
    id: notif.id,
    title: notif.title,
    message: notif.message,
    link: notif.link,
    decision: decisionFromRow(row),
  };
}

function buildCommitmentItem(row: AttentionRow, commitment: CommitmentRow): AttentionItem | null {
  if (commitment.status !== "OPEN") return null;
  if (
    row.type !== "COMMITMENT_DUE" &&
    row.type !== "COMMITMENT_OVERDUE" &&
    row.type !== "COMMITMENT_UNCONFIRMED"
  ) {
    return null;
  }
  return {
    kind: "commitment",
    id: commitment.id,
    title: commitment.title,
    description: commitment.description,
    commitmentKind: commitment.kind,
    owner: commitment.owner,
    dueAt: commitment.dueAt ? commitment.dueAt.toISOString() : null,
    dueText: commitment.dueText,
    confidence: commitment.confidence,
    attentionType: row.type,
    decision: decisionFromRow(row),
  };
}

async function buildItemFromAttention(
  row: AttentionRow,
  sources: {
    paById: Map<string, PendingActionRow>;
    taskById: Map<string, TaskRow>;
    eventById: Map<string, CalendarEventRow>;
    notifById: Map<string, NotificationRow>;
    commitmentById: Map<string, CommitmentRow>;
  },
  now: number,
): Promise<AttentionItem | null> {
  switch (row.source) {
    case "PENDING_ACTION": {
      const pa = sources.paById.get(row.sourceId);
      return pa ? await buildPendingItem(row, pa) : null;
    }
    case "TASK": {
      const task = sources.taskById.get(row.sourceId);
      return task ? buildOverdueTaskItem(row, task, now) : null;
    }
    case "CALENDAR_EVENT": {
      const event = sources.eventById.get(row.sourceId);
      return event ? buildTodayEventItem(row, event, now) : null;
    }
    case "NOTIFICATION": {
      const notif = sources.notifById.get(row.sourceId);
      return notif ? buildAgentProposalItem(row, notif) : null;
    }
    case "COMMITMENT": {
      const commitment = sources.commitmentById.get(row.sourceId);
      return commitment ? buildCommitmentItem(row, commitment) : null;
    }
  }
}

/**
 * Build the inbox summary. Top 3 reads from the AttentionItem queue; today
 * section reads its source tables directly. The producers in attention-mirror.ts
 * keep the queue in sync, with a lazy backfill here for any rows that
 * pre-date the producers.
 */
export async function buildInboxSummary(userId: string, now = Date.now()): Promise<InboxSummary> {
  const todayStart = new Date(startOfToday(now));
  const tomorrowStart = new Date(endOfToday(now));

  const [pendingRows, taskRows, eventRows, notifRows, commitmentRows] = await Promise.all([
    (prisma.pendingAction.findMany as (args: unknown) => Promise<PendingActionRow[]>)({
      where: { userId, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.task.findMany({
      where: { userId, status: { not: "DONE" } },
      orderBy: { dueDate: "asc" },
      take: 100,
    }),
    prisma.calendarEvent.findMany({
      where: { userId, startTime: { gte: todayStart, lt: tomorrowStart } },
      orderBy: { startTime: "asc" },
    }),
    prisma.notification.findMany({
      where: { userId, type: "agent_proposal", isRead: false, pendingActionId: null },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
    prisma.commitment.findMany({
      where: { userId, status: "OPEN" },
      orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }],
      take: 50,
    }),
  ]);

  // Fire-and-forget backfill. The attention-mirror producers keep the queue
  // current; this is a safety net for rows that pre-date the producers.
  // Not awaited so the queue read below is not blocked by up to ~230 upserts.
  Promise.all([
    ...pendingRows.map((p) => upsertAttentionForPendingAction(p)),
    ...taskRows
      .filter((t) => t.dueDate && t.dueDate.getTime() < tomorrowStart.getTime())
      .map((t) => upsertAttentionForTask(t, now)),
    ...eventRows.map((e) => upsertAttentionForCalendarEvent(e, now)),
    ...notifRows.map((n) => upsertAttentionForNotification(n)),
    ...commitmentRows.map((c) => upsertAttentionForCommitment(c, now)),
  ]).catch((err) => {
    // A swallowed batch failure here makes the attention queue silently go dark.
    console.warn("[INBOX] Attention backfill failed:", err);
    captureError(err, { tags: { scope: "inbox.attention-backfill" } });
  });

  // Single queue read replaces the per-source merge in the old pickTop3.
  // Exclude SILENT items — those have been suppressed by the feedback adaptor
  // and must not resurface in the top3 queue.
  const queue = (await prisma.attentionItem.findMany({
    where: { userId, status: "OPEN", tier: { not: "SILENT" } },
    orderBy: [{ priority: "desc" }, { surfacedAt: "desc" }],
    take: TOP_LIMIT * 4, // overfetch to absorb any rows whose source row no longer qualifies
    select: {
      id: true,
      source: true,
      sourceId: true,
      type: true,
      priority: true,
      confidence: true,
      suggestedAction: true,
      costOfIgnoring: true,
      evidence: true,
    },
  })) as AttentionRow[];

  // Bucket source ids and fetch the display data in a single round trip per source.
  const idsBySource = {
    PENDING_ACTION: [] as string[],
    TASK: [] as string[],
    CALENDAR_EVENT: [] as string[],
    NOTIFICATION: [] as string[],
    COMMITMENT: [] as string[],
  };
  for (const row of queue) idsBySource[row.source].push(row.sourceId);

  const [paJoinRows, taskJoinRows, eventJoinRows, notifJoinRows, commitmentJoinRows] =
    await Promise.all([
      idsBySource.PENDING_ACTION.length === 0
        ? Promise.resolve([] as PendingActionRow[])
        : (prisma.pendingAction.findMany as (args: unknown) => Promise<PendingActionRow[]>)({
            where: { id: { in: idsBySource.PENDING_ACTION } },
          }),
      idsBySource.TASK.length === 0
        ? Promise.resolve([] as TaskRow[])
        : prisma.task.findMany({ where: { id: { in: idsBySource.TASK } } }),
      idsBySource.CALENDAR_EVENT.length === 0
        ? Promise.resolve([] as CalendarEventRow[])
        : prisma.calendarEvent.findMany({ where: { id: { in: idsBySource.CALENDAR_EVENT } } }),
      idsBySource.NOTIFICATION.length === 0
        ? Promise.resolve([] as NotificationRow[])
        : prisma.notification.findMany({ where: { id: { in: idsBySource.NOTIFICATION } } }),
      idsBySource.COMMITMENT.length === 0
        ? Promise.resolve([] as CommitmentRow[])
        : prisma.commitment.findMany({ where: { id: { in: idsBySource.COMMITMENT } } }),
    ]);

  const sources = {
    paById: new Map(paJoinRows.map((r) => [r.id, r])),
    taskById: new Map(taskJoinRows.map((r) => [r.id, r])),
    eventById: new Map(eventJoinRows.map((r) => [r.id, r])),
    notifById: new Map(notifJoinRows.map((r) => [r.id, r])),
    commitmentById: new Map(commitmentJoinRows.map((r) => [r.id, r])),
  };

  const built = await Promise.all(queue.map((row) => buildItemFromAttention(row, sources, now)));
  const top3 = built.filter((x): x is AttentionItem => x !== null).slice(0, TOP_LIMIT);

  // Today section — separate view, reads source tables directly.
  const tasks: TaskInput[] = taskRows.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    dueDate: t.dueDate ? t.dueDate.toISOString() : null,
  }));
  const events: EventInput[] = eventRows.map((e) => ({
    id: e.id,
    title: e.title,
    startTime: e.startTime.toISOString(),
    endTime: e.endTime ? e.endTime.toISOString() : undefined,
    location: e.location,
  }));
  const today = buildTodaySection({ tasks, events, now });

  return { top3, today };
}
