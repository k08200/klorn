/**
 * Toolbar cluster for the email detail page.
 *
 * Three siblings extracted 2026-05-19 from page.tsx (#327 follow-up):
 *   - UndoActionBanner          — appears after archive/delete with an Undo CTA
 *   - EmailActionToolbar        — the Read/Star/Archive/Delete/Next row
 *   - EmailReminderQuickActions — the "Remind me" chip row
 *
 * Each is a controlled component: parent owns busy state and callbacks.
 */

import { useT } from "../../../lib/i18n";
import { EmailActionButton, senderName } from "./atoms";
import {
  EMAIL_REMINDER_OPTIONS,
  type EmailDetail,
  type EmailReminderKey,
  type EmailReminderOption,
  type NextEmailSummary,
} from "./types";

export function UndoActionBanner({
  title,
  subject,
  undoLabel,
  busy,
  onDismiss,
  onUndo,
}: {
  /** What happened: "Email archived.", or with KEYBOARD_TRIAGE "Moved to QUEUE". */
  title: string;
  subject: string | null;
  /** Defaults to "Undo"; the keyboard path names its key ("Undo (z)"). */
  undoLabel?: string;
  busy: boolean;
  onDismiss: () => void;
  onUndo: () => void;
}) {
  const { t } = useT();
  return (
    <div
      role="status"
      className="mb-4 flex flex-col gap-3 rounded-lg border border-accent-light/30 bg-state-info-bg px-4 py-3 text-sm text-ink shadow-lg shadow-black/10 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0">
        <p className="font-medium">{title}</p>
        {subject && <p className="mt-0.5 truncate text-xs text-ink-mid">{subject}</p>}
      </div>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          onClick={onUndo}
          disabled={busy}
          className="min-h-10 rounded-md bg-accent-solid px-3 text-xs font-semibold text-accent-solid-ink transition hover:bg-accent-solid-hover disabled:opacity-50 focus-ring"
        >
          {busy
            ? t("emailDetail.toolbar.undo.restoring")
            : (undoLabel ?? t("emailDetail.toolbar.undo.undo"))}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={busy}
          className="min-h-10 rounded-md border border-line px-3 text-xs text-ink-mid transition hover:bg-surface-hover disabled:opacity-50 focus-ring"
        >
          {t("emailDetail.toolbar.undo.dismiss")}
        </button>
      </div>
    </div>
  );
}

export function EmailActionToolbar({
  busyAction,
  email,
  nextEmail,
  onArchive,
  onDelete,
  onOpenNext,
  onToggleRead,
  onToggleStar,
  onUnsubscribe,
}: {
  busyAction: string | null;
  email: EmailDetail;
  nextEmail: NextEmailSummary | null;
  onArchive: () => void;
  onDelete: () => void;
  onOpenNext: () => void;
  onToggleRead: () => void;
  onUnsubscribe: () => void;
  onToggleStar: () => void;
}) {
  const { t } = useT();
  const disabled = busyAction !== null;
  const isDemo = email.id.startsWith("demo-");
  const actionDisabled = disabled || isDemo;
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface-raised px-3 py-2">
      <div className="flex min-w-0 items-center gap-2 text-xs text-ink-dim">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            email.isRead ? "bg-slate-300" : "bg-accent"
          }`}
        />
        <span className="truncate">
          {isDemo
            ? t("emailDetail.toolbar.status.demo")
            : email.isRead
              ? t("emailDetail.toolbar.status.read")
              : t("emailDetail.toolbar.status.unread")}
          {email.isStarred ? t("emailDetail.toolbar.starredSuffix") : ""}
          {nextEmail
            ? t("emailDetail.toolbar.nextSuffix", { name: senderName(nextEmail.from) })
            : ""}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <EmailActionButton
          busy={busyAction === "read"}
          disabled={actionDisabled}
          onClick={onToggleRead}
        >
          {email.isRead
            ? t("emailDetail.toolbar.action.unreadLabel")
            : t("emailDetail.status.read")}
        </EmailActionButton>
        <EmailActionButton
          busy={busyAction === "star"}
          disabled={actionDisabled}
          onClick={onToggleStar}
        >
          {email.isStarred
            ? t("emailDetail.toolbar.action.unstar")
            : t("emailDetail.toolbar.action.star")}
        </EmailActionButton>
        <EmailActionButton
          busy={busyAction === "archive"}
          disabled={actionDisabled}
          onClick={onArchive}
        >
          {t("emailDetail.toolbar.action.archive")}
        </EmailActionButton>
        {email.unsubscribe && (
          <EmailActionButton
            busy={busyAction === "unsubscribe"}
            disabled={actionDisabled}
            onClick={onUnsubscribe}
          >
            {t("emailDetail.toolbar.action.unsubscribe")}
          </EmailActionButton>
        )}
        <EmailActionButton
          busy={busyAction === "delete"}
          danger
          disabled={actionDisabled}
          onClick={onDelete}
        >
          {t("common.delete")}
        </EmailActionButton>
        {nextEmail && (
          <EmailActionButton busy={false} disabled={disabled} onClick={onOpenNext}>
            {t("emailDetail.toolbar.action.next")}
          </EmailActionButton>
        )}
      </div>
    </div>
  );
}

export function EmailReminderQuickActions({
  busyKey,
  disabled,
  onCreate,
}: {
  busyKey: EmailReminderKey | null;
  disabled: boolean;
  onCreate: (option: EmailReminderOption) => void;
}) {
  const { t } = useT();
  return (
    <div className="mb-4 flex flex-col gap-2 rounded-lg border border-line bg-surface-raised px-3 py-2 text-xs text-ink-mid sm:flex-row sm:items-center sm:justify-between">
      <span className="font-medium text-ink-mid">{t("emailDetail.toolbar.remindMe")}</span>
      <div className="flex flex-wrap gap-1.5">
        {EMAIL_REMINDER_OPTIONS.map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => onCreate(option)}
            disabled={disabled || busyKey !== null}
            className="min-h-9 rounded-md border border-line bg-surface-raised px-3 text-xs text-ink-mid transition hover:border-line-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-45 focus-ring"
          >
            {busyKey === option.key ? t("emailDetail.toolbar.settingReminder") : option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
