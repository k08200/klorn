"use client";

/**
 * "Move" for one Klorn drive row: a folder picker in a Sheet, one level at a
 * time from the drive's top level (GET /api/drive/files?folder=root|<id>
 * &foldersOnly=true, so a page holds folders only). The folder being moved is
 * shown but never opens, so nothing inside it can be picked, and the server
 * refuses any cycle anyway (409 `cycle`, shown like every other refusal).
 * "Move here" is off where the item already is.
 */

import type { DriveFileWire } from "@klorn/contract";
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import Button from "../../components/ui/button";
import { Sheet } from "../../components/ui/sheet";
import { Skeleton, SkeletonGroup } from "../../components/ui/skeleton";
import { useT } from "../../lib/i18n";
import { BlockError } from "../today/block";
import {
  canMoveHere,
  type MoveChoice,
  moveChoices,
  pickerEnter,
  pickerListFolder,
  pickerTarget,
  pickerUp,
} from "./drive-model";
import { FileGlyph } from "./file-row";
import { FOCUSED_HEADING } from "./focus";
import type { FolderCrumb } from "./open";
import { PendingButton } from "./pending-button";
import { useDialogAction } from "./use-dialog-action";
import { type FilesListState, useFolderLevel } from "./use-files";

const SKELETON_KEYS = ["a", "b", "c"];

interface MoveDialogProps {
  open: boolean;
  /** The row being moved; kept while the sheet closes. */
  item: DriveFileWire | null;
  onClose: () => void;
  /** Moves it; throws to keep the sheet open with the failure shown. */
  onMove: (item: DriveFileWire, target: string | null) => Promise<void>;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

export function MoveDialog({ open, item, onClose, onMove, returnFocusRef }: MoveDialogProps) {
  const { t } = useT();
  const placeId = useId();
  const alreadyId = useId();
  const [trail, setTrail] = useState<FolderCrumb[]>([]);
  const placeRef = useRef<HTMLHeadingElement>(null);
  const navigated = useRef(false);
  const action = useDialogAction("files.drive.move");
  const level = useFolderLevel(pickerListFolder(trail), open);
  const target = pickerTarget(trail);
  const allowed = item !== null && canMoveHere(item, target);
  const dismiss = () => {
    if (!action.blocked()) onClose();
  };

  // The button pressed is gone with its level: once the new level is on
  // screen, focus lands on its name. Not on the first render: the sheet
  // places focus when it opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: it must run after each change of level
  useEffect(() => {
    if (!navigated.current) return;
    navigated.current = false;
    placeRef.current?.focus();
  }, [trail]);

  const go = (next: FolderCrumb[]) => {
    navigated.current = true;
    setTrail(next);
  };

  const submit = () => {
    if (item === null || !allowed) return;
    void action.run(() => onMove(item, target));
  };

  return (
    <Sheet
      open={open}
      onClose={dismiss}
      title={t("files.drive.move.title")}
      description={item ? t("files.drive.move.item", { name: item.name }) : undefined}
      closeLabel={t("common.close")}
      returnFocusRef={returnFocusRef}
      footer={
        <>
          <PendingButton variant="ghost" unavailable={action.pending} onClick={dismiss}>
            {t("common.cancel")}
          </PendingButton>
          <PendingButton
            pending={action.pending}
            unavailable={!allowed}
            aria-describedby={allowed ? placeId : `${placeId} ${alreadyId}`}
            onClick={submit}
          >
            {t("files.drive.move.here")}
          </PendingButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex min-h-11 items-center gap-2">
          {trail.length > 0 && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("files.drive.move.up")}
              onClick={() => go(pickerUp(trail))}
            >
              <BackGlyph />
            </Button>
          )}
          <h3
            id={placeId}
            ref={placeRef}
            tabIndex={-1}
            className={`min-w-0 truncate text-body font-semibold text-ink ${FOCUSED_HEADING}`}
          >
            {trail.at(-1)?.name ?? t("files.drive.title")}
          </h3>
        </div>
        {item && !allowed && (
          <p id={alreadyId} className="text-caption text-ink-muted [word-break:keep-all]">
            {t("files.drive.move.already")}
          </p>
        )}
        <FolderLevel
          level={level}
          // Closing turns the list off; the last level stays on screen as the sheet leaves.
          loading={open && level.loading}
          choices={item ? moveChoices(level.files, item) : []}
          onEnter={(folder) => go(pickerEnter(trail, folder))}
        />
        {action.failure && (
          <p
            key={action.failure.attempt}
            role="alert"
            className="text-body text-state-danger-ink [word-break:keep-all]"
          >
            {t(action.failure.key)}
          </p>
        )}
      </div>
    </Sheet>
  );
}

/** One level's folders: each opens, except the folder being moved. */
function FolderLevel({
  level,
  loading,
  choices,
  onEnter,
}: {
  level: FilesListState;
  loading: boolean;
  choices: MoveChoice[];
  onEnter: (folder: DriveFileWire) => void;
}) {
  const { t } = useT();
  if (loading) {
    return (
      <SkeletonGroup label={t("files.loading")} className="flex flex-col gap-2">
        {SKELETON_KEYS.map((key) => (
          <Skeleton key={key} variant="row" />
        ))}
      </SkeletonGroup>
    );
  }
  if (level.failed) return <BlockError message={t("files.error")} onRetry={level.retry} />;
  return (
    <>
      {choices.length === 0 && !level.hasMore && (
        <p className="text-body text-ink-muted">{t("files.drive.move.noFolders")}</p>
      )}
      {choices.length > 0 && (
        <ul className="flex flex-col divide-y divide-line-soft">
          {choices.map((choice) => (
            <li key={choice.folder.id}>
              <FolderChoice choice={choice} onEnter={onEnter} />
            </li>
          ))}
        </ul>
      )}
      {level.hasMore && (
        <PendingButton variant="secondary" pending={level.loadingMore} onClick={level.loadMore}>
          {level.loadingMore ? t("files.loadingMore") : t("files.loadMore")}
        </PendingButton>
      )}
    </>
  );
}

function FolderChoice({
  choice,
  onEnter,
}: {
  choice: MoveChoice;
  onEnter: (folder: DriveFileWire) => void;
}) {
  const { t } = useT();
  const { folder } = choice;
  const body = (
    <>
      <span className="text-ink-muted">
        <FileGlyph folder />
      </span>
      <span className="min-w-0 flex-1 truncate text-left text-body">{folder.name}</span>
    </>
  );
  if (!choice.enterable) {
    return (
      <div className="flex min-h-11 items-center gap-3 py-1 text-ink-muted">
        {body}
        <span className="shrink-0 text-caption">{t("files.drive.move.self")}</span>
      </div>
    );
  }
  return (
    <Button
      variant="ghost"
      aria-label={t("files.openFolder", { name: folder.name })}
      onClick={() => onEnter(folder)}
      className="-mx-3 min-h-11 w-[calc(100%+1.5rem)] justify-start gap-3 rounded-card text-ink"
    >
      {body}
      <ChevronGlyph />
    </Button>
  );
}

function BackGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 3.5 5.5 8l4.5 4.5" />
    </svg>
  );
}

function ChevronGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-4 shrink-0 text-ink-muted"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </svg>
  );
}
