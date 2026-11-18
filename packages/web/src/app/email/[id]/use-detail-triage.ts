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
import { FOLDED_QUERY, PHONE_QUERY } from "./_v2/reply-composer";

/** The reply draft box's intent field: the reader's reply entry point. */
export const REPLY_INTENT_INPUT_ID = "email-reply-intent";

/**
 * Fired when the reply box is asked for but is not on the page: on a phone
 * (and a half-folded screen) it lives in a sheet the reader opens on this
 * event (_v2/reply-composer.tsx).
 */
export const REPLY_ENTRY_EVENT = "klorn:reply-entry";

/**
 * A request made before the reader has switched to the sheet (its media query
 * is read after the first render): kept until the reader takes it.
 */
let pendingReplyEntry = false;

export function takeReplyEntryRequest(): boolean {
  const pending = pendingReplyEntry;
  pendingReplyEntry = false;
  return pending;
}

export function focusReplyEntry(): void {
  const composerElsewhere =
    window.matchMedia(PHONE_QUERY).matches || window.matchMedia(FOLDED_QUERY).matches;
  const input = document.getElementById(REPLY_INTENT_INPUT_ID);
  if (composerElsewhere && !input?.closest('[role="dialog"]')) {
    pendingReplyEntry = true;
    window.dispatchEvent(new Event(REPLY_ENTRY_EVENT));
    return;
  }
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
