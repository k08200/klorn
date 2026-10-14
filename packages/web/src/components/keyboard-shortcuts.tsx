"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { useAuth } from "../lib/auth";
import { ASSISTANT_BRIEFING, assistantHref, TODAY_HOME } from "../lib/home";
import {
  createHotkeyMatcher,
  hotkeyBlockReason,
  hotkeyRegistry,
  matchLegacyHotkey,
} from "../lib/hotkeys";
import { modalStack } from "../lib/modal-stack";
import { useHotkeys, useKeyboardTriage } from "../lib/use-hotkeys";
import { ShortcutSheet } from "./shortcut-sheet";
import { useToast } from "./toast";

const SHORTCUTS = [
  { keys: ["Cmd", "K"], label: "Command palette" },
  { keys: ["Cmd", "B"], label: "Open briefing" },
  { keys: ["Cmd", "/"], label: "Show shortcuts" },
  { keys: ["Esc"], label: "Close window" },
];

/**
 * The one keydown listener for app-wide shortcuts. Every key it answers comes
 * from the HOTKEYS table (lib/hotkeys); pages mount handlers for the ids they
 * own (lib/use-hotkeys) and this component dispatches to them.
 *
 * With KEYBOARD_TRIAGE off only the three legacy chords exist (Cmd/Ctrl+K, +B,
 * +/) and the help dialog is the one below, unchanged. With it on, the rest of
 * the table is live and `?` / Cmd+/ open the ShortcutSheet instead.
 */
export default function KeyboardShortcuts() {
  const router = useRouter();
  const triage = useKeyboardTriage();
  const unifiedHome = useAuth().user?.unifiedHome === true;
  const { toast } = useToast();
  const [showHelp, setShowHelp] = useState(false);
  // UNIFIED_HOME: Briefing is a page of the Assistant hub (P7).
  const briefingHref = unifiedHome ? ASSISTANT_BRIEFING : "/briefing";

  // Handlers this component owns: briefing, help, and the `g` destinations.
  useHotkeys(
    "global",
    {
      "nav.briefing": { run: () => router.push(briefingHref) },
      "help.toggle": { run: () => setShowHelp((prev) => !prev) },
      "help.open": { run: () => setShowHelp(true) },
      "go.mail": { run: () => router.push("/email") },
      "go.calendar": { run: () => router.push("/calendar") },
      "go.queue": { run: () => router.push("/inbox") },
      // Live only under UNIFIED_HOME (the table gates them on the flag).
      "go.today": { run: () => router.push(TODAY_HOME) },
      "go.assistant": { run: () => router.push(assistantHref()) },
      "go.briefing": { run: () => router.push(briefingHref) },
      "go.settings": { run: () => router.push("/settings") },
    },
    true,
  );

  useEffect(() => {
    const matcher = createHotkeyMatcher();

    const handler = (e: KeyboardEvent) => {
      // Legacy chords first and unguarded, exactly as before the registry.
      const legacy = matchLegacyHotkey(e);
      if (legacy) {
        const owner = hotkeyRegistry.resolve(legacy.id);
        if (!owner) return;
        e.preventDefault();
        owner.run();
        return;
      }
      // Something closer to the key already handled it (a menu closing on
      // Escape, a widget's own shortcut): it is not ours as well.
      if (!triage || e.defaultPrevented) return;

      const target = e.target instanceof HTMLElement ? e.target : null;
      if (hotkeyBlockReason(e, describeTarget(target), isModalOpen())) {
        matcher.reset();
        return;
      }
      const ctx = { triage, scopes: hotkeyRegistry.activeScopes(), unifiedHome };
      const match = matcher.feed(e, describeTarget(target), (def) => def.enabled(ctx), Date.now());
      if (match.kind === "pending") {
        e.preventDefault();
        return;
      }
      if (match.kind !== "match") return;
      const owner = hotkeyRegistry.resolve(match.def.id);
      if (!owner) return;
      e.preventDefault();
      const reason = owner.disabledReason?.() ?? null;
      if (reason) toast(reason, "info");
      else owner.run();
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [triage, unifiedHome, toast]);

  if (triage) {
    return (
      <ShortcutSheet open={showHelp} onClose={() => setShowHelp(false)} unifiedHome={unifiedHome} />
    );
  }
  return showHelp ? <LegacyShortcutsDialog onClose={() => setShowHelp(false)} /> : null;
}

function describeTarget(target: HTMLElement | null) {
  if (!target) return null;
  return {
    tagName: target.tagName,
    type: target instanceof HTMLInputElement ? target.type : undefined,
    isContentEditable: target.isContentEditable,
    role: target.getAttribute("role"),
  };
}

/** Any overlay: the shared modal stack, or a dialog that predates it. */
function isModalOpen(): boolean {
  return modalStack.size() > 0 || document.querySelector('[aria-modal="true"]') !== null;
}

/** The pre-flag help dialog, kept as it was for the flag-off path. */
function LegacyShortcutsDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTimer = window.setTimeout(() => {
      getFocusableElements(dialogRef.current)[0]?.focus();
    }, 0);
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = getFocusableElements(dialogRef.current);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", handler);
      previousFocusRef.current?.focus();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="bg-surface-panel border border-line rounded-xl p-6 w-full max-w-sm"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h3 id={titleId} className="font-semibold mb-4">
          Keyboard shortcuts
        </h3>
        <div className="space-y-3">
          {SHORTCUTS.map((s) => (
            <div key={s.label} className="flex items-center justify-between">
              <span className="text-sm text-ink-mid">{s.label}</span>
              <div className="flex gap-1">
                {s.keys.map((k) => (
                  <kbd
                    key={k}
                    className="bg-surface-raised border border-line rounded px-2 py-0.5 text-xs text-ink-soft font-mono"
                  >
                    {k}
                  </kbd>
                ))}
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-ink-mid mt-4 text-center">
          Press Esc or click outside to close.
        </p>
        <button
          type="button"
          onClick={onClose}
          className="mt-4 w-full min-h-11 rounded-lg border border-line text-sm text-ink-mid transition hover:border-accent/40 hover:text-accent-deep"
        >
          Close
        </button>
      </div>
    </div>
  );
}

function getFocusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      ["button:not([disabled])", "a[href]", '[tabindex]:not([tabindex="-1"])'].join(","),
    ),
  ).filter((element) => !element.hasAttribute("disabled") && element.offsetParent !== null);
}
