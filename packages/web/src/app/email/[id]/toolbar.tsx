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

import { EmailActionButton, senderName } from "./atoms";
import {
  EMAIL_REMINDER_OPTIONS,
  type EmailDetail,
  type EmailReminderKey,
  type EmailReminderOption,
  type NextEmailSummary,
  type UndoNotice,
} from "./types";

export function UndoActionBanner({
  notice,
  busy,
  onDismiss,
  onUndo,
}: {
  notice: UndoNotice;
  busy: boolean;
  onDismiss: () => void;
  onUndo: () => void;
}) {
  const actionLabel = notice.action === "archive" ? "archived" : "moved to trash";
  return (
    <div className="mb-4 flex flex-col gap-3 rounded-lg border border-accent-light/30 bg-sky-50 px-4 py-3 text-sm text-slate-900 shadow-lg shadow-black/10 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="font-medium">Email {actionLabel}.</p>
        {notice.subject && (
          <p className="mt-0.5 truncate text-xs text-slate-500">{notice.subject}</p>
        )}
      </div>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          onClick={onUndo}
          disabled={busy}
          className="min-h-10 rounded-md bg-accent-light px-3 text-xs font-semibold text-stone-950 transition hover:bg-accent-muted disabled:opacity-50"
        >
          {busy ? "Restoring..." : "Undo"}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={busy}
          className="min-h-10 rounded-md border border-slate-200 px-3 text-xs text-slate-500 transition hover:bg-slate-100 disabled:opacity-50"
        >
          Dismiss
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
}: {
  busyAction: string | null;
  email: EmailDetail;
  nextEmail: NextEmailSummary | null;
  onArchive: () => void;
  onDelete: () => void;
  onOpenNext: () => void;
  onToggleRead: () => void;
  onToggleStar: () => void;
}) {
  const disabled = busyAction !== null;
  const isDemo = email.id.startsWith("demo-");
  const actionDisabled = disabled || isDemo;
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2 text-xs text-slate-400">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            email.isRead ? "bg-slate-300" : "bg-accent"
          }`}
        />
        <span className="truncate">
          {isDemo ? "Demo email" : email.isRead ? "Read email" : "Unread email"}
          {email.isStarred ? " · Starred" : ""}
          {nextEmail ? ` · Next: ${senderName(nextEmail.from)}` : ""}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <EmailActionButton
          busy={busyAction === "read"}
          disabled={actionDisabled}
          onClick={onToggleRead}
        >
          {email.isRead ? "Unread" : "Read"}
        </EmailActionButton>
        <EmailActionButton
          busy={busyAction === "star"}
          disabled={actionDisabled}
          onClick={onToggleStar}
        >
          {email.isStarred ? "Unstar" : "Star"}
        </EmailActionButton>
        <EmailActionButton
          busy={busyAction === "archive"}
          disabled={actionDisabled}
          onClick={onArchive}
        >
          Archive
        </EmailActionButton>
        <EmailActionButton
          busy={busyAction === "delete"}
          danger
          disabled={actionDisabled}
          onClick={onDelete}
        >
          Delete
        </EmailActionButton>
        {nextEmail && (
          <EmailActionButton busy={false} disabled={disabled} onClick={onOpenNext}>
            Next
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
  return (
    <div className="mb-4 flex flex-col gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
      <span className="font-medium text-slate-500">Remind me</span>
      <div className="flex flex-wrap gap-1.5">
        {EMAIL_REMINDER_OPTIONS.map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => onCreate(option)}
            disabled={disabled || busyKey !== null}
            className="min-h-9 rounded-md border border-slate-200 bg-slate-50 px-3 text-xs text-slate-500 transition hover:border-[#a8a29e]/35 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {busyKey === option.key ? "Setting..." : option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
