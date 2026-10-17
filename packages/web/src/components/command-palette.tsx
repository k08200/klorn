"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { useAuth } from "../lib/auth";
import {
  ASSISTANT_ACTIVITY,
  ASSISTANT_BRIEFING,
  ASSISTANT_CHAT,
  assistantHref,
  TODAY_HOME,
} from "../lib/home";
import { hotkeyCaps, hotkeyRegistry, liveHotkeys } from "../lib/hotkeys";
import { useT } from "../lib/i18n";
import { useHotkeys, useKeyboardTriage } from "../lib/use-hotkeys";
import { useMailSubscriptionsAvailable } from "../lib/use-mail-subscriptions";
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
  const { user } = useAuth();
  const unifiedHome = user?.unifiedHome === true;
  const { t } = useT();
  const { toast } = useToast();
  // Subscriptions joins only once its list has loaded (absent while
  // BULK_UNSUBSCRIBE_ENABLED is off). Asked only while open and signed in, so
  // the palette costs nothing on every other page view.
  const subscriptionsAvailable = useMailSubscriptionsAvailable(open && !!user);

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
          label: t("nav.v2.openApprovals"),
          sublabel: t("commandPalette.approvalsHint"),
          action: () => router.push("/inbox"),
        },
      ];

  // UNIFIED_HOME: Briefing, Activity and Chat are pages of the Assistant hub.
  const briefingCommands: Command[] = unifiedHome
    ? [
        {
          id: "briefing",
          label: t("keys.go.briefing"),
          action: () => router.push(ASSISTANT_BRIEFING),
        },
        {
          id: "activity",
          label: t("assistantHub.palette.activity"),
          action: () => router.push(ASSISTANT_ACTIVITY),
        },
        {
          id: "assistant-chat",
          label: t("assistantHub.palette.chat"),
          action: () => router.push(ASSISTANT_CHAT),
        },
      ]
    : [
        {
          id: "briefing",
          label: t("commandPalette.briefing"),
          sublabel: t("commandPalette.briefingHint"),
          action: () => router.push("/briefing"),
        },
      ];

  const commands: Command[] = [
    ...homeCommands,
    {
      id: "mail",
      label: t("commandPalette.mail"),
      sublabel: t("commandPalette.mailHint"),
      action: () => router.push("/email"),
    },
    ...(subscriptionsAvailable
      ? [
          {
            id: "subscriptions",
            label: t("commandPalette.subscriptions"),
            sublabel: t("commandPalette.subscriptionsHint"),
            action: () => router.push("/email/subscriptions"),
          },
        ]
      : []),
    {
      id: "calendar",
      label: t("commandPalette.calendar"),
      sublabel: t("commandPalette.calendarHint"),
      action: () => router.push("/calendar"),
    },
    ...briefingCommands,
    {
      id: "settings",
      label: t("commandPalette.settings"),
      sublabel: t("commandPalette.settingsHint"),
      action: () => router.push("/settings"),
    },
    {
      id: "usage",
      label: t("commandPalette.usage"),
      sublabel: t("commandPalette.usageHint"),
      action: () => router.push("/usage"),
    },
    {
      id: "billing",
      label: t("commandPalette.billing"),
      sublabel: t("commandPalette.billingHint"),
      action: () => router.push("/billing"),
    },
    {
      id: "shortcuts",
      label: t("commandPalette.shortcuts"),
      sublabel: t("commandPalette.shortcutsHint", { keys: isMac ? "⌘/" : "Ctrl+/" }),
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
        aria-label={t("palette.close")}
        onClick={() => setOpen(false)}
      />
      <div
        ref={dialogRef}
        className="relative w-full max-w-md rounded-xl border border-line bg-surface-panel shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.label")}
        onKeyDown={handleKeyDown}
      >
        <div className="p-3 border-b border-line">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("palette.placeholder")}
            aria-label={t("palette.search")}
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
            ? t("palette.noMatches")
            : filtered.length === 1
              ? t("palette.availableOne")
              : t("palette.availableMany", { count: String(filtered.length) })}
        </div>
        <div id={listboxId} className="max-h-64 overflow-y-auto py-1" role="listbox">
          {filtered.length === 0 ? (
            <p className="text-sm text-ink-dim px-4 py-3">{t("palette.noMatchesSentence")}</p>
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
        <div className="border-t border-line px-4 py-2 flex items-center justify-between text-caption text-ink-mid">
          <span>{t("palette.hintMove")}</span>
          <span>{t("palette.hintClose")}</span>
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
