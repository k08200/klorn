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
    <div className="rounded-lg border border-stone-800/60 bg-black/15 px-3 py-2">
      <p className="text-[10px] font-medium uppercase tracking-wider text-stone-600">{label}</p>
      <p className="mt-1 truncate text-xs text-stone-300">{value || "-"}</p>
    </div>
  );
}

/** Stat tile shown above the email body (e.g. word count, attachment size). */
export function DetailStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-stone-700/45 bg-black/20 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-600">
        {label}
      </p>
      <p className="mt-1 truncate text-sm font-semibold text-stone-100">{value}</p>
    </div>
  );
}

/** Compact action button used in the email toolbar (Archive / Delete / Read / Star / Next). */
export function EmailActionButton({
  busy,
  children,
  danger = false,
  disabled,
  onClick,
}: {
  busy: boolean;
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
      className={`h-8 rounded-md border px-2.5 text-xs font-medium transition disabled:opacity-50 ${
        danger
          ? "border-red-500/25 bg-red-500/10 text-red-200 hover:bg-red-500/15"
          : "border-stone-700/70 bg-stone-950/50 text-stone-300 hover:border-stone-600 hover:bg-white/5"
      }`}
    >
      {busy ? "Working" : children}
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
