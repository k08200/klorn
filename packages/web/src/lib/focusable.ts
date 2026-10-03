/**
 * Keyboard-focusable descendants of `root`, in DOM order, skipping disabled
 * and hidden (display:none) elements. Shared by the modal primitives
 * (confirm dialog, Sheet) for their Tab focus trap.
 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function getFocusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute("disabled") && element.offsetParent !== null,
  );
}

/**
 * Keep Tab / Shift+Tab inside `root`. Call from a keydown handler; returns
 * true when it handled (and prevented) the event.
 */
export function trapTab(event: KeyboardEvent, root: HTMLElement | null): boolean {
  if (event.key !== "Tab") return false;
  const focusable = getFocusableElements(root);
  if (focusable.length === 0) {
    event.preventDefault();
    return true;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  const outside = !root?.contains(active);
  if (event.shiftKey && (active === first || outside)) {
    event.preventDefault();
    last.focus();
    return true;
  }
  if (!event.shiftKey && (active === last || outside)) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}
