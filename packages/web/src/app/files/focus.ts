/**
 * Where focus goes on /files after a Klorn drive change (WCAG 2.4.3): to a
 * row's own control, found by the row's `data-file-id`, or to a visible
 * heading. A heading focused from code gets its own ring: focus moved by a
 * script after a click does not always match :focus-visible.
 */

export const FOCUSED_HEADING =
  "rounded-control focus:outline-2 focus:outline-offset-2 focus:outline-accent-solid";

/** The attribute each list item carries (files-view.tsx), so a row can be found after a change. */
const ROW_ID_ATTRIBUTE = "data-file-id";

/** A row's "More actions" button, else the row itself; null when the row is not on screen. */
export function rowFocusTarget(
  container: HTMLElement | null,
  id: string | null,
): HTMLElement | null {
  if (container === null || id === null) return null;
  const row = container.querySelector<HTMLElement>(`[${ROW_ID_ATTRIBUTE}="${CSS.escape(id)}"]`);
  if (row === null) return null;
  return (
    row.querySelector<HTMLElement>('[aria-haspopup="menu"]') ??
    row.querySelector<HTMLElement>("a[href], button")
  );
}

/** The first of `ids` whose row is still on screen, as rowFocusTarget finds it. */
export function firstRowTarget(
  container: HTMLElement | null,
  ids: readonly string[],
): HTMLElement | null {
  for (const id of ids) {
    const target = rowFocusTarget(container, id);
    if (target !== null) return target;
  }
  return null;
}

/**
 * Resolves once a fresh list read has reached the screen. TanStack Query tells
 * its observers on a setTimeout(0) after the fetch settles, and React renders
 * that update right after; two timer turns are past both. Timers, not
 * requestAnimationFrame, which never fires in a background tab.
 */
export function afterRender(): Promise<void> {
  return new Promise((resolve) => setTimeout(() => setTimeout(resolve, 0), 0));
}

const FOCUSABLE = "a[href], button:not([disabled])";

/** Focuses the first control in the items from `index` on; false when there is none. */
export function focusItemFrom(
  container: HTMLElement | null,
  itemSelector: string,
  index: number,
): boolean {
  const items = Array.from(container?.querySelectorAll<HTMLElement>(itemSelector) ?? []);
  for (const item of items.slice(index)) {
    const control = item.querySelector<HTMLElement>(FOCUSABLE);
    if (control !== null) {
      control.focus();
      return true;
    }
  }
  return false;
}
