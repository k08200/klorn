"use client";

/**
 * Deleting one Klorn drive row, confirmed first (D3: a hard delete, no trash;
 * a folder goes with everything in it). The title names the row, so the
 * dialog's own name says what goes. The sheet stays open, and cannot be
 * dismissed, while the request runs; a refusal is shown in it (role="alert").
 * Sending again continues a delete that storage cut short (503, retryable).
 */

import type { DriveFileWire } from "@klorn/contract";
import type { RefObject } from "react";
import { Sheet } from "../../components/ui/sheet";
import { useT } from "../../lib/i18n";
import { PendingButton } from "./pending-button";
import { useDialogAction } from "./use-dialog-action";

interface DeleteDialogProps {
  open: boolean;
  /** The row being deleted; kept while the sheet closes. */
  item: DriveFileWire | null;
  onClose: () => void;
  /** Deletes it; throws to keep the sheet open with the failure shown. */
  onDelete: (item: DriveFileWire) => Promise<void>;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

export function DeleteDialog({ open, item, onClose, onDelete, returnFocusRef }: DeleteDialogProps) {
  const { t } = useT();
  const action = useDialogAction("files.drive.delete");
  const folder = item?.isFolder === true;
  const name = item?.name ?? "";
  const dismiss = () => {
    if (!action.blocked()) onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={dismiss}
      title={t(folder ? "files.drive.delete.folderTitle" : "files.drive.delete.fileTitle", {
        name,
      })}
      description={t(folder ? "files.drive.delete.folderBody" : "files.drive.delete.fileBody")}
      closeLabel={t("common.close")}
      returnFocusRef={returnFocusRef}
      footer={
        <>
          <PendingButton variant="ghost" unavailable={action.pending} onClick={dismiss}>
            {t("common.cancel")}
          </PendingButton>
          <PendingButton
            variant="danger"
            pending={action.pending}
            onClick={() => {
              if (item !== null) void action.run(() => onDelete(item));
            }}
          >
            {t("files.drive.delete.confirm")}
          </PendingButton>
        </>
      }
    >
      {action.failure && (
        <p
          key={action.failure.attempt}
          role="alert"
          className="text-body text-state-danger-ink [word-break:keep-all]"
        >
          {t(action.failure.key)}
        </p>
      )}
    </Sheet>
  );
}
