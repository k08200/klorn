"use client";

/**
 * Undo notice for the mail list (productization plan §3: optimistic actions
 * with an undo). One at a time, floating above the list so it never shifts the
 * rows; it clears the bottom tab bar on a phone.
 */

import Button from "../../../components/ui/button";
import { useT } from "../../../lib/i18n";

interface UndoBarProps {
  title: string;
  /** What it happened to (a subject); truncated to one line. */
  detail?: string;
  undoLabel: string;
  busy: boolean;
  onUndo: () => void;
  onDismiss: () => void;
  /** Sit above a phone bottom action bar (the reader's) as well as the tab bar. */
  raised?: boolean;
}

export function UndoBar(props: UndoBarProps) {
  const { title, detail, undoLabel, busy, onUndo, onDismiss, raised = false } = props;
  const { t } = useT();
  return (
    <div
      className={`pointer-events-none fixed inset-x-0 z-40 flex justify-center px-4 md:bottom-6 ${
        raised
          ? "bottom-[calc(138px+env(safe-area-inset-bottom))]"
          : "bottom-[calc(74px+env(safe-area-inset-bottom))]"
      }`}
    >
      <div
        role="status"
        className="pointer-events-auto flex w-full max-w-md items-center gap-2 rounded-card border border-line bg-surface-elevated py-1 pl-4 pr-1 shadow-l2"
      >
        <p className="min-w-0 flex-1 truncate text-body text-ink">
          <span className="font-medium">{title}</span>
          {detail && <span className="text-ink-muted"> · {detail}</span>}
        </p>
        <Button variant="ghost" size="sm" onClick={onUndo} loading={busy} className="shrink-0">
          {undoLabel}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("mailV2.dismiss")}
          onClick={onDismiss}
          className="shrink-0"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            className="size-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <path d="m4 4 8 8M12 4l-8 8" />
          </svg>
        </Button>
      </div>
    </div>
  );
}
