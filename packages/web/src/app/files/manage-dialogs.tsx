"use client";

/**
 * The Klorn drive's sheets on /files: "New folder" (into the open folder),
 * and per row "Rename", "Move" and "Delete". One is open at a time and each
 * opening mounts a fresh sheet (dialog-state.ts tokens): nothing carries over
 * from the last one, and an answer closes only the sheet that asked for it.
 * Each success reads the lists and the usage again, closes the sheet, and a
 * toast (role="status") says what happened. A row that left the list takes
 * its menu button with it, so focus goes to the next row (else the previous,
 * else the Klorn Drive heading). A refusal that says the list is out of date
 * (the row is gone, a delete cut short) reads it again too.
 */

import type { DriveFileWire } from "@klorn/contract";
import { type RefObject, useRef, useState } from "react";
import { useToast } from "../../components/toast";
import { useT } from "../../lib/i18n";
import { DeleteDialog } from "./delete-dialog";
import { closeDialog, type DialogState, openDialog, type RowAction } from "./dialog-state";
import { driveErrorKey } from "./drive-errors";
import {
  type DriveChange,
  neighborId,
  refreshesAfterFailure,
  removesFromList,
} from "./drive-model";
import { rowFocusTarget } from "./focus";
import { MoveDialog } from "./move-dialog";
import { NameDialog } from "./name-dialog";
import type { FolderCrumb } from "./open";
import {
  createDriveFolder,
  deleteDriveItem,
  updateDriveItem,
  useDriveRefresh,
} from "./use-klorn-drive";

export function useManageDialogs() {
  const [state, setState] = useState<DialogState | null>(null);
  return {
    state,
    openFolder: () => setState((current) => openDialog(current, "folder", null)),
    openRow: (kind: RowAction, file: DriveFileWire) =>
      setState((current) => openDialog(current, kind, file)),
    close: (token: number) => setState((current) => closeDialog(current, token)),
  };
}

interface ManageDialogsProps {
  dialogs: ReturnType<typeof useManageDialogs>;
  /** The open folder, where a new folder goes; null for the top level. */
  folder: FolderCrumb | null;
  /** The ids of the rows on screen, in order: where focus goes when one leaves. */
  rowIds: readonly string[];
  listRef: RefObject<HTMLElement | null>;
  /** Visible, focusable: where focus goes when no row is left to take it. */
  fallbackFocusRef: RefObject<HTMLElement | null>;
}

export function ManageDialogs(props: ManageDialogsProps) {
  const { t } = useT();
  const { toast } = useToast();
  const refresh = useDriveRefresh();
  const returnTo = useRef<HTMLElement | null>(null);
  const { state, close } = props.dialogs;
  if (state === null) return null;
  const { token, file } = state;

  /** The request, then a fresh read; a refusal that dates the list reads it too. */
  const send = async (change: DriveChange | "folder", request: () => Promise<void>) => {
    try {
      await request();
    } catch (err) {
      if (change !== "folder" && refreshesAfterFailure(change, driveErrorKey(err))) {
        void refresh();
      }
      throw err;
    }
    await refresh();
  };

  /** Where focus goes once the sheet closes: null keeps the sheet's own (the opener). */
  const settle = (change: DriveChange | "folder", row: DriveFileWire | null) => {
    returnTo.current = null;
    if (row === null || change === "folder" || !removesFromList(change, props.folder !== null)) {
      return;
    }
    const next = neighborId(props.rowIds, row.id);
    returnTo.current =
      rowFocusTarget(props.listRef.current, next) ?? props.fallbackFocusRef.current;
  };

  const finish = (change: DriveChange | "folder", row: DriveFileWire | null, message: string) => {
    settle(change, row);
    close(token);
    toast(message, "success");
  };

  const common = { open: state.open, onClose: () => close(token) };
  switch (state.kind) {
    case "folder":
      return (
        <NameDialog
          key={token}
          {...common}
          title={t("files.drive.folder.title")}
          label={t("files.drive.folder.label")}
          submitLabel={t("files.drive.folder.create")}
          initialName=""
          scope="files.drive.folder"
          onSubmit={async (name) => {
            let created = name;
            await send("folder", async () => {
              const parentExternalId = props.folder?.externalId ?? null;
              created = (await createDriveFolder({ name, parentExternalId })).name;
            });
            finish("folder", null, t("files.drive.folder.done", { name: created }));
          }}
        />
      );
    case "rename":
      return (
        <NameDialog
          key={token}
          {...common}
          title={t("files.drive.rename.title")}
          label={t("files.drive.rename.label")}
          submitLabel={t("files.drive.rename.save")}
          initialName={file?.name ?? ""}
          scope="files.drive.rename"
          onSubmit={async (name) => {
            if (file === null) return;
            let renamed = name;
            await send("rename", async () => {
              renamed = (await updateDriveItem(file.id, { name })).name;
            });
            finish("rename", file, t("files.drive.rename.done", { name: renamed }));
          }}
        />
      );
    case "move":
      return (
        <MoveDialog
          key={token}
          {...common}
          item={file}
          returnFocusRef={returnTo}
          onMove={async (item, target) => {
            await send("move", async () => {
              await updateDriveItem(item.id, { parentExternalId: target });
            });
            finish("move", item, t("files.drive.move.done", { name: item.name }));
          }}
        />
      );
    case "delete":
      return (
        <DeleteDialog
          key={token}
          {...common}
          item={file}
          returnFocusRef={returnTo}
          onDelete={async (item) => {
            await send("delete", async () => {
              await deleteDriveItem(item.id);
            });
            finish("delete", item, t("files.drive.delete.done", { name: item.name }));
          }}
        />
      );
  }
}
