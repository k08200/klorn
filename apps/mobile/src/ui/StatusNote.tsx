/**
 * A short status note at the bottom of the screen ("Sent — the receipt is in
 * Activity"). One at a time; anything can raise one through `notify()`, and
 * the host (mounted once, signed in) shows it with the app's one toast,
 * `Snackbar` — the same component Mail's undo window uses — for 4.5 s, or
 * until closed. Errors are announced assertively.
 */
import { useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Snackbar } from "./Snackbar";

export type NoteTone = "ok" | "info" | "error";

interface Note {
  id: number;
  text: string;
  tone: NoteTone;
  action?: { label: string; run: () => void };
}

let current: Note | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function notify(text: string, tone: NoteTone = "ok", action?: Note["action"]): void {
  seq += 1;
  current = { id: seq, text, tone, action };
  emit();
}

export function clearNote(): void {
  current = null;
  emit();
}

const HIDE_AFTER_MS = 4500;

export function StatusNoteHost() {
  const note = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => null,
  );
  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => {
      if (current?.id === note.id) clearNote();
    }, HIDE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [note]);
  const action = note?.action;
  return createPortal(
    <Snackbar
      fixed
      message={note?.text ?? null}
      tone={note?.tone === "error" ? "error" : "neutral"}
      icon={note?.tone === "info" ? "info" : "ok"}
      actionLabel={action?.label}
      onAction={
        action
          ? () => {
              action.run();
              clearNote();
            }
          : undefined
      }
      onClose={clearNote}
    />,
    document.body,
  );
}
