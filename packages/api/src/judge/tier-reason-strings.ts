/**
 * Deterministic tier reasons, stored as keys and resolved for display.
 *
 * `AttentionItem.tierReason` is free text that may be LLM-authored, so the
 * rule-based reasons live alongside prose in the same column. Baking a
 * translated string in at write time would freeze each row in whatever
 * language was active the day it was written; storing the key and resolving it
 * where the row is displayed means switching language re-reads every existing
 * row, including old ones.
 *
 * Anything that is not a known key passes through untouched — that is how
 * LLM-authored reasons (already written in the user's language, see
 * poc-judge.ts) and rows written before this change keep working.
 */

import { type ShippedLanguage, toShippedLanguage } from "../shipped-languages.js";

/** Keys are dotted and namespaced so free prose can never collide with one. */
export const STATIC_TIER_REASONS = {
  "action.lowRiskAuto": {
    en: "Low-risk action — eligible for auto-execution",
    ko: "위험이 낮은 작업 — 자동 실행 대상",
    zh: "低风险操作 — 可自动执行",
  },
  "action.awaitingApproval": {
    en: "Awaiting your approval",
    ko: "승인을 기다리는 중",
    zh: "等待你的批准",
  },
  "task.overdueUrgent": {
    en: "Overdue URGENT task — last-chance interrupt before damage compounds",
    ko: "기한 지난 긴급 할 일 — 더 늦기 전 마지막 알림",
    zh: "逾期的紧急任务 — 影响扩大前的最后提醒",
  },
  "task.overdueHigh": {
    en: "Overdue high-priority task needs immediate attention",
    ko: "기한 지난 높은 우선순위 할 일 — 즉시 확인 필요",
    zh: "逾期的高优先级任务 — 需立即处理",
  },
  "task.urgentDueToday": {
    en: "Urgent task is due today",
    ko: "긴급 할 일이 오늘 마감",
    zh: "紧急任务今天到期",
  },
  "task.dueToday": {
    en: "Due today — added to review queue",
    ko: "오늘 마감 — 검토 큐에 추가함",
    zh: "今天到期 — 已加入待办审阅",
  },
  "meeting.startingNow": {
    en: "Meeting starts in minutes — interrupt now",
    ko: "곧 회의 시작 — 지금 알림",
    zh: "会议即将开始 — 立即提醒",
  },
  "meeting.startingWithinHour": {
    en: "Meeting starts within the hour — prep now",
    ko: "한 시간 안에 회의 — 지금 준비",
    zh: "一小时内有会议 — 现在准备",
  },
  "meeting.today": {
    en: "Today's meeting — prep recommended",
    ko: "오늘 회의 — 미리 준비 권장",
    zh: "今天的会议 — 建议提前准备",
  },
  "commitment.overdueHighPriority": {
    en: "High-priority commitment is overdue — counterparty actively blocked",
    ko: "중요한 약속이 기한 초과 — 상대가 기다리는 중",
    zh: "重要承诺已逾期 — 对方正在等待",
  },
  "commitment.overdue": {
    en: "Overdue commitment — may be blocking counterparty",
    ko: "기한 지난 약속 — 상대를 막고 있을 수 있음",
    zh: "逾期的承诺 — 可能正在拖住对方",
  },
  "commitment.needsDate": {
    en: "Needs date confirmation before surfacing",
    ko: "날짜 확인 후 표시 예정",
    zh: "需先确认日期再显示",
  },
  "commitment.dueSoon": {
    en: "Commitment due within 24 hours",
    ko: "24시간 안에 마감인 약속",
    zh: "24 小时内到期的承诺",
  },
  "commitment.suggested": {
    en: "Suggested commitment — not yet confirmed, so it never interrupts",
    ko: "추정된 약속 — 아직 확정 전이라 알림을 보내지 않습니다",
    zh: "推测的承诺 — 尚未确认，因此不会打扰你",
  },
  "commitment.tracked": {
    en: "Tracked commitment — added to review queue",
    ko: "추적 중인 약속 — 검토 큐에 추가함",
    zh: "跟踪中的承诺 — 已加入待办审阅",
  },
  // Policy v3 interrupt budget (attention-engine-v3.md §3(5)): a PUSH
  // candidate after the day's notifications are spent. Stored items carry the
  // key, so it must not change. The held marker itself is AttentionItem.heldAt.
  "email.heldByInterruptBudget": {
    en: "Held: daily interrupt budget reached — no notification sent",
    ko: "보류: 오늘 알림 한도에 도달해 알림을 보내지 않았어요",
    zh: "已暂缓：今日提醒次数已用完，未发送通知",
  },
  // Attention engine v3 (JUDGE_V3_POLICY): the policy picked a different lane
  // from the v2 judge, so v2's reason text no longer explains it. Clients
  // under the flag show the structured v3 reasons instead.
  "email.v3LaneFromFacts": {
    en: "Sorted by what this mail asks of you",
    ko: "메일이 요청하는 내용을 보고 분류했어요",
    zh: "根据邮件对你的请求进行分类",
  },
} as const satisfies Record<string, Record<ShippedLanguage, string>>;
// `satisfies`, not an annotation: it checks language completeness at the TABLE
// (a new SHIPPED_LANGUAGES entry errors on the exact reason missing a
// translation) while keeping the literal key union that StaticTierReasonKey
// and its type guard depend on.

export type StaticTierReasonKey = keyof typeof STATIC_TIER_REASONS;

export function isStaticTierReasonKey(value: string): value is StaticTierReasonKey {
  return Object.hasOwn(STATIC_TIER_REASONS, value);
}

/**
 * Render a stored reason for display. Keys become copy in the reader's
 * language; anything else (LLM prose, rows written before this change) is
 * returned as stored, capped at TIER_REASON_MAX_CHARS.
 */
export function resolveTierReason(
  stored: string | null | undefined,
  language?: string | null,
): string | null {
  if (!stored) return null;
  if (!isStaticTierReasonKey(stored)) return capTierReason(stored);
  return STATIC_TIER_REASONS[stored][toShippedLanguage(language)];
}

/**
 * The longest reason text sent to a client. Free-text reasons are written by
 * the judge and passed through as stored, so the server bounds them rather
 * than trusting every writer (or a client's layout) to.
 */
export const TIER_REASON_MAX_CHARS = 280;
const ELLIPSIS = "…";

/** Cut to TIER_REASON_MAX_CHARS code points (never inside a surrogate pair), ellipsis included. */
function capTierReason(text: string): string {
  // Cheap exit: UTF-16 length is an upper bound on the code-point count.
  if (text.length <= TIER_REASON_MAX_CHARS) return text;
  const points = Array.from(text);
  if (points.length <= TIER_REASON_MAX_CHARS) return text;
  return `${points
    .slice(0, TIER_REASON_MAX_CHARS - 1)
    .join("")
    .trimEnd()}${ELLIPSIS}`;
}
