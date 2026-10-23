"use client";

/**
 * The Klorn drive's sheets on /files: "New folder" (into the open folder),
 * and per row "Rename", "Move" and "Delete". One is open at a time and each
 * opening mounts a fresh sheet (dialog-state.ts tokens): nothing carries over
 * from the last one, and an answer closes only the sheet that asked for it.
 * Each request has a deadline (drive-timeout.ts: 30 s, a delete 60 s), so a
 * stalled one cannot hold its sheet. Each success reads the lists and the
 * usage again, closes the sheet, and a toast (role="status") says what
 * happened. A row that left the list takes its menu button with it, so focus
 * goes to the nearest row still there (else the opener, else the Klorn Drive
 * heading). A refusal that says the list is out of date (the row or the
 * folder is gone, a delete cut short, a timeout) reads it again too.
 */

import type { DriveFileWire } from "@klorn/contract";
import { type RefObject, useEffect, useRef, useState } from "react";
import { useToast } from "../../components/toast";
import { useT } from "../../lib/i18n";
import { DeleteDialog } from "./delete-dialog";
import { closeDialog, type DialogState, openDialog, type RowAction } from "./dialog-state";
import { driveErrorKey } from "./drive-errors";
import {
  createFailureKey,
  type DriveWrite,
  focusCandidates,
  refreshesAfterFailure,
  removesFromList,
} from "./drive-model";
import { DELETE_TIMEOUT_MS, EDIT_TIMEOUT_MS, withTimeout } from "./drive-timeout";
import { afterRender, firstRowTarget } from "./focus";
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

const TIMEOUT_MS: Readonly<Record<DriveWrite, number>> = {
  create: EDIT_TIMEOUT_MS,
  rename: EDIT_TIMEOUT_MS,
  move: EDIT_TIMEOUT_MS,
  delete: DELETE_TIMEOUT_MS,
};

export function ManageDialogs(props: ManageDialogsProps) {
  const { t } = useT();
  const { toast } = useToast();
  const refresh = useDriveRefresh();
  // Where focus goes when the open sheet closes; null: its opener (Sheet).
  const returnTo = useRef<HTMLElement | null>(null);
  const { state, close } = props.dialogs;
  const token = state?.token ?? 0;
  // Each opening starts from its own opener: a target an earlier sheet chose
  // (a deleted row's neighbour) never carries over to a sheet that is cancelled.
  useEffect(() => {
    if (token > 0) returnTo.current = null;
  }, [token]);
  if (state === null) return null;
  const { file } = state;

  /** The request within its deadline, then a fresh read; a refusal that dates the list reads it too. */
  const send = async <T,>(write: DriveWrite, request: (signal: AbortSignal) => Promise<T>) => {
    let answer: T;
    try {
      answer = await withTimeout(TIMEOUT_MS[write], request);
    } catch (err) {
      if (refreshesAfterFailure(write, driveErrorKey(err))) void refresh();
      throw err;
    }
    await refresh();
    return answer;
  };

  /**
   * Closes the sheet. A row that left the list hands focus to the nearest row
   * still on screen once the fresh list has rendered (rows the change took
   * with it, such as a deleted folder's files, are gone by then), else the
   * Sheet falls back to the opener, then the Klorn Drive heading.
   */
  const finish = async (write: DriveWrite, row: DriveFileWire | null, message: string) => {
    if (row !== null && write !== "create" && removesFromList(write, props.folder !== null)) {
      await afterRender();
      returnTo.current = firstRowTarget(
        props.listRef.current,
        focusCandidates(props.rowIds, row.id),
      );
    }
    close(token);
    toast(message, "success");
  };

  const common = {
    open: state.open,
    onClose: () => close(token),
    returnFocusRef: returnTo,
    fallbackFocusRef: props.fallbackFocusRef,
  };
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
          failureKey={createFailureKey}
          onSubmit={async (name) => {
            const parentExternalId = props.folder?.externalId ?? null;
            const created = await send("create", (signal) =>
              createDriveFolder({ name, parentExternalId }, signal),
            );
            await finish("create", null, t("files.drive.folder.done", { name: created.name }));
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
            const renamed = await send("rename", (signal) =>
              updateDriveItem(file.id, { name }, signal),
            );
            await finish("rename", file, t("files.drive.rename.done", { name: renamed.name }));
          }}
        />
      );
    case "move":
      return (
        <MoveDialog
          key={token}
          {...common}
          item={file}
          onMove={async (item, target) => {
            await send("move", (signal) =>
              updateDriveItem(item.id, { parentExternalId: target }, signal),
            );
            await finish("move", item, t("files.drive.move.done", { name: item.name }));
          }}
        />
      );
    case "delete":
      return (
        <DeleteDialog
          key={token}
          {...common}
          item={file}
          onDelete={async (item) => {
            await send("delete", (signal) => deleteDriveItem(item.id, signal));
            await finish("delete", item, t("files.drive.delete.done", { name: item.name }));
          }}
        />
      );
  }
}
