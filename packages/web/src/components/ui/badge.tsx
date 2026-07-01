import type { ReactNode } from "react";

/**
 * Intent-named variants. The old rebrand-era names (`blue`/`purple`/`green`/
 * `yellow`/`red`) told a color lie after the 2026-06-16 accent unification —
 * `blue` rendered amber and `purple` rendered stone. Variants are now named by
 * intent so the color follows the token, not a legacy hue word. Old names are
 * kept as aliases (mapped to the closest intent) so no call site breaks.
 */
type BadgeIntent = "accent" | "success" | "warning" | "danger" | "neutral";
type LegacyVariant = "default" | "blue" | "green" | "yellow" | "red" | "purple";
type BadgeVariant = BadgeIntent | LegacyVariant;

interface BadgeProps {
  variant?: BadgeVariant;
  children: ReactNode;
  dot?: boolean;
  className?: string;
}

const intentStyles: Record<BadgeIntent, string> = {
  // accent color flows from the --color-accent token so retuning it here
  // repaints every accent badge; the rest stay on intent-stable hues.
  accent: "bg-accent/10 text-accent border-accent/20",
  success: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  warning: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  danger: "bg-rose-500/10 text-rose-400 border-rose-500/20",
  neutral: "bg-stone-900 text-stone-300 border-stone-700",
};

const intentDot: Record<BadgeIntent, string> = {
  accent: "bg-accent",
  success: "bg-emerald-400",
  warning: "bg-amber-400",
  danger: "bg-rose-400",
  neutral: "bg-stone-400",
};

// Legacy → intent map (non-breaking). `blue` always rendered amber → accent;
// `purple` always rendered stone → neutral.
const legacyToIntent: Record<LegacyVariant, BadgeIntent> = {
  default: "neutral",
  blue: "accent",
  green: "success",
  yellow: "warning",
  red: "danger",
  purple: "neutral",
};

function resolveIntent(variant: BadgeVariant): BadgeIntent {
  if (variant in intentStyles) return variant as BadgeIntent;
  return legacyToIntent[variant as LegacyVariant] ?? "neutral";
}

export default function Badge({
  variant = "neutral",
  children,
  dot = false,
  className = "",
}: BadgeProps) {
  const intent = resolveIntent(variant);
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded-md border ${intentStyles[intent]} ${className}`}
    >
      {dot && <span className={`w-1.5 h-1.5 rounded-full ${intentDot[intent]}`} />}
      {children}
    </span>
  );
}
