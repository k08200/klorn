"use client";

/**
 * Deleting one Klorn drive row, confirmed first (D3: a hard delete, no trash;
 * a folder goes with everything in it). The sheet stays open while the
 * request runs and on a refusal, which it shows (role="alert"); sending again
 * continues a delete that storage cut short (503, retryable).
 */

import type { DriveFileWire } from "@klorn/contract";
import { type RefObject, useEffect, useState } from "react";
import Button from "../../components/ui/button";
import { Sheet } from "../../components/ui/sheet";
import { useT } from "../../lib/i18n";
import type { DriveMessageKey } from "./drive-errors";
import { FileGlyph } from "./file-row";
import { reportDriveError } from "./use-klorn-drive";

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
  const [errorKey, setErrorKey] = useState<DriveMessageKey | null>(null);
  const [pending, setPending] = useState(false);
  const folder = item?.isFolder === true;

  useEffect(() => {
    if (!open) return;
    setErrorKey(null);
    setPending(false);
  }, [open]);

  const submit = async () => {
    if (item === null || pending) return;
    setPending(true);
    setErrorKey(null);
    try {
      await onDelete(item);
    } catch (err) {
      setErrorKey(reportDriveError(err, "files.drive.delete"));
    } finally {
      setPending(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t(folder ? "files.drive.delete.folderTitle" : "files.drive.delete.fileTitle")}
      description={t(folder ? "files.drive.delete.folderBody" : "files.drive.delete.fileBody")}
      closeLabel={t("common.close")}
      returnFocusRef={returnFocusRef}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="danger" onClick={() => void submit()} loading={pending}>
            {t("files.drive.delete.confirm")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {item && (
          <p className="flex items-start gap-3 text-body text-ink">
            <span className="pt-px text-ink-muted">
              <FileGlyph folder={folder} />
            </span>
            <span className="min-w-0 [overflow-wrap:anywhere]">{item.name}</span>
          </p>
        )}
        {errorKey && (
          <p role="alert" className="text-body text-state-danger-ink [word-break:keep-all]">
            {t(errorKey)}
          </p>
        )}
      </div>
    </Sheet>
  );
}
