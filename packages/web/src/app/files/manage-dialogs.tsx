"use client";

/**
 * The Klorn drive's sheets on /files: "New folder" (into the open folder),
 * and per row "Rename", "Move" and "Delete". One is open at a time. Each
 * request is followed by a fresh read of the lists and the usage, then a
 * toast (role="status") says what happened. A row that left the list (deleted,
 * or moved) takes its menu button with it, so focus lands on the list's name.
 */

import type { DriveFileWire } from "@klorn/contract";
import { type RefObject, useState } from "react";
import { useToast } from "../../components/toast";
import { useT } from "../../lib/i18n";
import { DeleteDialog } from "./delete-dialog";
import { MoveDialog } from "./move-dialog";
import { NameDialog } from "./name-dialog";
import type { FolderCrumb } from "./open";
import {
  createDriveFolder,
  deleteDriveItem,
  updateDriveItem,
  useDriveRefresh,
} from "./use-klorn-drive";

export type RowAction = "rename" | "move" | "delete";
type DialogKind = "folder" | RowAction;

interface DialogState {
  kind: DialogKind;
  file: DriveFileWire | null;
  open: boolean;
  /** The row left the list: focus goes to the list's name, not its gone button. */
  removed: boolean;
}

export function useManageDialogs() {
  const [state, setState] = useState<DialogState | null>(null);
  return {
    state,
    openFolder: () => setState({ kind: "folder", file: null, open: true, removed: false }),
    openRow: (kind: RowAction, file: DriveFileWire) =>
      setState({ kind, file, open: true, removed: false }),
    // The kind and the row stay, so the sheet keeps its content while it closes.
    close: (removed = false) =>
      setState((current) => (current ? { ...current, open: false, removed } : current)),
  };
}

interface ManageDialogsProps {
  dialogs: ReturnType<typeof useManageDialogs>;
  /** The open folder, where a new folder goes; null for the top level. */
  folder: FolderCrumb | null;
  listHeadingRef: RefObject<HTMLElement | null>;
}

export function ManageDialogs({ dialogs, folder, listHeadingRef }: ManageDialogsProps) {
  const { t } = useT();
  const { toast } = useToast();
  const refresh = useDriveRefresh();
  const { state, close } = dialogs;
  const isOpen = (kind: DialogKind) => state?.open === true && state.kind === kind;
  const row = (kind: RowAction) => (state?.kind === kind ? state.file : null);
  const returnFocusRef = state?.removed ? listHeadingRef : undefined;

  const createFolder = async (name: string) => {
    const created = await createDriveFolder({ name, parentExternalId: folder?.externalId ?? null });
    await refresh();
    close();
    toast(t("files.drive.folder.done", { name: created.name }), "success");
  };
  const rename = async (file: DriveFileWire, name: string) => {
    const renamed = await updateDriveItem(file.id, { name });
    await refresh();
    close();
    toast(t("files.drive.rename.done", { name: renamed.name }), "success");
  };
  const move = async (file: DriveFileWire, target: string | null) => {
    await updateDriveItem(file.id, { parentExternalId: target });
    await refresh();
    close(true);
    toast(t("files.drive.move.done", { name: file.name }), "success");
  };
  const remove = async (file: DriveFileWire) => {
    await deleteDriveItem(file.id);
    await refresh();
    close(true);
    toast(t("files.drive.delete.done", { name: file.name }), "success");
  };

  const renaming = row("rename");
  return (
    <>
      <NameDialog
        open={isOpen("folder")}
        title={t("files.drive.folder.title")}
        label={t("files.drive.folder.label")}
        submitLabel={t("files.drive.folder.create")}
        initialName=""
        scope="files.drive.folder"
        onClose={() => close()}
        onSubmit={createFolder}
      />
      <NameDialog
        open={isOpen("rename")}
        title={t("files.drive.rename.title")}
        label={t("files.drive.rename.label")}
        submitLabel={t("files.drive.rename.save")}
        initialName={renaming?.name ?? ""}
        scope="files.drive.rename"
        onClose={() => close()}
        onSubmit={async (name) => {
          if (renaming) await rename(renaming, name);
        }}
      />
      <MoveDialog
        open={isOpen("move")}
        item={row("move")}
        onClose={() => close()}
        onMove={move}
        returnFocusRef={returnFocusRef}
      />
      <DeleteDialog
        open={isOpen("delete")}
        item={row("delete")}
        onClose={() => close()}
        onDelete={remove}
        returnFocusRef={returnFocusRef}
      />
    </>
  );
}
