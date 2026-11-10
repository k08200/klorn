/**
 * Shared modal bookkeeping for every overlay (Sheet, confirm dialog).
 *
 * Each overlay listens for Escape / Tab on window in the capture phase, and
 * capture listeners fire in registration order — so without coordination the
 * FIRST overlay opened handles the key, not the top one: a confirm opened
 * over a Sheet could not be escaped and Tab yanked focus back into the Sheet.
 * The stack fixes that: an overlay pushes a token on open, removes it on
 * close, and only acts on a key while `isTop(token)`.
 *
 * Body scroll is locked by reference count instead of per-instance
 * save/restore, so two overlays closing in either order always restore the
 * original value, and an overlay can hold its lease through its exit
 * transition.
 *
 * Both factories are pure (no DOM at import) so the api vitest suite can pin
 * them; the module-level singletons below are what components use.
 */

export interface ModalStack {
  push(token: symbol): void;
  remove(token: symbol): void;
  top(): symbol | undefined;
  isTop(token: symbol): boolean;
  size(): number;
}

export function createModalStack(): ModalStack {
  let entries: readonly symbol[] = [];
  return {
    push(token) {
      entries = [...entries.filter((t) => t !== token), token];
    },
    remove(token) {
      entries = entries.filter((t) => t !== token);
    },
    top() {
      return entries[entries.length - 1];
    },
    isTop(token) {
      return entries.length > 0 && entries[entries.length - 1] === token;
    },
    size() {
      return entries.length;
    },
  };
}

export interface ScrollLock {
  /** Take a lease; returns an idempotent release. */
  acquire(): () => void;
  count(): number;
}

/** Ref-counted `overflow: hidden` on `style` (document.body.style in the app). */
export function createScrollLock(getStyle: () => { overflow: string }): ScrollLock {
  let leases = 0;
  let saved = "";
  return {
    acquire() {
      if (leases === 0) {
        const style = getStyle();
        saved = style.overflow;
        style.overflow = "hidden";
      }
      leases += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        leases -= 1;
        if (leases === 0) getStyle().overflow = saved;
      };
    },
    count() {
      return leases;
    },
  };
}

export const modalStack = createModalStack();
export const bodyScrollLock = createScrollLock(() => document.body.style);

/** Escape that is not finishing an IME composition (Korean / Japanese input). */
export function isPlainEscape(event: KeyboardEvent): boolean {
  return event.key === "Escape" && !event.isComposing && event.keyCode !== 229;
}
