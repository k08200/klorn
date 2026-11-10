"use client";

/**
 * Files dropped onto the /files list go to the same upload as "Upload files"
 * (a pointer shortcut; the button is the complete, keyboard-reachable path).
 * Only a drag that carries files is taken; a drag of text or a link from the
 * page is left alone. A dropped folder is not sent (the Mac app's import
 * walks folders; the web sends single files) and the person is told. While
 * an upload runs there is no highlight, and a drop is refused out loud
 * instead of being lost. Nested elements fire enter/leave pairs of their
 * own, so the highlight follows a depth count rather than the last event.
 */

import { type DragEvent, useRef, useState } from "react";

const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");

/** The dropped files, and how many folders were left out. */
function droppedFiles(transfer: DataTransfer): { files: File[]; folders: number } {
  const items = Array.from(transfer.items);
  if (items.length === 0) return { files: Array.from(transfer.files), folders: 0 };
  const entries = items.filter((item) => item.kind === "file");
  const isFolder = (item: DataTransferItem) => item.webkitGetAsEntry()?.isDirectory === true;
  const files = entries
    .filter((item) => !isFolder(item))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  return { files, folders: entries.filter(isFolder).length };
}

export type DropRefusal = "busy" | "folders";

interface FileDropOptions {
  /** Uploads are offered at all: without them the list takes no drop. */
  enabled: boolean;
  /** An upload is running: no highlight, and a drop is refused. */
  busy: boolean;
  onFiles: (files: File[]) => void;
  onRefused: (reason: DropRefusal) => void;
}

export function useFileDrop({ enabled, busy, onFiles, onRefused }: FileDropOptions) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);

  const handlers = {
    onDragEnter: (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setOver(true);
    },
    onDragOver: (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      // Without this the browser opens the file instead of dropping it here.
      // "copy" even while busy: a "none" drop never fires, so it could not be answered.
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    onDrop: (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth.current = 0;
      setOver(false);
      if (busy) {
        onRefused("busy");
        return;
      }
      const { files, folders } = droppedFiles(event.dataTransfer);
      if (folders > 0) onRefused("folders");
      if (files.length > 0) onFiles(files);
    },
  };

  return { over: enabled && !busy && over, handlers: enabled ? handlers : {} };
}
