/**
 * Notification copy, per language.
 *
 * This is Klorn's own voice — "Draft ready", "2 urgent emails" — so it follows
 * the user's chosen language. That is a different rule from a reply, which
 * follows the language of the mail it answers (email-reply.ts). Mixing the two
 * up produces a Korean reply announced by an English banner.
 *
 * Ships en / ko / zh, matching the languages the clients offer. An unknown language
 * falls back to English rather than throwing: a missing translation must never
 * cost the user a notification.
 */

import { prisma } from "../db.js";
import {
  SHIPPED_LANGUAGES,
  type ShippedLanguage,
  toShippedLanguage,
} from "../shipped-languages.js";

/**
 * Notification languages = the shipped languages, en / ko / zh (founder
 * decision 2026-11-17; shipped-languages.ts). `resolveNotificationLanguage`
 * folds regional tags onto these (zh-Hans/zh-TW → zh) and reads anything else
 * — a retired ja/es/fr/de stored before the cut, pt-BR — as English. Every
 * copy table is typed by this union, so a table missing one fails the build.
 */
export const NOTIFICATION_LANGUAGES = SHIPPED_LANGUAGES;
export type NotificationLanguage = ShippedLanguage;

const DEFAULT_LANGUAGE: NotificationLanguage = "en";

/** Narrow an arbitrary stored/requested language to one we actually ship. */
export function resolveNotificationLanguage(raw: string | null | undefined): NotificationLanguage {
  return toShippedLanguage(raw);
}

interface NotificationCopy {
  unknownSender: string;
  newMail: string;
  /**
   * Bell/live title of an urgent-mail interrupt: the firewall PUSH/MEETING
   * ring and the urgent sweep. Also part of their shared dedupe key, which
   * matches every language through URGENT_EMAIL_TITLES.
   */
  urgentMailTitle: string;
  /** Stand-in for a mail with an empty subject. */
  noSubject: string;
  /** Multi-mail summary, e.g. "3 urgent emails. Latest: Alice - Subject". */
  urgentDigest: (count: number, who: string, what: string) => string;
  /**
   * Title of the Windows desktop shell's catch-up summary toast (decision N6):
   * two or more urgent mails arrived while Klorn was closed. Always 2+.
   */
  missedWhileClosed: (count: number | string) => string;
  /**
   * Title of the server's quiet-hours summary push (quiet-hours-summary.ts):
   * two or more urgent mails were held during quiet hours. Always 2+. Worded as
   * the Mac app's `push.heldSummary.title` (#1650), so every surface reads alike.
   * The Windows shell's catch-up uses it too, with `{count}` for N
   * (desktop-catchup.ts), for mail that rang live during quiet hours.
   */
  heldDuringQuietHours: (count: number | string) => string;
  /**
   * The Windows shell's catch-up summary when a held Slack PUSH is among the
   * toasted (desktop-catchup.ts): "urgent messages", since not all are mail.
   * The closed / quiet-hours pick is the same as for the two mail titles.
   */
  messagesWhileClosed: (count: number | string) => string;
  messagesDuringQuietHours: (count: number | string) => string;
  actionComplete: { title: string; body: (action: string) => string };
  tools: Record<
    string,
    {
      title: string;
      body: (v: { subject: string; to: string; title: string; query: string }) => string;
    }
  >;
}

const EN: NotificationCopy = {
  unknownSender: "Unknown sender",
  newMail: "New mail",
  urgentMailTitle: "Urgent email",
  noSubject: "(no subject)",
  urgentDigest: (count, who, what) => `${count} urgent emails. Latest: ${who} - ${what}`,
  missedWhileClosed: (count) => `${count} urgent emails while Klorn was closed`,
  heldDuringQuietHours: (count) => `${count} urgent emails during quiet hours`,
  messagesWhileClosed: (count) => `${count} urgent messages while Klorn was closed`,
  messagesDuringQuietHours: (count) => `${count} urgent messages during quiet hours`,
  actionComplete: { title: "Action complete", body: (action) => `${action} finished.` },
  tools: {
    send_email: { title: "Email sent", body: (v) => `Sent "${v.subject}" to ${v.to}.` },
    draft_email: {
      title: "Draft ready",
      body: (v) => `Prepared a draft for ${v.to}. Review it before sending.`,
    },
    classify_emails: {
      title: "Mail prioritized",
      body: () => "Inbox priority has been refreshed.",
    },
    trash_email: {
      title: "Mail cleaned up",
      body: (v) => `Moved ${v.subject ? `"${v.subject}" ` : "a low-priority message "}to trash.`,
    },
    create_task: { title: "Task added", body: (v) => `Added "${v.title}" to tasks.` },
    update_task: { title: "Task updated", body: () => "Task status was updated." },
    complete_task: {
      title: "Task complete",
      body: (v) => (v.title ? `Completed "${v.title}".` : "Completed a task."),
    },
    create_reminder: {
      title: "Reminder set",
      body: (v) => `A reminder is set for "${v.title}".`,
    },
    create_event: {
      title: "Calendar event added",
      body: (v) => `Added "${v.title}" to the calendar.`,
    },
    create_note: { title: "Note saved", body: (v) => `Saved note "${v.title}".` },
    update_note: { title: "Note updated", body: () => "The note was updated." },
    search_web: {
      title: "Web search complete",
      body: (v) => (v.query ? `Searched "${v.query}".` : "Web search is complete."),
    },
  },
};

const KO: NotificationCopy = {
  unknownSender: "발신자 불명",
  newMail: "새 메일",
  urgentMailTitle: "긴급 메일",
  noSubject: "(제목 없음)",
  urgentDigest: (count, who, what) => `긴급 메일 ${count}건. 최신: ${who} - ${what}`,
  missedWhileClosed: (count) => `Klorn이 꺼져 있는 동안 긴급 메일 ${count}건`,
  heldDuringQuietHours: (count) => `방해 금지 시간 동안 긴급 메일 ${count}건`,
  messagesWhileClosed: (count) => `Klorn이 꺼져 있는 동안 긴급 메시지 ${count}건`,
  messagesDuringQuietHours: (count) => `방해 금지 시간 동안 긴급 메시지 ${count}건`,
  actionComplete: { title: "작업 완료", body: (action) => `${action} 작업을 마쳤습니다.` },
  tools: {
    send_email: { title: "메일 보냄", body: (v) => `"${v.subject}"을(를) ${v.to}에게 보냈습니다.` },
    draft_email: {
      title: "초안 준비됨",
      body: (v) => `${v.to}에게 보낼 초안을 준비했습니다. 보내기 전에 확인하세요.`,
    },
    classify_emails: { title: "메일 정리됨", body: () => "받은편지함 우선순위를 갱신했습니다." },
    trash_email: {
      title: "메일 정리함",
      body: (v) =>
        `${v.subject ? `"${v.subject}"을(를) ` : "중요하지 않은 메일을 "}휴지통으로 옮겼습니다.`,
    },
    create_task: { title: "할 일 추가됨", body: (v) => `"${v.title}"을(를) 할 일에 추가했습니다.` },
    update_task: { title: "할 일 업데이트됨", body: () => "할 일 상태를 업데이트했습니다." },
    complete_task: {
      title: "할 일 완료",
      body: (v) => (v.title ? `"${v.title}"을(를) 완료했습니다.` : "할 일을 완료했습니다."),
    },
    create_reminder: { title: "알림 설정됨", body: (v) => `"${v.title}" 알림을 설정했습니다.` },
    create_event: {
      title: "일정 추가됨",
      body: (v) => `"${v.title}"을(를) 캘린더에 추가했습니다.`,
    },
    create_note: { title: "메모 저장됨", body: (v) => `"${v.title}" 메모를 저장했습니다.` },
    update_note: { title: "메모 업데이트됨", body: () => "메모를 업데이트했습니다." },
    search_web: {
      title: "웹 검색 완료",
      body: (v) => (v.query ? `"${v.query}"을(를) 검색했습니다.` : "웹 검색을 마쳤습니다."),
    },
  },
};

const ZH: NotificationCopy = {
  unknownSender: "发件人未知",
  newMail: "新邮件",
  urgentMailTitle: "紧急邮件",
  noSubject: "（无主题）",
  urgentDigest: (count, who, what) => `${count} 封紧急邮件。最新：${who} - ${what}`,
  missedWhileClosed: (count) => `Klorn 关闭期间有 ${count} 封紧急邮件`,
  heldDuringQuietHours: (count) => `免打扰时段内有 ${count} 封紧急邮件`,
  messagesWhileClosed: (count) => `Klorn 关闭期间有 ${count} 条紧急消息`,
  messagesDuringQuietHours: (count) => `免打扰时段内有 ${count} 条紧急消息`,
  actionComplete: { title: "操作完成", body: (action) => `${action} 已完成。` },
  tools: {
    send_email: { title: "邮件已发送", body: (v) => `已将“${v.subject}”发送给 ${v.to}。` },
    draft_email: {
      title: "草稿已就绪",
      body: (v) => `已为 ${v.to} 准备草稿。发送前请先确认。`,
    },
    classify_emails: { title: "邮件已整理", body: () => "收件箱优先级已更新。" },
    trash_email: {
      title: "邮件已清理",
      body: (v) => `已将${v.subject ? `“${v.subject}”` : "一封低优先级邮件"}移到回收站。`,
    },
    create_task: { title: "已添加任务", body: (v) => `已将“${v.title}”添加到任务。` },
    update_task: { title: "任务已更新", body: () => "任务状态已更新。" },
    complete_task: {
      title: "任务完成",
      body: (v) => (v.title ? `已完成“${v.title}”。` : "已完成一项任务。"),
    },
    create_reminder: { title: "提醒已设置", body: (v) => `已为“${v.title}”设置提醒。` },
    create_event: {
      title: "已添加日程",
      body: (v) => `已将“${v.title}”添加到日历。`,
    },
    create_note: { title: "笔记已保存", body: (v) => `已保存笔记“${v.title}”。` },
    update_note: { title: "笔记已更新", body: () => "笔记已更新。" },
    search_web: {
      title: "网页搜索完成",
      body: (v) => (v.query ? `已搜索“${v.query}”。` : "网页搜索已完成。"),
    },
  },
};

const COPY: Record<NotificationLanguage, NotificationCopy> = {
  en: EN,
  ko: KO,
  zh: ZH,
};

export function notificationCopy(language: string | null | undefined): NotificationCopy {
  return COPY[resolveNotificationLanguage(language)];
}

/**
 * Titles an urgent-mail bell row was ever written under, for the dedupe reads
 * that find one by title plus its `[id]` marker (firewall-push.ts, the urgent
 * sweep, /today-actions). Every shipped language, so a user who switches
 * language is not rung again for a mail already announced, plus the titles
 * written before the title was localized: "Urgent email" (every user) and
 * "긴급 이메일" (an older Korean title), and the titles of the languages retired
 * on 2026-11-17 (ja, es, fr, de). Rows stay in the table, so a legacy title is
 * never dropped from this list.
 */
const LEGACY_URGENT_EMAIL_TITLES = [
  "Urgent email",
  "긴급 이메일",
  "緊急メール",
  "Correo urgente",
  "E-mail urgent",
  "Dringende Mail",
] as const;
export const URGENT_EMAIL_TITLES: readonly string[] = [
  ...new Set<string>([
    ...LEGACY_URGENT_EMAIL_TITLES,
    ...NOTIFICATION_LANGUAGES.map((lang) => COPY[lang].urgentMailTitle),
  ]),
];

/**
 * The user's notification language, for server-composed copy outside the
 * notification pipeline (e.g. the judge's tier reason).
 *
 * Fail-soft: a config read that throws must never stop an email from being
 * judged, so the English default is returned instead of propagating. Callers
 * that process many rows for one user should resolve this once and pass it
 * down rather than calling per row.
 */
export async function getUserNotificationLanguage(userId: string): Promise<NotificationLanguage> {
  try {
    const config = (await prisma.automationConfig.findUnique({
      where: { userId },
      select: { notificationLanguage: true },
    })) as { notificationLanguage?: string | null } | null;
    return resolveNotificationLanguage(config?.notificationLanguage);
  } catch {
    return DEFAULT_LANGUAGE;
  }
}
