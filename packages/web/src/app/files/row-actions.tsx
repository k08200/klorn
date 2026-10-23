"use client";

/**
 * A row of the /files list while the Klorn drive is on. A Klorn drive row has
 * its "More actions" menu (ui/menu: arrow keys, Escape, focus back on the
 * button): Rename, Move, Delete. The row itself still opens or downloads
 * (file-row.tsx); the menu sits beside it, never inside it, so no control is
 * nested in another. An external row (V4: read-only) gets an empty slot of
 * the same size, so every row's badge lines up and every row is as tall.
 */

import type { DriveFileWire } from "@klorn/contract";
import type { ReactNode } from "react";
import { Menu } from "../../components/ui/menu";
import { useT } from "../../lib/i18n";
import type { RowAction } from "./dialog-state";

interface ManagedRowProps {
  file: DriveFileWire;
  /** A Klorn drive row: it gets the menu; any other row, the empty slot. */
  editable: boolean;
  onAction: (action: RowAction, file: DriveFileWire) => void;
  children: ReactNode;
}

/** The menu button's frame (ui/menu `icon`): 36px, 44px on a coarse pointer. */
const SLOT_CLASS = "flex size-9 shrink-0 items-center pointer-coarse:size-11";

export function ManagedRow({ file, editable, onAction, children }: ManagedRowProps) {
  return (
    // gap-4 clears the row's own bleed (at most -mx-3.5, file-row.tsx), so its
    // hover fill and focus ring end before the menu button starts.
    <div className="flex items-center gap-4">
      <div className="min-w-0 flex-1">{children}</div>
      <div className={SLOT_CLASS}>
        {editable ? <RowMenu file={file} onAction={onAction} /> : null}
      </div>
    </div>
  );
}

function RowMenu({
  file,
  onAction,
}: {
  file: DriveFileWire;
  onAction: (action: RowAction, file: DriveFileWire) => void;
}) {
  const { t } = useT();
  const item = (id: RowAction, label: string) => ({
    id,
    label,
    onSelect: () => onAction(id, file),
  });
  return (
    <Menu
      variant="icon"
      align="end"
      label={t("files.drive.actions", { name: file.name })}
      sections={[
        {
          id: "manage",
          items: [
            item("rename", t("files.drive.rename")),
            item("move", t("files.drive.move")),
            item("delete", t("files.drive.delete")),
          ],
        },
      ]}
    >
      <MoreGlyph />
    </Menu>
  );
}

function MoreGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="currentColor">
      <circle cx="3.5" cy="8" r="1.25" />
      <circle cx="8" cy="8" r="1.25" />
      <circle cx="12.5" cy="8" r="1.25" />
    </svg>
  );
}
