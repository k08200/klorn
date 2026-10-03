"use client";

/**
 * Keyboard triage for the mail list (productization plan §3, P4): the cursor
 * (j / k), range selection (x, Shift+j / k) and the handlers this screen mounts
 * in the hotkey registry. It owns no mail action itself — archive, lane move,
 * undo, compose and search are the page's existing entry points, passed in.
 */

import type { EmailListItem, LiveTier } from "@klorn/contract";
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
import { type HotkeyHandler, LANE_HOTKEY_ORDER, laneHotkeyId } from "../../lib/hotkeys";
import { useT } from "../../lib/i18n";
import { useHotkeys } from "../../lib/use-hotkeys";

interface UseListTriageOptions {
  active: boolean;
  /** The rows on screen, in order. Empty in the threads view. */
  emails: readonly EmailListItem[];
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
  open: (email: EmailListItem, intent?: "reply") => void;
  archive: (email: EmailListItem) => void;
  /** null when archive is available, otherwise why not. */
  archiveBlockedReason: (email: EmailListItem) => string | null;
  /** null when lanes can be changed, otherwise why not (demo data). */
  laneBlockedReason: () => string | null;
  moveLane: (email: EmailListItem, tier: LiveTier) => void;
  undo: () => void;
  canUndo: boolean;
  compose: () => void;
  focusSearch: () => void;
}

/** Marks the desktop row the cursor is on; used to scroll it into view. */
export const TRIAGE_ROW_ATTR = "data-triage-row";

export function useListTriage(options: UseListTriageOptions): { cursorId: string | null } {
  const { active, emails, setSelectedIds } = options;
  const { t } = useT();
  const [cursorId, setCursorId] = useState<string | null>(null);
  // Where the cursor was, so it can stay put when its row leaves the list.
  const lastIndex = useRef(0);

  const index = cursorId ? emails.findIndex((email) => email.id === cursorId) : -1;
  const current = index >= 0 ? emails[index] : null;

  useEffect(() => {
    if (index >= 0) lastIndex.current = index;
  }, [index]);

  // The cursor's row was archived or filtered away: move to the row that took
  // its place rather than dropping the user back to the top.
  useEffect(() => {
    if (!active || cursorId === null || index >= 0) return;
    const fallback = emails[Math.min(lastIndex.current, emails.length - 1)];
    setCursorId(fallback?.id ?? null);
  }, [active, cursorId, index, emails]);

  useEffect(() => {
    if (!active || !cursorId) return;
    const row = document.querySelector(`[${TRIAGE_ROW_ATTR}="${CSS.escape(cursorId)}"]`);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    row?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [active, cursorId]);

  const step = (delta: 1 | -1, extend: boolean) => {
    if (emails.length === 0) return;
    const from = index;
    const to = from < 0 ? 0 : Math.max(0, Math.min(emails.length - 1, from + delta));
    const target = emails[to];
    setCursorId(target.id);
    if (!extend) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (from >= 0) next.add(emails[from].id);
      next.add(target.id);
      return next;
    });
  };

  const noCursor = () => (current ? null : t("keys.reason.noSelection"));
  const onCurrent = (run: (email: EmailListItem) => void): HotkeyHandler => ({
    run: () => {
      if (current) run(current);
    },
    disabledReason: noCursor,
  });

  const laneHandlers = Object.fromEntries(
    LANE_HOTKEY_ORDER.map((lane): [string, HotkeyHandler] => [
      laneHotkeyId(lane),
      {
        run: () => {
          if (current && current.tier !== lane) options.moveLane(current, lane);
        },
        disabledReason: () =>
          noCursor() ??
          options.laneBlockedReason() ??
          (current?.tier ? null : t("keys.reason.notClassified")),
      },
    ]),
  );

  useHotkeys(
    "mail-list",
    {
      "mail.next": { run: () => step(1, false) },
      "mail.prev": { run: () => step(-1, false) },
      "select.extendDown": { run: () => step(1, true) },
      "select.extendUp": { run: () => step(-1, true) },
      "select.toggle": onCurrent((email) =>
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(email.id)) next.delete(email.id);
          else next.add(email.id);
          return next;
        }),
      ),
      "mail.open": onCurrent((email) => options.open(email)),
      "mail.reply": onCurrent((email) => options.open(email, "reply")),
      "mail.done": {
        run: () => {
          if (current) options.archive(current);
        },
        disabledReason: () =>
          noCursor() ?? (current ? options.archiveBlockedReason(current) : null),
      },
      "mail.back": {
        run: () => {
          setSelectedIds(new Set());
          setCursorId(null);
        },
      },
      "mail.undo": {
        run: options.undo,
        disabledReason: () => (options.canUndo ? null : t("keys.reason.nothingToUndo")),
      },
      "mail.compose": { run: options.compose },
      "mail.search": { run: options.focusSearch },
      ...laneHandlers,
    },
    active,
  );

  return { cursorId: active ? cursorId : null };
}
