/**
 * Notification copy, per language.
 *
 * This is Klorn's own voice — "Draft ready", "2 urgent emails" — so it follows
 * the user's chosen language. That is a different rule from a reply, which
 * follows the language of the mail it answers (email-reply.ts). Mixing the two
 * up produces a Korean reply announced by an English banner.
 *
 * Ships en + ko, matching the languages the clients offer. An unknown language
 * falls back to English rather than throwing: a missing translation must never
 * cost the user a notification.
 */

import { prisma } from "../db.js";

/**
 * Shipped UI/notification languages. `resolveNotificationLanguage` folds
 * regional tags onto these (zh-Hans/zh-TW → zh, pt-BR → unsupported → en),
 * and every copy table is typed by this union, so adding a code here fails
 * the build at each table entry still missing a translation.
 */
export const NOTIFICATION_LANGUAGES = ["en", "ko", "ja", "zh", "es", "fr", "de"] as const;
export type NotificationLanguage = (typeof NOTIFICATION_LANGUAGES)[number];

const DEFAULT_LANGUAGE: NotificationLanguage = "en";

/** Narrow an arbitrary stored/requested language to one we actually ship. */
export function resolveNotificationLanguage(raw: string | null | undefined): NotificationLanguage {
  if (!raw) return DEFAULT_LANGUAGE;
  const base = raw.toLowerCase().split(/[-_]/)[0];
  return (NOTIFICATION_LANGUAGES as readonly string[]).includes(base)
    ? (base as NotificationLanguage)
    : DEFAULT_LANGUAGE;
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

const JA: NotificationCopy = {
  unknownSender: "差出人不明",
  newMail: "新着メール",
  urgentMailTitle: "緊急メール",
  noSubject: "(件名なし)",
  urgentDigest: (count, who, what) => `緊急メール${count}件。最新: ${who} - ${what}`,
  missedWhileClosed: (count) => `Klornが閉じている間に緊急メール${count}件`,
  actionComplete: { title: "処理完了", body: (action) => `${action} が完了しました。` },
  tools: {
    send_email: {
      title: "メール送信済み",
      body: (v) => `「${v.subject}」を ${v.to} に送信しました。`,
    },
    draft_email: {
      title: "下書き準備完了",
      body: (v) => `${v.to} 宛の下書きを用意しました。送信前にご確認ください。`,
    },
    classify_emails: { title: "メール整理済み", body: () => "受信トレイの優先度を更新しました。" },
    trash_email: {
      title: "メール整理",
      body: (v) =>
        `${v.subject ? `「${v.subject}」を` : "重要度の低いメールを"}ゴミ箱に移動しました。`,
    },
    create_task: { title: "タスク追加", body: (v) => `「${v.title}」をタスクに追加しました。` },
    update_task: { title: "タスク更新", body: () => "タスクの状態を更新しました。" },
    complete_task: {
      title: "タスク完了",
      body: (v) => (v.title ? `「${v.title}」を完了しました。` : "タスクを完了しました。"),
    },
    create_reminder: {
      title: "リマインダー設定",
      body: (v) => `「${v.title}」のリマインダーを設定しました。`,
    },
    create_event: {
      title: "予定を追加",
      body: (v) => `「${v.title}」をカレンダーに追加しました。`,
    },
    create_note: { title: "メモ保存", body: (v) => `メモ「${v.title}」を保存しました。` },
    update_note: { title: "メモ更新", body: () => "メモを更新しました。" },
    search_web: {
      title: "ウェブ検索完了",
      body: (v) => (v.query ? `「${v.query}」を検索しました。` : "ウェブ検索が完了しました。"),
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

const ES: NotificationCopy = {
  unknownSender: "Remitente desconocido",
  newMail: "Correo nuevo",
  urgentMailTitle: "Correo urgente",
  noSubject: "(sin asunto)",
  urgentDigest: (count, who, what) => `${count} correos urgentes. Último: ${who} - ${what}`,
  missedWhileClosed: (count) => `${count} correos urgentes mientras Klorn estaba cerrado`,
  actionComplete: { title: "Acción completada", body: (action) => `${action} ha terminado.` },
  tools: {
    send_email: { title: "Correo enviado", body: (v) => `Se envió "${v.subject}" a ${v.to}.` },
    draft_email: {
      title: "Borrador listo",
      body: (v) => `Se preparó un borrador para ${v.to}. Revísalo antes de enviarlo.`,
    },
    classify_emails: {
      title: "Correo priorizado",
      body: () => "Se actualizó la prioridad de la bandeja de entrada.",
    },
    trash_email: {
      title: "Correo depurado",
      body: (v) =>
        `Se movió ${v.subject ? `"${v.subject}" ` : "un mensaje de baja prioridad "}a la papelera.`,
    },
    create_task: { title: "Tarea añadida", body: (v) => `Se añadió "${v.title}" a las tareas.` },
    update_task: { title: "Tarea actualizada", body: () => "Se actualizó el estado de la tarea." },
    complete_task: {
      title: "Tarea completada",
      body: (v) => (v.title ? `Se completó "${v.title}".` : "Se completó una tarea."),
    },
    create_reminder: {
      title: "Recordatorio creado",
      body: (v) => `Hay un recordatorio para "${v.title}".`,
    },
    create_event: {
      title: "Evento añadido",
      body: (v) => `Se añadió "${v.title}" al calendario.`,
    },
    create_note: { title: "Nota guardada", body: (v) => `Se guardó la nota "${v.title}".` },
    update_note: { title: "Nota actualizada", body: () => "Se actualizó la nota." },
    search_web: {
      title: "Búsqueda web completada",
      body: (v) => (v.query ? `Se buscó "${v.query}".` : "La búsqueda web ha terminado."),
    },
  },
};

const FR: NotificationCopy = {
  unknownSender: "Expéditeur inconnu",
  newMail: "Nouveau message",
  urgentMailTitle: "E-mail urgent",
  noSubject: "(sans objet)",
  urgentDigest: (count, who, what) => `${count} e-mails urgents. Dernier : ${who} - ${what}`,
  missedWhileClosed: (count) => `${count} e-mails urgents pendant que Klorn était fermé`,
  actionComplete: { title: "Action terminée", body: (action) => `${action} est terminé.` },
  tools: {
    send_email: { title: "E-mail envoyé", body: (v) => `« ${v.subject} » envoyé à ${v.to}.` },
    draft_email: {
      title: "Brouillon prêt",
      body: (v) => `Un brouillon pour ${v.to} est prêt. Relisez-le avant l'envoi.`,
    },
    classify_emails: {
      title: "Messages priorisés",
      body: () => "Les priorités de la boîte de réception ont été mises à jour.",
    },
    trash_email: {
      title: "Boîte nettoyée",
      body: (v) =>
        `${v.subject ? `« ${v.subject} » ` : "Un message peu prioritaire "}a été mis à la corbeille.`,
    },
    create_task: { title: "Tâche ajoutée", body: (v) => `« ${v.title} » ajouté aux tâches.` },
    update_task: {
      title: "Tâche mise à jour",
      body: () => "Le statut de la tâche a été mis à jour.",
    },
    complete_task: {
      title: "Tâche terminée",
      body: (v) => (v.title ? `« ${v.title} » terminé.` : "Une tâche a été terminée."),
    },
    create_reminder: {
      title: "Rappel programmé",
      body: (v) => `Un rappel est programmé pour « ${v.title} ».`,
    },
    create_event: {
      title: "Événement ajouté",
      body: (v) => `« ${v.title} » ajouté au calendrier.`,
    },
    create_note: { title: "Note enregistrée", body: (v) => `Note « ${v.title} » enregistrée.` },
    update_note: { title: "Note mise à jour", body: () => "La note a été mise à jour." },
    search_web: {
      title: "Recherche web terminée",
      body: (v) => (v.query ? `« ${v.query} » recherché.` : "La recherche web est terminée."),
    },
  },
};

const DE: NotificationCopy = {
  unknownSender: "Unbekannter Absender",
  newMail: "Neue Mail",
  urgentMailTitle: "Dringende Mail",
  noSubject: "(kein Betreff)",
  urgentDigest: (count, who, what) => `${count} dringende E-Mails. Zuletzt: ${who} - ${what}`,
  missedWhileClosed: (count) => `${count} dringende E-Mails, während Klorn geschlossen war`,
  actionComplete: { title: "Aktion abgeschlossen", body: (action) => `${action} ist fertig.` },
  tools: {
    send_email: { title: "E-Mail gesendet", body: (v) => `„${v.subject}" an ${v.to} gesendet.` },
    draft_email: {
      title: "Entwurf bereit",
      body: (v) => `Ein Entwurf für ${v.to} liegt bereit. Vor dem Senden prüfen.`,
    },
    classify_emails: {
      title: "Mails priorisiert",
      body: () => "Die Priorität des Posteingangs wurde aktualisiert.",
    },
    trash_email: {
      title: "Postfach aufgeräumt",
      body: (v) =>
        `${v.subject ? `„${v.subject}" ` : "Eine unwichtige Nachricht "}in den Papierkorb verschoben.`,
    },
    create_task: {
      title: "Aufgabe hinzugefügt",
      body: (v) => `„${v.title}" zu Aufgaben hinzugefügt.`,
    },
    update_task: {
      title: "Aufgabe aktualisiert",
      body: () => "Der Aufgabenstatus wurde aktualisiert.",
    },
    complete_task: {
      title: "Aufgabe erledigt",
      body: (v) => (v.title ? `„${v.title}" erledigt.` : "Eine Aufgabe wurde erledigt."),
    },
    create_reminder: {
      title: "Erinnerung gesetzt",
      body: (v) => `Eine Erinnerung für „${v.title}" ist gesetzt.`,
    },
    create_event: {
      title: "Termin hinzugefügt",
      body: (v) => `„${v.title}" zum Kalender hinzugefügt.`,
    },
    create_note: { title: "Notiz gespeichert", body: (v) => `Notiz „${v.title}" gespeichert.` },
    update_note: { title: "Notiz aktualisiert", body: () => "Die Notiz wurde aktualisiert." },
    search_web: {
      title: "Websuche abgeschlossen",
      body: (v) => (v.query ? `Nach „${v.query}" gesucht.` : "Die Websuche ist abgeschlossen."),
    },
  },
};

const COPY: Record<NotificationLanguage, NotificationCopy> = {
  en: EN,
  ko: KO,
  ja: JA,
  zh: ZH,
  es: ES,
  fr: FR,
  de: DE,
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
 * "긴급 이메일" (an older Korean title). Rows stay in the table, so a legacy
 * title is never dropped from this list.
 */
const LEGACY_URGENT_EMAIL_TITLES = ["Urgent email", "긴급 이메일"] as const;
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
