"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";

const SHORTCUTS = [
  { keys: ["Cmd", "K"], label: "Command palette" },
  { keys: ["Cmd", "N"], label: "New decision thread" },
  { keys: ["Cmd", "B"], label: "Open briefing" },
  { keys: ["Cmd", "/"], label: "Show shortcuts" },
  { keys: ["Esc"], label: "Close window" },
];

export default function KeyboardShortcuts() {
  const router = useRouter();
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && showHelp) {
        setShowHelp(false);
        return;
      }

      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;

      switch (e.key) {
        case "n":
          e.preventDefault();
          apiFetch<{ id: string }>("/api/chat/conversations", {
            method: "POST",
          })
            .then((conv) => router.push(`/chat/${conv.id}`))
            .catch(() => router.push("/chat"));
          break;
        case "b":
          e.preventDefault();
          router.push("/briefing");
          break;
        case "/":
          e.preventDefault();
          setShowHelp((prev) => !prev);
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [router, showHelp]);

  if (!showHelp) return null;

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4"
      onClick={() => setShowHelp(false)}
    >
      <div
        className="bg-stone-950 border border-stone-700 rounded-xl p-6 w-full max-w-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-semibold mb-4">Keyboard shortcuts</h3>
        <div className="space-y-3">
          {SHORTCUTS.map((s) => (
            <div key={s.label} className="flex items-center justify-between">
              <span className="text-sm text-stone-400">{s.label}</span>
              <div className="flex gap-1">
                {s.keys.map((k) => (
                  <kbd
                    key={k}
                    className="bg-stone-900 border border-stone-700 rounded px-2 py-0.5 text-xs text-stone-300 font-mono"
                  >
                    {k}
                  </kbd>
                ))}
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-stone-600 mt-4 text-center">
          Press Esc or click outside to close.
        </p>
      </div>
    </div>
  );
}
