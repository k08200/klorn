/**
 * Class strings for the controls in Settings › MCP API keys, in both modes.
 *
 * `tall` is the write-tools-on variant: every control is a >= 44px target with
 * the contrast-hardened `.focus-ring` (globals.css explains why the faint
 * `ring-accent/35` is not enough). `tall` false returns the pre-A3 strings
 * exactly: the flag-off markup is pinned against captured HTML in
 * e2e/api-keys-permission.spec.ts. Size and focus are parameters of one
 * template, so changing a base string cannot leave a variant behind.
 */

const LEGACY_FOCUS = "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35";
const STRONG_FOCUS = "focus-ring";
const LEGACY_MIN_HEIGHT = "min-h-9";
const TARGET_MIN_HEIGHT = "min-h-11"; // 44px

const focusOf = (tall: boolean) => (tall ? STRONG_FOCUS : LEGACY_FOCUS);
const minHeightOf = (tall: boolean) => (tall ? TARGET_MIN_HEIGHT : LEGACY_MIN_HEIGHT);

const FIELD_BASE =
  "w-full rounded-xl border border-line bg-surface-raised px-3 py-2 text-sm text-ink placeholder:text-ink-dim";

/** The key-name input. The legacy field has no min height of its own. */
export function fieldClasses(tall: boolean): string {
  return tall
    ? `${FIELD_BASE} ${TARGET_MIN_HEIGHT} ${STRONG_FOCUS}`
    : `${FIELD_BASE} ${LEGACY_FOCUS}`;
}

export function buttonClasses(tall: boolean): string {
  return `ease-strong inline-flex ${minHeightOf(tall)} items-center rounded-lg border border-line bg-surface-panel/70 px-3 text-xs font-medium text-ink transition duration-150 hover:bg-surface-panel disabled:opacity-50 ${focusOf(tall)}`;
}

export function primaryButtonClasses(tall: boolean): string {
  return `ease-strong inline-flex ${minHeightOf(tall)} items-center rounded-lg bg-accent-solid px-3 text-xs font-semibold text-accent-solid-ink transition duration-150 hover:bg-accent-solid-hover disabled:opacity-50 ${focusOf(tall)}`;
}

const REVOKE_BASE = "text-xs text-ink-dim hover:text-state-danger-ink";

/** Revoke is a text button. Tall, it is 44px in both dimensions even for a two-character label. */
export function revokeClasses(tall: boolean): string {
  return tall
    ? `inline-flex ${TARGET_MIN_HEIGHT} min-w-11 items-center justify-center px-2 ${REVOKE_BASE} ${STRONG_FOCUS}`
    : REVOKE_BASE;
}
