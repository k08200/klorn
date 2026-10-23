"use client";

/**
 * A Klorn drive row with its "More actions" menu (ui/menu: arrow keys, Escape,
 * focus back on the button): Rename, Move, Delete. The row itself still opens
 * or downloads (file-row.tsx); the menu sits beside it, never inside it, so no
 * control is nested in another. External rows get no menu (V4).
 */

import type { DriveFileWire } from "@klorn/contract";
import type { ReactNode } from "react";
import { Menu } from "../../components/ui/menu";
import { useT } from "../../lib/i18n";
import type { RowAction } from "./manage-dialogs";

interface ManagedRowProps {
  file: DriveFileWire;
  onAction: (action: RowAction, file: DriveFileWire) => void;
  children: ReactNode;
}

export function ManagedRow({ file, onAction, children }: ManagedRowProps) {
  const { t } = useT();
  const item = (id: RowAction, label: string) => ({
    id,
    label,
    onSelect: () => onAction(id, file),
  });
  return (
    // gap-4 matches the row's own bleed (-mx-4 on its button rows), so its
    // hover fill and focus ring end where the menu button starts.
    <div className="flex items-center gap-4">
      <div className="min-w-0 flex-1">{children}</div>
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
    </div>
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
