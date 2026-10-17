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

import {
  type NotificationLanguage,
  resolveNotificationLanguage,
} from "../notify/notification-strings.js";

/** Keys are dotted and namespaced so free prose can never collide with one. */
export const STATIC_TIER_REASONS = {
  "action.lowRiskAuto": {
    en: "Low-risk action — eligible for auto-execution",
    ko: "위험이 낮은 작업 — 자동 실행 대상",
    ja: "低リスクの操作 — 自動実行の対象",
    zh: "低风险操作 — 可自动执行",
    es: "Acción de bajo riesgo: apta para ejecución automática",
    fr: "Action peu risquée — éligible à l'exécution automatique",
    de: "Risikoarme Aktion – für automatische Ausführung geeignet",
  },
  "action.awaitingApproval": {
    en: "Awaiting your approval",
    ko: "승인을 기다리는 중",
    ja: "承認待ち",
    zh: "等待你的批准",
    es: "Esperando tu aprobación",
    fr: "En attente de votre approbation",
    de: "Wartet auf deine Freigabe",
  },
  "task.overdueUrgent": {
    en: "Overdue URGENT task — last-chance interrupt before damage compounds",
    ko: "기한 지난 긴급 할 일 — 더 늦기 전 마지막 알림",
    ja: "期限切れの緊急タスク — 被害が広がる前の最終通知",
    zh: "逾期的紧急任务 — 影响扩大前的最后提醒",
    es: "Tarea urgente vencida: último aviso antes de que el daño crezca",
    fr: "Tâche urgente en retard — dernière alerte avant aggravation",
    de: "Überfällige dringende Aufgabe – letzte Warnung, bevor der Schaden wächst",
  },
  "task.overdueHigh": {
    en: "Overdue high-priority task needs immediate attention",
    ko: "기한 지난 높은 우선순위 할 일 — 즉시 확인 필요",
    ja: "期限切れの重要タスク — すぐに確認が必要",
    zh: "逾期的高优先级任务 — 需立即处理",
    es: "Tarea vencida de alta prioridad: requiere atención inmediata",
    fr: "Tâche prioritaire en retard — attention immédiate requise",
    de: "Überfällige Aufgabe mit hoher Priorität – sofort ansehen",
  },
  "task.urgentDueToday": {
    en: "Urgent task is due today",
    ko: "긴급 할 일이 오늘 마감",
    ja: "緊急タスクの期限は今日",
    zh: "紧急任务今天到期",
    es: "La tarea urgente vence hoy",
    fr: "Tâche urgente à rendre aujourd'hui",
    de: "Dringende Aufgabe ist heute fällig",
  },
  "task.dueToday": {
    en: "Due today — added to review queue",
    ko: "오늘 마감 — 검토 큐에 추가함",
    ja: "今日が期限 — レビュー待ちに追加",
    zh: "今天到期 — 已加入待办审阅",
    es: "Vence hoy: añadido a la cola de revisión",
    fr: "Échéance aujourd'hui — ajouté à la file de revue",
    de: "Heute fällig – zur Prüfliste hinzugefügt",
  },
  "meeting.startingNow": {
    en: "Meeting starts in minutes — interrupt now",
    ko: "곧 회의 시작 — 지금 알림",
    ja: "まもなく会議開始 — 今すぐ通知",
    zh: "会议即将开始 — 立即提醒",
    es: "La reunión empieza en minutos: aviso inmediato",
    fr: "Réunion dans quelques minutes — alerte immédiate",
    de: "Meeting startet in Minuten – jetzt unterbrechen",
  },
  "meeting.startingWithinHour": {
    en: "Meeting starts within the hour — prep now",
    ko: "한 시간 안에 회의 — 지금 준비",
    ja: "1時間以内に会議 — 今から準備",
    zh: "一小时内有会议 — 现在准备",
    es: "La reunión empieza dentro de una hora: prepárate ahora",
    fr: "Réunion dans l'heure — préparez-vous maintenant",
    de: "Meeting innerhalb einer Stunde – jetzt vorbereiten",
  },
  "meeting.today": {
    en: "Today's meeting — prep recommended",
    ko: "오늘 회의 — 미리 준비 권장",
    ja: "今日の会議 — 事前準備を推奨",
    zh: "今天的会议 — 建议提前准备",
    es: "Reunión de hoy: se recomienda prepararla",
    fr: "Réunion aujourd'hui — préparation recommandée",
    de: "Meeting heute – Vorbereitung empfohlen",
  },
  "commitment.overdueHighPriority": {
    en: "High-priority commitment is overdue — counterparty actively blocked",
    ko: "중요한 약속이 기한 초과 — 상대가 기다리는 중",
    ja: "重要な約束が期限超過 — 相手が待っています",
    zh: "重要承诺已逾期 — 对方正在等待",
    es: "Compromiso importante vencido: la otra parte está bloqueada",
    fr: "Engagement important en retard — l'autre partie est bloquée",
    de: "Wichtige Zusage überfällig – die Gegenseite wartet",
  },
  "commitment.overdue": {
    en: "Overdue commitment — may be blocking counterparty",
    ko: "기한 지난 약속 — 상대를 막고 있을 수 있음",
    ja: "期限切れの約束 — 相手を待たせている可能性",
    zh: "逾期的承诺 — 可能正在拖住对方",
    es: "Compromiso vencido: puede estar bloqueando a la otra parte",
    fr: "Engagement en retard — peut bloquer l'autre partie",
    de: "Überfällige Zusage – blockiert womöglich die Gegenseite",
  },
  "commitment.needsDate": {
    en: "Needs date confirmation before surfacing",
    ko: "날짜 확인 후 표시 예정",
    ja: "表示前に日付の確認が必要",
    zh: "需先确认日期再显示",
    es: "Necesita confirmar la fecha antes de mostrarse",
    fr: "Date à confirmer avant affichage",
    de: "Datum muss vor der Anzeige bestätigt werden",
  },
  "commitment.dueSoon": {
    en: "Commitment due within 24 hours",
    ko: "24시간 안에 마감인 약속",
    ja: "24時間以内が期限の約束",
    zh: "24 小时内到期的承诺",
    es: "Compromiso que vence en 24 horas",
    fr: "Engagement à honorer sous 24 heures",
    de: "Zusage in den nächsten 24 Stunden fällig",
  },
  "commitment.tracked": {
    en: "Tracked commitment — added to review queue",
    ko: "추적 중인 약속 — 검토 큐에 추가함",
    ja: "追跡中の約束 — レビュー待ちに追加",
    zh: "跟踪中的承诺 — 已加入待办审阅",
    es: "Compromiso en seguimiento: añadido a la cola de revisión",
    fr: "Engagement suivi — ajouté à la file de revue",
    de: "Verfolgte Zusage – zur Prüfliste hinzugefügt",
  },
} as const satisfies Record<string, Record<NotificationLanguage, string>>;
// `satisfies`, not an annotation: it checks language completeness at the TABLE
// (a new NOTIFICATION_LANGUAGES entry errors on the exact reason missing a
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
  return STATIC_TIER_REASONS[stored][resolveNotificationLanguage(language)];
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
