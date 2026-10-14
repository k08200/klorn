"use client";

/**
 * Keyboard triage for the Mail v2 reader (productization plan §3, P5b): the
 * same registry as the list and the legacy reader, so the `?` sheet and the
 * palette describe this screen without a second key table. J / K walk the list
 * view the reader was opened from; 1–5 move the lane, which is refused with a
 * reason while the mail has no lane yet.
 */

import type { LiveTier } from "@klorn/contract";
import { type HotkeyHandler, LANE_HOTKEY_ORDER, laneHotkeyId } from "../../../../lib/hotkeys";
import { useT } from "../../../../lib/i18n";
import { useHotkeys } from "../../../../lib/use-hotkeys";
import type { useLaneMove } from "../../use-lane-move";
import { focusReplyEntry } from "../use-detail-triage";

interface UseReaderTriageOptions {
  active: boolean;
  email: { id: string; subject: string | null } | null;
  /** The recorded lane; null while the mail is unsorted or the context is loading. */
  tier: LiveTier | null;
  /** An action is running, or the mail is demo data: nothing may be changed. */
  blockedReason: string | null;
  olderId: string | null;
  newerId: string | null;
  open: (emailId: string) => void;
  back: () => void;
  archive: () => void;
  laneMove: ReturnType<typeof useLaneMove>;
  /** The reader's own undo (after archive / delete), when its notice is up. */
  undoLastAction: (() => void) | null;
}

export function useReaderTriage(options: UseReaderTriageOptions): void {
  const { active, email, tier, laneMove, olderId, newerId } = options;
  const { t } = useT();

  const laneHandlers = Object.fromEntries(
    LANE_HOTKEY_ORDER.map((lane): [string, HotkeyHandler] => [
      laneHotkeyId(lane),
      {
        run: () => {
          if (email && tier && tier !== lane) laneMove.move({ ...email, tier }, lane);
        },
        disabledReason: () =>
          options.blockedReason ?? (tier ? null : t("keys.reason.notClassified")),
      },
    ]),
  );

  const mounted = active && email !== null;
  useHotkeys(
    "mail-detail",
    {
      "mail.next": {
        run: () => {
          if (olderId) options.open(olderId);
        },
        disabledReason: () => (olderId ? null : t("mailV2.reader.noNext")),
      },
      "mail.back": { run: options.back },
      "mail.done": { run: options.archive, disabledReason: () => options.blockedReason },
      "mail.reply": { run: focusReplyEntry },
      "mail.undo": {
        run: () => {
          if (laneMove.notice) void laneMove.undo();
          else options.undoLastAction?.();
        },
        disabledReason: () =>
          laneMove.notice || options.undoLastAction ? null : t("keys.reason.nothingToUndo"),
      },
      ...laneHandlers,
    },
    mounted,
  );
  useHotkeys(
    "mail-reader",
    {
      "mail.prev": {
        run: () => {
          if (newerId) options.open(newerId);
        },
        disabledReason: () => (newerId ? null : t("mailV2.reader.noPrev")),
      },
    },
    mounted,
  );
}
