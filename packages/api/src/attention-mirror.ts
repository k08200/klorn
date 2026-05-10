/**
 * Producer that mirrors PendingAction lifecycle into AttentionItem.
 *
 * Call shape:
 *   - After `pendingAction.create` →  upsertAttentionForPendingAction(...)
 *   - After a single PA status update →  upsertAttentionForPendingAction(...)
 *   - After a bulk PA status update (e.g. expire) →
 *       bulkResolveAttentionForPendingActions(ids, finalStatus)
 *
 * Upserts are idempotent and keyed on (source=PENDING_ACTION, sourceId=pa.id),
 * so re-running is always safe — useful when chat.ts updates a PA twice within
 * the approve flow (claim → result/error).
 *
 * Failures are caught and logged but do not throw, since the AttentionItem is
 * a derived projection and the source PendingAction is the source of truth.
 * Future PRs can flip this to strict consistency if needed.
 */

import type { AttentionStatus, AttentionType } from "@prisma/client";
import { getToolRisk } from "./agent-logic.js";
import { AUTOPILOT_LEVEL, type AutopilotLevel } from "./agent-mode.js";
import { prisma } from "./db.js";

export interface PendingActionLike {
  id: string;
  userId: string;
  toolName: string;
  status: string;
  reasoning: string | null;
}

const TITLE_MAX_LEN = 120;

function statusFor(paStatus: string): AttentionStatus {
  switch (paStatus) {
    case "PENDING":
      return "OPEN";
    case "REJECTED":
      return "DISMISSED";
    // EXECUTED + FAILED both close the loop — the user has already seen the
    // outcome message in the chat, so the queue entry is resolved either way.
    case "EXECUTED":
    case "FAILED":
      return "RESOLVED";
    default:
      return "OPEN";
  }
}

function titleFor(pa: PendingActionLike): string {
  const reason = pa.reasoning?.trim();
  if (reason)
    return reason.length > TITLE_MAX_LEN ? `${reason.slice(0, TITLE_MAX_LEN - 1)}…` : reason;
  return pa.toolName.replace(/_/g, " ");
}

// PendingAction priority is fixed at 100 — strictly above any task or event
// score so the canonical rule "user-blocking decisions never get buried" holds
// even when an URGENT overdue task is sitting in the queue.
const PENDING_ACTION_PRIORITY = 100;

function autonomyLevelForPendingAction(pa: PendingActionLike): AutopilotLevel {
  const risk = getToolRisk(pa.toolName);
  if (risk === "LOW") return AUTOPILOT_LEVEL.SAFE_AUTO;
  if (risk === "MEDIUM") return AUTOPILOT_LEVEL.APPROVAL;
  return AUTOPILOT_LEVEL.SUGGEST;
}

function evidence(
  source: string,
  sourceId: string,
  facts: Array<{ label: string; value: string }>,
) {
  return { source, sourceId, facts };
}

function pendingActionCost(pa: PendingActionLike): string {
  if (pa.toolName === "send_email") {
    return "답장이 늦어지면 관계나 일정 리스크가 커질 수 있어요.";
  }
  if (pa.toolName === "create_event") {
    return "일정이 고정되지 않으면 준비 시간과 후속 작업이 밀릴 수 있어요.";
  }
  if (pa.toolName.startsWith("delete_")) {
    return "삭제 결정이 맞는지 확인하지 않으면 되돌리기 어려운 손실이 생길 수 있어요.";
  }
  return "결정이 대기 상태로 남으면 관련 업무 흐름도 멈춰요.";
}

/**
 * Upsert the AttentionItem mirroring this PendingAction. Safe to call after
 * either a create or an update — uses the (source, sourceId) unique key.
 */
export async function upsertAttentionForPendingAction(pa: PendingActionLike): Promise<void> {
  const status = statusFor(pa.status);
  const isResolved = status !== "OPEN";
  const type: AttentionType = "DECISION";
  const autonomyLevel = autonomyLevelForPendingAction(pa);

  try {
    await prisma.attentionItem.upsert({
      where: { source_sourceId: { source: "PENDING_ACTION", sourceId: pa.id } },
      create: {
        userId: pa.userId,
        source: "PENDING_ACTION",
        sourceId: pa.id,
        type,
        status,
        priority: PENDING_ACTION_PRIORITY,
        autonomyLevel,
        title: titleFor(pa),
        body: pa.reasoning,
        suggestedAction: pa.toolName.replace(/_/g, " "),
        costOfIgnoring: pendingActionCost(pa),
        evidence: evidence("PENDING_ACTION", pa.id, [
          { label: "Prepared action", value: pa.toolName.replace(/_/g, " ") },
          { label: "Risk level", value: getToolRisk(pa.toolName) ?? "READ_ONLY" },
        ]),
        resolvedAt: isResolved ? new Date() : null,
      },
      update: {
        status,
        priority: PENDING_ACTION_PRIORITY,
        autonomyLevel,
        title: titleFor(pa),
        body: pa.reasoning,
        suggestedAction: pa.toolName.replace(/_/g, " "),
        costOfIgnoring: pendingActionCost(pa),
        evidence: evidence("PENDING_ACTION", pa.id, [
          { label: "Prepared action", value: pa.toolName.replace(/_/g, " ") },
          { label: "Risk level", value: getToolRisk(pa.toolName) ?? "READ_ONLY" },
        ]),
        resolvedAt: isResolved ? new Date() : null,
      },
    });
  } catch (err) {
    console.warn("[attention-mirror] upsert failed for PendingAction", pa.id, err);
  }
}

/**
 * Mark every AttentionItem mirroring one of these PendingActions as resolved.
 * Used by bulk lifecycle operations (expire job, cascade cleanup) where we
 * already know the final status applies uniformly to the whole batch.
 */
export async function bulkResolveAttentionForPendingActions(
  pendingActionIds: string[],
  finalStatus: "REJECTED" | "EXECUTED" | "FAILED",
): Promise<void> {
  if (pendingActionIds.length === 0) return;
  const status = statusFor(finalStatus);
  try {
    await prisma.attentionItem.updateMany({
      where: {
        source: "PENDING_ACTION",
        sourceId: { in: pendingActionIds },
      },
      data: {
        status,
        resolvedAt: new Date(),
      },
    });
  } catch (err) {
    console.warn(
      "[attention-mirror] bulkResolveAttentionForPendingActions failed",
      pendingActionIds.length,
      err,
    );
  }
}

/**
 * Delete the AttentionItem(s) mirroring the given PendingAction ids. Used when
 * the source rows themselves are deleted (e.g. clearing a conversation).
 */
export async function deleteAttentionForPendingActions(pendingActionIds: string[]): Promise<void> {
  if (pendingActionIds.length === 0) return;
  try {
    await prisma.attentionItem.deleteMany({
      where: { source: "PENDING_ACTION", sourceId: { in: pendingActionIds } },
    });
  } catch (err) {
    console.warn("[attention-mirror] deleteAttentionForPendingActions failed", err);
  }
}

// ─── Tasks ──────────────────────────────────────────────────────────────────
// Tasks have a time-based surfacing rule: they only enter the queue once the
// dueDate is today or already past. The producer is therefore not "every task
// change" — it's "tasks whose due window is open." Callers fall into two
// shapes: (a) write-time hooks for status/dueDate changes, (b) read-time
// backfill from `buildInboxSummary`.

export interface TaskLike {
  id: string;
  userId: string;
  title: string;
  status: string;
  priority: string;
  dueDate: Date | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfTodayMs(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function priorityForTask(task: TaskLike, isOverdue: boolean): number {
  let p = 50;
  if (isOverdue) p += 20;
  if (task.priority === "URGENT") p += 20;
  else if (task.priority === "HIGH") p += 10;
  return p;
}

function taskCost(task: TaskLike, isOverdue: boolean): string {
  if (isOverdue) return "마감이 지나 관련 후속 작업이나 약속이 밀릴 수 있어요.";
  if (task.priority === "URGENT" || task.priority === "HIGH") {
    return "오늘 처리하지 않으면 높은 우선순위 작업이 내일로 넘어가요.";
  }
  return "오늘 마감이라 놓치면 작업 큐가 밀릴 수 있어요.";
}

/**
 * Surface a task into the queue if its due window is open. No-op for tasks
 * that are not yet due today, so this is safe to call on every task change.
 *
 * If the task is already DONE we clear the AttentionItem instead — the user
 * already finished it, so the queue entry should resolve.
 */
export async function upsertAttentionForTask(task: TaskLike, now = Date.now()): Promise<void> {
  // No due date → no time-based surfacing rule applies.
  if (!task.dueDate) return;

  const dueMs = task.dueDate.getTime();
  if (!Number.isFinite(dueMs)) return;

  const todayStart = startOfTodayMs(now);
  const tomorrowStart = todayStart + DAY_MS;

  // Only surface if due today or earlier. Future-dated tasks stay invisible
  // until their day comes.
  if (dueMs >= tomorrowStart) return;

  const isOverdue = dueMs < todayStart;
  const status: AttentionStatus = task.status === "DONE" ? "RESOLVED" : "OPEN";
  const isResolved = status !== "OPEN";
  const type: AttentionType = "DEADLINE";

  try {
    await prisma.attentionItem.upsert({
      where: { source_sourceId: { source: "TASK", sourceId: task.id } },
      create: {
        userId: task.userId,
        source: "TASK",
        sourceId: task.id,
        type,
        status,
        priority: priorityForTask(task, isOverdue),
        autonomyLevel: AUTOPILOT_LEVEL.OBSERVE,
        title: task.title,
        suggestedAction: task.status === "DONE" ? null : "review task",
        costOfIgnoring: taskCost(task, isOverdue),
        evidence: evidence("TASK", task.id, [
          { label: "Priority", value: task.priority },
          { label: "Due date", value: task.dueDate.toISOString() },
        ]),
        resolvedAt: isResolved ? new Date() : null,
      },
      update: {
        status,
        priority: priorityForTask(task, isOverdue),
        autonomyLevel: AUTOPILOT_LEVEL.OBSERVE,
        title: task.title,
        suggestedAction: task.status === "DONE" ? null : "review task",
        costOfIgnoring: taskCost(task, isOverdue),
        evidence: evidence("TASK", task.id, [
          { label: "Priority", value: task.priority },
          { label: "Due date", value: task.dueDate.toISOString() },
        ]),
        resolvedAt: isResolved ? new Date() : null,
      },
    });
  } catch (err) {
    console.warn("[attention-mirror] upsert failed for Task", task.id, err);
  }
}

/**
 * Mark the AttentionItem mirroring this task as resolved. Used by callers
 * that know the task just transitioned away from an open state but don't
 * have the full task row handy.
 */
export async function resolveAttentionForTask(taskId: string): Promise<void> {
  try {
    await prisma.attentionItem.updateMany({
      where: { source: "TASK", sourceId: taskId, status: "OPEN" },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
  } catch (err) {
    console.warn("[attention-mirror] resolveAttentionForTask failed", taskId, err);
  }
}

/**
 * Delete AttentionItem rows mirroring the given task ids. Used when the
 * source tasks themselves are removed.
 */
export async function deleteAttentionForTasks(taskIds: string[]): Promise<void> {
  if (taskIds.length === 0) return;
  try {
    await prisma.attentionItem.deleteMany({
      where: { source: "TASK", sourceId: { in: taskIds } },
    });
  } catch (err) {
    console.warn("[attention-mirror] deleteAttentionForTasks failed", err);
  }
}

/**
 * Bulk-delete every AttentionItem belonging to a user. Used by user data
 * deletion flows that wipe per-source tables but not the User row itself
 * (so the FK cascade does not fire).
 */
export async function deleteAllAttentionForUser(userId: string): Promise<void> {
  try {
    await prisma.attentionItem.deleteMany({ where: { userId } });
  } catch (err) {
    console.warn("[attention-mirror] deleteAllAttentionForUser failed", userId, err);
  }
}

// ─── Calendar Events ───────────────────────────────────────────────────────
// Calendar events surface as MEETING_PREP for the day they happen. Future
// dates stay invisible until their morning; past events resolve so they don't
// linger. Like tasks, the "is it surfaceable right now?" check happens inside
// the upsert, so write-time hooks can call this on every change without
// guarding the timing themselves.

export interface CalendarEventLike {
  id: string;
  userId: string;
  title: string;
  startTime: Date;
}

const SOON_WINDOW_MS = 60 * 60 * 1000; // "starting within an hour" → priority bump

export async function upsertAttentionForCalendarEvent(
  event: CalendarEventLike,
  now = Date.now(),
): Promise<void> {
  const start = event.startTime.getTime();
  if (!Number.isFinite(start)) return;

  const todayStart = startOfTodayMs(now);
  const tomorrowStart = todayStart + DAY_MS;

  // Only events happening today are eligible.
  if (start < todayStart || start >= tomorrowStart) return;

  const status: AttentionStatus = start < now ? "RESOLVED" : "OPEN";
  const isResolved = status !== "OPEN";
  const type: AttentionType = "MEETING_PREP";

  // Priority bump when the event is starting within the hour — that's the
  // window where the user actually needs prep.
  const priority = !isResolved && start - now <= SOON_WINDOW_MS ? 70 : 50;

  try {
    await prisma.attentionItem.upsert({
      where: { source_sourceId: { source: "CALENDAR_EVENT", sourceId: event.id } },
      create: {
        userId: event.userId,
        source: "CALENDAR_EVENT",
        sourceId: event.id,
        type,
        status,
        priority,
        autonomyLevel: AUTOPILOT_LEVEL.OBSERVE,
        title: event.title,
        suggestedAction: "prepare meeting",
        costOfIgnoring: "회의 전에 맥락을 놓치면 답변, 자료, 약속 확인이 늦어질 수 있어요.",
        evidence: evidence("CALENDAR_EVENT", event.id, [
          { label: "Start time", value: event.startTime.toISOString() },
          { label: "Queue type", value: type },
        ]),
        resolvedAt: isResolved ? new Date() : null,
      },
      update: {
        status,
        priority,
        autonomyLevel: AUTOPILOT_LEVEL.OBSERVE,
        title: event.title,
        suggestedAction: "prepare meeting",
        costOfIgnoring: "회의 전에 맥락을 놓치면 답변, 자료, 약속 확인이 늦어질 수 있어요.",
        evidence: evidence("CALENDAR_EVENT", event.id, [
          { label: "Start time", value: event.startTime.toISOString() },
          { label: "Queue type", value: type },
        ]),
        resolvedAt: isResolved ? new Date() : null,
      },
    });
  } catch (err) {
    console.warn("[attention-mirror] upsert failed for CalendarEvent", event.id, err);
  }
}

export async function deleteAttentionForCalendarEvents(eventIds: string[]): Promise<void> {
  if (eventIds.length === 0) return;
  try {
    await prisma.attentionItem.deleteMany({
      where: { source: "CALENDAR_EVENT", sourceId: { in: eventIds } },
    });
  } catch (err) {
    console.warn("[attention-mirror] deleteAttentionForCalendarEvents failed", err);
  }
}

// ─── Notifications (agent_proposal only) ───────────────────────────────────
// agent_proposal notifications without an attached PendingAction surface as
// FOLLOWUP. These are typically legacy rows from before the PA → notification
// link was added; new proposals go through the PendingAction mirror so they
// don't get double-counted here.

export interface NotificationLike {
  id: string;
  userId: string;
  type: string;
  title: string;
  message: string;
  isRead: boolean;
  pendingActionId: string | null;
}

export async function upsertAttentionForNotification(notif: NotificationLike): Promise<void> {
  // Only mirror agent_proposal notifications that aren't already represented
  // by a PendingAction — anything else is either noise or already in the
  // queue via another source.
  if (notif.type !== "agent_proposal") return;
  if (notif.pendingActionId !== null) return;

  const status: AttentionStatus = notif.isRead ? "DISMISSED" : "OPEN";
  const isResolved = status !== "OPEN";

  try {
    await prisma.attentionItem.upsert({
      where: { source_sourceId: { source: "NOTIFICATION", sourceId: notif.id } },
      create: {
        userId: notif.userId,
        source: "NOTIFICATION",
        sourceId: notif.id,
        type: "FOLLOWUP",
        status,
        autonomyLevel: AUTOPILOT_LEVEL.SUGGEST,
        title: notif.title,
        body: notif.message,
        suggestedAction: "review proposal",
        costOfIgnoring: "확인하지 않으면 EVE가 준비한 후속 조치가 대기 상태로 남아요.",
        evidence: evidence("NOTIFICATION", notif.id, [
          { label: "Notification type", value: notif.type },
          { label: "Unread", value: String(!notif.isRead) },
        ]),
        resolvedAt: isResolved ? new Date() : null,
      },
      update: {
        status,
        autonomyLevel: AUTOPILOT_LEVEL.SUGGEST,
        title: notif.title,
        body: notif.message,
        suggestedAction: "review proposal",
        costOfIgnoring: "확인하지 않으면 EVE가 준비한 후속 조치가 대기 상태로 남아요.",
        evidence: evidence("NOTIFICATION", notif.id, [
          { label: "Notification type", value: notif.type },
          { label: "Unread", value: String(!notif.isRead) },
        ]),
        resolvedAt: isResolved ? new Date() : null,
      },
    });
  } catch (err) {
    console.warn("[attention-mirror] upsert failed for Notification", notif.id, err);
  }
}

export async function deleteAttentionForNotifications(notificationIds: string[]): Promise<void> {
  if (notificationIds.length === 0) return;
  try {
    await prisma.attentionItem.deleteMany({
      where: { source: "NOTIFICATION", sourceId: { in: notificationIds } },
    });
  } catch (err) {
    console.warn("[attention-mirror] deleteAttentionForNotifications failed", err);
  }
}

// ─── Commitments ────────────────────────────────────────────────────────────
// Commitments project into the queue with three different shapes:
//   - COMMITMENT_DUE:        OPEN, dueAt is today or in the near future
//   - COMMITMENT_OVERDUE:    OPEN, dueAt has passed
//   - COMMITMENT_UNCONFIRMED: OPEN, no parsed dueAt yet (LLM low-confidence
//                            or extractor couldn't pin a date)
// DONE/DISMISSED commitments resolve. SNOOZED commitments stay out of the
// queue until snoozedUntil passes (a future producer concern).

export interface CommitmentLike {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  status: string;
  dueAt: Date | null;
  dueText?: string | null;
  owner?: string | null;
  confidence: number;
}

const COMMITMENT_NEAR_WINDOW_MS = 24 * 60 * 60 * 1000; // due "soon" = within 24h

function commitmentTypeFor(
  c: CommitmentLike,
  now: number,
): "COMMITMENT_DUE" | "COMMITMENT_OVERDUE" | "COMMITMENT_UNCONFIRMED" {
  if (!c.dueAt) return "COMMITMENT_UNCONFIRMED";
  const due = c.dueAt.getTime();
  if (!Number.isFinite(due)) return "COMMITMENT_UNCONFIRMED";
  return due < now ? "COMMITMENT_OVERDUE" : "COMMITMENT_DUE";
}

function priorityForCommitment(
  type: "COMMITMENT_DUE" | "COMMITMENT_OVERDUE" | "COMMITMENT_UNCONFIRMED",
  c: CommitmentLike,
  now: number,
): number {
  if (type === "COMMITMENT_OVERDUE") return 80;
  if (type === "COMMITMENT_UNCONFIRMED") return 40; // below baseline — needs human triage
  // COMMITMENT_DUE — bump if due within 24h
  if (c.dueAt && c.dueAt.getTime() - now <= COMMITMENT_NEAR_WINDOW_MS) return 70;
  return 55;
}

function commitmentCost(
  type: "COMMITMENT_DUE" | "COMMITMENT_OVERDUE" | "COMMITMENT_UNCONFIRMED",
  c: CommitmentLike,
): string {
  if (type === "COMMITMENT_OVERDUE")
    return "약속 기한이 지나 신뢰나 후속 일정에 영향을 줄 수 있어요.";
  if (type === "COMMITMENT_UNCONFIRMED") {
    return "기한이 불명확해서 지금 확인하지 않으면 나중에 놓칠 가능성이 커요.";
  }
  return c.owner === "COUNTERPARTY"
    ? "상대가 하기로 한 일이 제때 오지 않으면 다음 결정이 막힐 수 있어요."
    : "내가 하기로 한 일을 놓치면 상대방의 다음 작업이 지연될 수 있어요.";
}

export async function upsertAttentionForCommitment(
  c: CommitmentLike,
  now = Date.now(),
): Promise<void> {
  const status: AttentionStatus =
    c.status === "DONE" || c.status === "DISMISSED" ? "RESOLVED" : "OPEN";
  const isResolved = status !== "OPEN";
  const type = commitmentTypeFor(c, now);
  const priority = priorityForCommitment(type, c, now);

  try {
    await prisma.attentionItem.upsert({
      where: { source_sourceId: { source: "COMMITMENT", sourceId: c.id } },
      create: {
        userId: c.userId,
        source: "COMMITMENT",
        sourceId: c.id,
        type,
        status,
        priority,
        autonomyLevel: AUTOPILOT_LEVEL.OBSERVE,
        confidence: c.confidence,
        title: c.title,
        body: c.description,
        suggestedAction:
          type === "COMMITMENT_UNCONFIRMED" ? "confirm commitment" : "review commitment",
        costOfIgnoring: commitmentCost(type, c),
        evidence: evidence("COMMITMENT", c.id, [
          { label: "Owner", value: c.owner ?? "UNKNOWN" },
          { label: "Due", value: c.dueAt?.toISOString() ?? c.dueText ?? "unconfirmed" },
          { label: "Confidence", value: String(c.confidence) },
        ]),
        resolvedAt: isResolved ? new Date() : null,
      },
      update: {
        status,
        type,
        priority,
        autonomyLevel: AUTOPILOT_LEVEL.OBSERVE,
        confidence: c.confidence,
        title: c.title,
        body: c.description,
        suggestedAction:
          type === "COMMITMENT_UNCONFIRMED" ? "confirm commitment" : "review commitment",
        costOfIgnoring: commitmentCost(type, c),
        evidence: evidence("COMMITMENT", c.id, [
          { label: "Owner", value: c.owner ?? "UNKNOWN" },
          { label: "Due", value: c.dueAt?.toISOString() ?? c.dueText ?? "unconfirmed" },
          { label: "Confidence", value: String(c.confidence) },
        ]),
        resolvedAt: isResolved ? new Date() : null,
      },
    });
  } catch (err) {
    console.warn("[attention-mirror] upsert failed for Commitment", c.id, err);
  }
}

export async function deleteAttentionForCommitments(commitmentIds: string[]): Promise<void> {
  if (commitmentIds.length === 0) return;
  try {
    await prisma.attentionItem.deleteMany({
      where: { source: "COMMITMENT", sourceId: { in: commitmentIds } },
    });
  } catch (err) {
    console.warn("[attention-mirror] deleteAttentionForCommitments failed", err);
  }
}
