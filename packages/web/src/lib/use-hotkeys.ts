"use client";

import { useEffect, useRef } from "react";
import { useAuth } from "./auth";
import { type HotkeyHandler, type HotkeyScope, hotkeyRegistry } from "./hotkeys";

/**
 * Whether keyboard triage is on for this session. Server-driven: the API
 * reports its KEYBOARD_TRIAGE flag on GET /api/auth/me. Anything but an
 * explicit `true` (older API, signed out, still loading) is off.
 */
export function useKeyboardTriage(): boolean {
  return useAuth().user?.keyboardTriage === true;
}

/**
 * Mount a surface's handlers in the app-wide hotkey registry while `active`.
 *
 * The registered entries are stable proxies that call the latest handlers, so
 * a page can pass a fresh object every render without re-registering, and a
 * handler always sees current state. Re-registers only when the set of ids
 * changes.
 */
export function useHotkeys(
  scope: HotkeyScope,
  handlers: Readonly<Record<string, HotkeyHandler>>,
  active: boolean,
): void {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });
  const ids = Object.keys(handlers).sort().join("|");

  useEffect(() => {
    if (!active || ids === "") return;
    const proxies = Object.fromEntries(
      ids.split("|").map((id): [string, HotkeyHandler] => [
        id,
        {
          run: () => latest.current[id]?.run(),
          disabledReason: () => latest.current[id]?.disabledReason?.() ?? null,
        },
      ]),
    );
    return hotkeyRegistry.register(scope, proxies);
  }, [scope, active, ids]);
}
