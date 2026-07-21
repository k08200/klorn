/**
 * Trust Score visualization primitives.
 *
 * ContactTrustScore is computed server-side from commitment outcomes
 * (see packages/api/src/trust-score.ts). The DB has carried this signal
 * for weeks, but until now nothing rendered it on the inbox surface.
 *
 * Two surfaces:
 *   <TrustDot />   — colored dot for dense lists (inbox row)
 *   <TrustBadgeChip /> — dot + label for detail headers / contact cards
 *
 * Both render nothing when badge === "unknown" so the inbox doesn't
 * accumulate grey dots next to every first-time sender.
 *
 * Wire shapes come from @klorn/contract (the server's TrustWire); the local
 * TrustScoreData name is kept as an alias so existing importers are unchanged.
 */

import type { TrustBadge, TrustWire } from "@klorn/contract";

export type { TrustBadge } from "@klorn/contract";
export type TrustScoreData = TrustWire;

interface BadgeStyle {
  label: string;
  chip: string;
  dot: string;
}

export const BADGE_META: Record<TrustBadge, BadgeStyle> = {
  reliable: {
    label: "Reliable",
    chip: "text-emerald-400 bg-emerald-400/10 border-emerald-400/20",
    dot: "bg-emerald-400",
  },
  mostly_reliable: {
    label: "Mostly reliable",
    chip: "text-amber-400 bg-amber-400/10 border-amber-400/20",
    dot: "bg-amber-400",
  },
  unreliable: {
    label: "Unreliable",
    chip: "text-red-400 bg-red-400/10 border-red-400/20",
    dot: "bg-red-400",
  },
  unknown: {
    label: "Unknown",
    chip: "text-slate-400 bg-slate-100 border-slate-200",
    dot: "bg-slate-400",
  },
};

interface TrustDotProps {
  trust: TrustScoreData | null | undefined;
}

/**
 * Tiny colored dot. Use for dense lists where a chip would be too loud.
 * Renders null when badge is unknown — we treat "no signal" as no UI.
 */
export function TrustDot({ trust }: TrustDotProps) {
  if (!trust || trust.badge === "unknown") return null;
  const meta = BADGE_META[trust.badge];
  return (
    <span
      role="img"
      title={`${meta.label} — ${trust.label}`}
      aria-label={`Trust: ${meta.label}. ${trust.label}`}
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${meta.dot}`}
    />
  );
}

interface TrustBadgeChipProps {
  trust: TrustScoreData | null | undefined;
  /** When true, still renders an "Unknown" chip. Defaults to false. */
  showUnknown?: boolean;
}

/**
 * Dot + label chip. Use in detail headers, contact cards, anywhere
 * you have space to spell out what the badge means.
 */
export function TrustBadgeChip({ trust, showUnknown = false }: TrustBadgeChipProps) {
  if (!trust) return null;
  if (trust.badge === "unknown" && !showUnknown) return null;
  const meta = BADGE_META[trust.badge];
  return (
    <span
      title={trust.label}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${meta.chip}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
  );
}
