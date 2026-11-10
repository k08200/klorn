/**
 * Keyboard-aware layout (canvas notes.gestures: "the composer and its buttons
 * ride above the keyboard"). One keyboard state, two ways to read it:
 *
 *  - `installKeyboardInsets()` (App, once): writes `--keyboard-inset` (the
 *    visual viewport's lost height) on <html> and toggles `html.keyboard-open`
 *    so the tab bar steps aside and in-flow composers pad themselves.
 *  - `useKeyboardInset()` (fixed-position sheets such as Mail's composer): how
 *    much of the window the keyboard covers, in CSS px.
 *
 * Why they differ:
 *  - iOS: Keyboard `resize: "body"` (capacitor.config.ts) shrinks <body>, so
 *    in-flow content already moves; but fixed-position sheets are laid out
 *    against the viewport, which does not shrink — their inset is the keyboard
 *    height from @capacitor/keyboard's will-show event.
 *  - Android: `adjustResize` shrinks the WebView itself; nothing to add.
 *  - Browser (dev, tests) and any WebView that overlays instead of resizing:
 *    the visual viewport shrinks, and the difference is the inset.
 */
import { useSyncExternalStore } from "react";
import { hasPlugin, isNative, platformName } from "./native";

interface KeyboardState {
  /** window.innerHeight minus what the visual viewport still shows. */
  viewportInset: number;
  /** iOS only: the native keyboard height while it is up (fixed layers need it). */
  nativeHeight: number;
  /** Native will-show / will-hide (both platforms). */
  nativeOpen: boolean;
}

const CLOSED: KeyboardState = { viewportInset: 0, nativeHeight: 0, nativeOpen: false };
let state: KeyboardState = CLOSED;
const listeners = new Set<() => void>();
let detach: (() => void) | null = null;

function update(patch: Partial<KeyboardState>) {
  const next = { ...state, ...patch };
  if (
    next.viewportInset === state.viewportInset &&
    next.nativeHeight === state.nativeHeight &&
    next.nativeOpen === state.nativeOpen
  ) {
    return;
  }
  state = next;
  for (const fn of listeners) fn();
}

export function visualViewportInset(): number {
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  if (!vv) return 0;
  return Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
}

/** Starts the viewport and native listeners, shared by every subscriber. */
function attach(): () => void {
  const cleanups: Array<() => void> = [];
  const vv = window.visualViewport;
  if (vv) {
    const onViewport = () => update({ viewportInset: visualViewportInset() });
    vv.addEventListener("resize", onViewport);
    vv.addEventListener("scroll", onViewport);
    onViewport();
    cleanups.push(() => {
      vv.removeEventListener("resize", onViewport);
      vv.removeEventListener("scroll", onViewport);
    });
  }
  if (isNative() && hasPlugin("Keyboard")) {
    let alive = true;
    const ios = platformName() === "ios";
    void import("@capacitor/keyboard")
      .then(async ({ Keyboard }) => {
        const show = await Keyboard.addListener("keyboardWillShow", (info) =>
          update({ nativeOpen: true, nativeHeight: ios ? info.keyboardHeight : 0 }),
        );
        const hide = await Keyboard.addListener("keyboardWillHide", () =>
          update({ nativeOpen: false, nativeHeight: 0 }),
        );
        if (!alive) {
          void show.remove();
          void hide.remove();
          return;
        }
        cleanups.push(() => {
          void show.remove();
          void hide.remove();
        });
      })
      .catch(() => {});
    cleanups.push(() => {
      alive = false;
    });
  }
  return () => {
    for (const fn of cleanups) fn();
    state = CLOSED;
  };
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  if (!detach && typeof window !== "undefined") detach = attach();
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && detach) {
      detach();
      detach = null;
    }
  };
}

/** Whether the keyboard is up: the native event on device, else a viewport heuristic. */
function keyboardOpen(s: KeyboardState): boolean {
  return isNative() ? s.nativeOpen : s.viewportInset > 80;
}

/**
 * App-wide `--keyboard-inset` and `html.keyboard-open` on <html>. Returns the
 * uninstaller (an effect cleanup).
 */
export function installKeyboardInsets(): () => void {
  const root = document.documentElement;
  const apply = () => {
    root.style.setProperty("--keyboard-inset", `${state.viewportInset}px`);
    root.classList.toggle("keyboard-open", keyboardOpen(state));
  };
  const unsubscribe = subscribe(apply);
  apply();
  return () => {
    unsubscribe();
    root.style.removeProperty("--keyboard-inset");
    root.classList.remove("keyboard-open");
  };
}

/** For fixed-position layers: the px of the window the keyboard covers. */
export function useKeyboardInset(): number {
  return useSyncExternalStore(
    subscribe,
    () => Math.max(state.viewportInset, state.nativeHeight),
    () => 0,
  );
}
