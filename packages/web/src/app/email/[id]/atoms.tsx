/**
 * Small presentational atoms for the email detail page.
 *
 * Extracted from page.tsx (2026-05-19) — page.tsx was 2676 lines and
 * even the smallest dumb components were stuck there. Pulling these
 * out lets the page file focus on data loading + interaction state.
 *
 * Every component here is pure render: props in, JSX out, no hooks,
 * no fetch, no callbacks back to the parent except onClick passthrough.
 */

/** Single fact row in the candidate-profile card. */
export function ProfileFact({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="rounded-lg border border-line bg-surface-raised px-3 py-2">
      <p className="text-[10px] font-medium uppercase tracking-wider text-ink-mid">{label}</p>
      <p className="mt-1 truncate text-xs text-ink-mid">{value || "-"}</p>
    </div>
  );
}

/** Stat tile shown above the email body (e.g. word count, attachment size). */
export function DetailStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface-raised px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-mid">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold text-ink">{value}</p>
    </div>
  );
}

/** Compact action button used in the email toolbar (Archive / Delete / Read / Star / Next). */
export function EmailActionButton({
  busy,
  busyLabel,
  children,
  danger = false,
  disabled,
  onClick,
}: {
  busy: boolean;
  /** Localized "working" text shown while busy — atoms stay hook-free. */
  busyLabel: string;
  children: string;
  danger?: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`focus-ring h-8 rounded-md border px-2.5 text-xs font-medium transition disabled:opacity-50 ${
        danger
          ? "border-state-danger-line bg-state-danger-bg text-state-danger-ink hover:bg-state-danger-bg"
          : "border-line bg-surface-panel text-ink-mid hover:border-line hover:bg-surface-hover"
      }`}
    >
      {busy ? busyLabel : children}
    </button>
  );
}

/**
 * Pull the human-readable name out of an RFC-5322 From header.
 *   "Mina Park <mina@alpha.com>" → "Mina Park"
 *   "mina@alpha.com"             → "mina@alpha.com"
 *
 * Bare-domain rejection is the caller's problem — this just renders.
 */
export function senderName(raw: string): string {
  const match = raw.match(/^([^<]+?)\s*</);
  if (match?.[1]) return match[1].trim();
  return raw.replace(/[<>]/g, "").trim();
}

export function formatBytes(size: number | null): string {
  if (!size || size <= 0) return "Unknown size";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
