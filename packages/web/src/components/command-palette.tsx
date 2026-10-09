"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { useAuth } from "../lib/auth";
import { assistantHref, TODAY_HOME } from "../lib/home";
import { hotkeyCaps, hotkeyRegistry, liveHotkeys } from "../lib/hotkeys";
import { useT } from "../lib/i18n";
import { useHotkeys, useKeyboardTriage } from "../lib/use-hotkeys";
import { useToast } from "./toast";

interface Command {
  id: string;
  label: string;
  sublabel?: string;
  action: () => void;
}

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const listboxId = useId();
  const router = useRouter();
  const triage = useKeyboardTriage();
  const unifiedHome = useAuth().user?.unifiedHome === true;
  const { t } = useT();
  const { toast } = useToast();

  // Cmd/Ctrl+K is an entry in the HOTKEYS table like every other key; the
  // palette owns its handler, the shared listener dispatches it.
  useHotkeys(
    "global",
    {
      "palette.toggle": {
        run: () => {
          setOpen((prev) => !prev);
          setQuery("");
          setSelected(0);
        },
      },
    },
    true,
  );

  // KEYBOARD_TRIAGE: the actions of the current screen, straight from the
  // hotkey table, so the palette and the keys can never disagree. Read while
  // open because handlers mount and unmount with pages. Each runs after the
  // palette has closed and handed focus back.
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const actionCommands: Command[] =
    triage && open
      ? liveHotkeys({ triage, scopes: hotkeyRegistry.activeScopes(), unifiedHome })
          .filter(({ def }) => def.palette)
          .map(({ def, handler }) => ({
            id: `action-${def.id}`,
            label: t(def.labelKey),
            sublabel: hotkeyCaps(def.keys[0], isMac).join(" "),
            action: () => {
              window.setTimeout(() => {
                const reason = handler.disabledReason?.() ?? null;
                if (reason) toast(reason, "info");
                else handler.run();
              }, 0);
            },
          }))
      : [];

  // UNIFIED_HOME: Today is the first destination and the approval surface is
  // named Approvals; otherwise the list is what it was.
  const homeCommands: Command[] = unifiedHome
    ? [
        { id: "today", label: t("nav.v2.openToday"), action: () => router.push(TODAY_HOME) },
        {
          id: "approval-queue",
          label: t("nav.v2.openApprovals"),
          action: () => router.push(assistantHref()),
        },
      ]
    : [
        {
          id: "approval-queue",
          label: "Open decision queue",
          sublabel: "Review decisions waiting for approval",
          action: () => router.push("/inbox"),
        },
      ];

  const commands: Command[] = [
    ...homeCommands,
    {
      id: "mail",
      label: "Open mail",
      sublabel: "Triage today's inbox",
      action: () => router.push("/email"),
    },
    {
      id: "calendar",
      label: "Open calendar",
      sublabel: "See meetings and prep context",
      action: () => router.push("/calendar"),
    },
    {
      id: "briefing",
      label: "Open briefing",
      sublabel: "Review today's work signals",
      action: () => router.push("/briefing"),
    },
    {
      id: "settings",
      label: "Open settings",
      sublabel: "Connections, guardrails, and memory",
      action: () => router.push("/settings"),
    },
    {
      id: "shortcuts",
      label: "Keyboard shortcuts",
      sublabel: "Show shortcut list (Cmd+/)",
      action: () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "/", metaKey: true }));
      },
    },
    // After the destinations, so Enter on an empty query never runs an action.
    ...actionCommands,
  ];

  const filtered = commands.filter((c) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return c.label.toLowerCase().includes(q) || (c.sublabel || "").toLowerCase().includes(q);
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (open) {
      previousFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 50);
      return () => {
        window.clearTimeout(focusTimer);
        previousFocusRef.current?.focus();
      };
    }
  }, [open]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((prev) => Math.min(prev + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && filtered[selected]) {
      e.preventDefault();
      filtered[selected].action();
      setOpen(false);
    } else if (e.key === "Tab") {
      const focusable = getFocusableElements(dialogRef.current);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[20vh]">
      <button
        type="button"
        className="absolute inset-0 bg-black/60"
        aria-label="Close command palette"
        onClick={() => setOpen(false)}
      />
      <div
        ref={dialogRef}
        className="relative w-full max-w-md rounded-xl border border-line bg-surface-panel shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={handleKeyDown}
      >
        <div className="p-3 border-b border-line">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search decisions, pages, settings..."
            aria-label="Search commands"
            className="w-full bg-transparent text-sm focus:outline-none placeholder-ink-dim"
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-activedescendant={
              filtered[selected] ? `command-${filtered[selected].id}` : undefined
            }
            aria-autocomplete="list"
          />
        </div>
        {/* Announce the filtered result count to AT so typing isn't silent —
            the visible "No matching commands" text lives inside the listbox
            and is not a live region. */}
        <div aria-live="polite" className="sr-only">
          {filtered.length === 0
            ? "No matching commands"
            : `${filtered.length} ${filtered.length === 1 ? "command" : "commands"} available`}
        </div>
        <div id={listboxId} className="max-h-64 overflow-y-auto py-1" role="listbox">
          {filtered.length === 0 ? (
            <p className="text-sm text-ink-dim px-4 py-3">No matching commands.</p>
          ) : (
            filtered.map((cmd, i) => (
              <button
                type="button"
                key={cmd.id}
                id={`command-${cmd.id}`}
                role="option"
                aria-selected={i === selected}
                onClick={() => {
                  cmd.action();
                  setOpen(false);
                }}
                onMouseEnter={() => setSelected(i)}
                className={`w-full text-left px-4 py-2.5 flex items-center justify-between text-sm transition ${
                  i === selected
                    ? "bg-surface-hover text-ink"
                    : "text-ink-mid hover:bg-surface-hover"
                }`}
              >
                <span>{cmd.label}</span>
                {cmd.sublabel && <span className="text-xs text-ink-mid">{cmd.sublabel}</span>}
              </button>
            ))
          )}
        </div>
        <div className="border-t border-line px-4 py-2 flex items-center justify-between text-[10px] text-ink-mid">
          <span>Use arrows to move, Enter to open</span>
          <span>Esc to close</span>
        </div>
      </div>
    </div>
  );
}

function getFocusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      [
        "button:not([disabled])",
        "input:not([disabled])",
        "a[href]",
        '[tabindex]:not([tabindex="-1"])',
      ].join(","),
    ),
  ).filter((element) => !element.hasAttribute("disabled") && element.offsetParent !== null);
}
