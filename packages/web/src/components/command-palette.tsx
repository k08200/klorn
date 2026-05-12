"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api";

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
  const router = useRouter();

  const commands: Command[] = [
    {
      id: "approval-queue",
      label: "Open decision queue",
      sublabel: "Review decisions waiting for approval",
      action: () => router.push("/inbox"),
    },
    {
      id: "chat",
      label: "Open threads",
      sublabel: "Continue the current work context",
      action: () => router.push("/chat"),
    },
    {
      id: "new-chat",
      label: "New decision thread",
      sublabel: "Start from a fresh work context",
      action: () => {
        apiFetch<{ id: string }>("/api/chat/conversations", {
          method: "POST",
        })
          .then((conv) => router.push(`/chat/${conv.id}`))
          .catch(() => router.push("/chat"));
      },
    },
    {
      id: "briefing",
      label: "Open daily briefing",
      sublabel: "Review today's signal summary",
      action: () => router.push("/briefing"),
    },
    {
      id: "settings",
      label: "Open control plane",
      sublabel: "Manage integrations, trust, and memory",
      action: () => router.push("/settings"),
    },
    {
      id: "billing",
      label: "Open plan and usage",
      sublabel: "Check limits and billing status",
      action: () => router.push("/billing"),
    },
    {
      id: "shortcuts",
      label: "Keyboard shortcuts",
      sublabel: "View shortcut list (Cmd+/)",
      action: () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "/", metaKey: true }));
      },
    },
  ];

  const filtered = commands.filter((c) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return c.label.toLowerCase().includes(q) || (c.sublabel || "").toLowerCase().includes(q);
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
        setQuery("");
        setSelected(0);
      }
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
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
      <div className="relative w-full max-w-md rounded-xl border border-stone-700 bg-stone-900 shadow-2xl">
        <div className="p-3 border-b border-stone-800">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search decisions, screens, or settings..."
            className="w-full bg-transparent text-sm focus:outline-none placeholder-stone-500"
          />
        </div>
        <div className="max-h-64 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <p className="text-sm text-stone-500 px-4 py-3">No matching commands</p>
          ) : (
            filtered.map((cmd, i) => (
              <button
                type="button"
                key={cmd.id}
                onClick={() => {
                  cmd.action();
                  setOpen(false);
                }}
                onMouseEnter={() => setSelected(i)}
                className={`w-full text-left px-4 py-2.5 flex items-center justify-between text-sm transition ${
                  i === selected
                    ? "bg-stone-800 text-white"
                    : "text-stone-400 hover:bg-stone-800/50"
                }`}
              >
                <span>{cmd.label}</span>
                {cmd.sublabel && <span className="text-xs text-stone-600">{cmd.sublabel}</span>}
              </button>
            ))
          )}
        </div>
        <div className="border-t border-stone-800 px-4 py-2 flex items-center justify-between text-[10px] text-stone-600">
          <span>Arrows to move, Enter to open</span>
          <span>Esc to close</span>
        </div>
      </div>
    </div>
  );
}
