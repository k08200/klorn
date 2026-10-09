"use client";

/**
 * What sits around the Mail v2 list: the bar for a keyboard selection, and the
 * single undo notice — a lane move, an archive, or an archive / delete handed
 * back by the reader, in that order of precedence.
 */

import Button from "../../../components/ui/button";
import { useT } from "../../../lib/i18n";
import { UndoBar } from "./undo-bar";
import type { MailActions } from "./use-mail-actions";

interface SelectionBarProps {
  count: number;
  /** Demo rows cannot be changed. */
  readOnly: boolean;
  onMarkRead: () => void;
  onArchive: () => void;
  onClear: () => void;
}

export function SelectionBar({
  count,
  readOnly,
  onMarkRead,
  onArchive,
  onClear,
}: SelectionBarProps) {
  const { t } = useT();
  if (count === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-card border border-line bg-surface-panel py-1 pl-3 pr-1">
      <p className="mr-auto text-label tabular-nums text-ink">
        {t("mailV2.bulk.selected", { count: String(count) })}
      </p>
      <Button variant="ghost" size="sm" disabled={readOnly} onClick={onMarkRead}>
        {t("mailV2.row.markRead")}
      </Button>
      <Button variant="ghost" size="sm" disabled={readOnly} onClick={onArchive}>
        {t("mailV2.row.archive")}
      </Button>
      <Button variant="ghost" size="sm" onClick={onClear}>
        {t("mailV2.bulk.clear")}
      </Button>
    </div>
  );
}

export interface ReaderNotice {
  action: "archive" | "delete";
  subject: string | null;
  busy: boolean;
  onUndo: () => void;
  onDismiss: () => void;
}

interface MailNoticesProps {
  actions: MailActions;
  undoLabel: string;
  reader: ReaderNotice | null;
}

export function MailNotices({ actions, undoLabel, reader }: MailNoticesProps) {
  const { t } = useT();
  const { laneMove, archived } = actions;
  if (laneMove.notice) {
    return (
      <UndoBar
        title={t("undo.lane.moved", { lane: laneMove.notice.tier })}
        detail={laneMove.notice.subject ?? undefined}
        undoLabel={undoLabel}
        busy={laneMove.busy}
        onUndo={() => void laneMove.undo()}
        onDismiss={laneMove.dismiss}
      />
    );
  }
  if (archived) {
    const count = archived.emails.length;
    return (
      <UndoBar
        title={
          count === 1
            ? t("mailV2.archive.done")
            : t("mailV2.archive.doneMany", { count: String(count) })
        }
        detail={archived.emails[0]?.subject}
        undoLabel={undoLabel}
        busy={actions.busy === "undo"}
        onUndo={() => void actions.undoArchive()}
        onDismiss={actions.dismissArchived}
      />
    );
  }
  if (reader) {
    return (
      <UndoBar
        title={t(reader.action === "archive" ? "mailV2.archive.done" : "mailV2.delete.done")}
        detail={reader.subject ?? undefined}
        undoLabel={undoLabel}
        busy={reader.busy}
        onUndo={reader.onUndo}
        onDismiss={reader.onDismiss}
      />
    );
  }
  return null;
}
