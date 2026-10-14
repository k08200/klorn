// PRIMARY_BTN: kept only for the two spots ui/Button can't take over — an
// <a> styled as a button (Button only renders a <button> element) and the
// profile-save button, which swaps to a literal emerald "Saved" class that
// Button's variants don't model. Every other primary/secondary/danger
// button on this page now uses ui/Button directly.
export const PRIMARY_BTN =
  "glow-primary ease-strong inline-flex min-h-10 items-center justify-center rounded-lg bg-accent-solid px-4 text-sm font-medium text-accent-solid-ink transition duration-150 hover:bg-accent-solid-hover active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40";
export const SECTION_TITLE = "mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink-dim";
export const PANEL = "panel-elevated rounded-2xl border border-line/70 bg-surface-panel";
