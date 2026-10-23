"use client";

/**
 * Files dropped onto the /files list go to the same upload as "Upload files"
 * (a pointer shortcut; the button is the complete, keyboard-reachable path).
 * Only a drag that carries files is accepted; a drag of text or a link from
 * the page is left alone, and a dropped folder is skipped (the Mac app's
 * import walks folders; the web sends single files). Nested elements fire
 * enter/leave pairs of their own, so the highlight follows a depth count
 * rather than the last event.
 */

import { type DragEvent, useRef, useState } from "react";

const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");

/** The dropped files, without folders: the web upload sends single files only. */
function droppedFiles(transfer: DataTransfer): File[] {
  const items = Array.from(transfer.items);
  if (items.length === 0) return Array.from(transfer.files);
  return items
    .filter((item) => item.kind === "file" && item.webkitGetAsEntry()?.isDirectory !== true)
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

export function useFileDrop(onFiles: (files: File[]) => void, enabled: boolean) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);

  const reset = () => {
    depth.current = 0;
    setOver(false);
  };

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
      reset();
      const files = droppedFiles(event.dataTransfer);
      if (files.length > 0) onFiles(files);
    },
  };

  return { over: enabled && over, handlers: enabled ? handlers : {} };
}
