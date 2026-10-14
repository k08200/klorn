"use client";

/**
 * Keyboard triage for the mail reader (productization plan §3, P4): the
 * handlers this screen mounts in the hotkey registry. Every action is one the
 * reader already has (next, back, archive, the reply draft box); the hook only
 * binds them, plus the lane move shared with the list.
 */

import { type HotkeyHandler, LANE_HOTKEY_ORDER, laneHotkeyId } from "../../../lib/hotkeys";
import { useT } from "../../../lib/i18n";
import { useHotkeys } from "../../../lib/use-hotkeys";
import type { useLaneMove } from "../use-lane-move";

/** The reply draft box's intent field: the reader's reply entry point. */
export const REPLY_INTENT_INPUT_ID = "email-reply-intent";

export function focusReplyEntry(): void {
  const input = document.getElementById(REPLY_INTENT_INPUT_ID);
  if (!(input instanceof HTMLElement)) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  input.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  input.focus({ preventScroll: true });
}

interface UseDetailTriageOptions {
  active: boolean;
  email: { id: string; subject: string | null } | null;
  /** An action is running, or the mail is demo data: nothing may be changed. */
  blockedReason: string | null;
  hasNext: boolean;
  openNext: () => void;
  back: () => void;
  archive: () => void;
  laneMove: ReturnType<typeof useLaneMove>;
  /** The reader's own undo (after archive / delete), when its banner is up. */
  undoLastAction: (() => void) | null;
}

export function useDetailTriage(options: UseDetailTriageOptions): void {
  const { active, email, laneMove } = options;
  const { t } = useT();

  const laneHandlers = Object.fromEntries(
    LANE_HOTKEY_ORDER.map((lane): [string, HotkeyHandler] => [
      laneHotkeyId(lane),
      {
        // The reader does not show the lane, so the previous lane is not known
        // here; the server restores it on undo.
        run: () => {
          if (email) laneMove.move({ id: email.id, subject: email.subject, tier: null }, lane);
        },
        disabledReason: () => options.blockedReason,
      },
    ]),
  );

  useHotkeys(
    "mail-detail",
    {
      "mail.next": {
        run: options.openNext,
        disabledReason: () => (options.hasNext ? null : t("keys.reason.noNext")),
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
    active && email !== null,
  );
}
