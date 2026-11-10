/**
 * Rows this device cleared (Done) or set aside (Later), with the time they may
 * show again — the OPTIMISTIC layer only. The list itself is asked with
 * `hideHandled=1`, so the server leaves out mail whose attention item is
 * DISMISSED or still SNOOZED, on every device. This store covers the moments
 * the server cannot: the 5 s undo window before anything is sent, the refetch
 * after it, a persisted (offline) cache page fetched before the Done, and mail
 * the server had nothing to clear for (`alreadyClear` — not classified yet, or
 * already resolved), which only this device hides. Once the server confirms a
 * Done / Later, the entry is cut to `SETTLED_HIDE_MS`. Persisted (kv) so a
 * relaunch keeps them out; entries expire. Cleared on sign-out (auth/session.tsx).
 * A tiny external store for useSyncExternalStore.
 */
import { useSyncExternalStore } from "react";
import { kv } from "../../platform/kv";

const KEY = "klorn-mail-hidden-v1";
/** How long a Done row stays out of this device's lists when only this device hides it. */
export const DONE_HIDE_MS = 30 * 24 * 60 * 60 * 1000;
/** After the server confirmed: long enough for every cached list page to refetch. */
export const SETTLED_HIDE_MS = 60 * 60 * 1000;

let hidden = new Map<string, number>();
const listeners = new Set<() => void>();
let loaded = false;

function emit() {
  for (const listener of listeners) listener();
}

function persist() {
  const now = Date.now();
  const live = [...hidden.entries()].filter(([, until]) => until > now);
  void kv.setItem(KEY, JSON.stringify(live));
}

export function loadHidden(): Promise<void> {
  if (loaded) return Promise.resolve();
  loaded = true;
  return kv.getItem(KEY).then((raw) => {
    if (!raw) return;
    try {
      const entries = JSON.parse(raw) as Array<[string, number]>;
      const now = Date.now();
      const merged = new Map(hidden);
      for (const [id, until] of entries) {
        if (typeof id === "string" && typeof until === "number" && until > now && !merged.has(id)) {
          merged.set(id, until);
        }
      }
      hidden = merged;
      emit();
    } catch {
      // A corrupt entry only means nothing is hidden.
    }
  });
}

export function hideMail(ids: readonly string[], until: number): void {
  const next = new Map(hidden);
  for (const id of ids) next.set(id, until);
  hidden = next;
  persist();
  emit();
}

/**
 * The server now hides these too: keep them out locally only until `until`
 * (never longer than they already were).
 */
export function settleHidden(ids: readonly string[], until: number): void {
  const next = new Map(hidden);
  let changed = false;
  for (const id of ids) {
    const current = next.get(id);
    if (current !== undefined && current > until) {
      next.set(id, until);
      changed = true;
    }
  }
  if (!changed) return;
  hidden = next;
  persist();
  emit();
}

export function unhideMail(ids: readonly string[]): void {
  const next = new Map(hidden);
  for (const id of ids) next.delete(id);
  hidden = next;
  persist();
  emit();
}

export function clearHidden(): void {
  hidden = new Map();
  void kv.removeItem(KEY);
  emit();
}

export function useHiddenMail(): ReadonlyMap<string, number> {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => hidden,
    () => hidden,
  );
}
