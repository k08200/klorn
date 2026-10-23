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
