"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost";
type TextSize = "sm" | "md" | "lg";
type Size = TextSize | "icon";

interface BaseProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  variant?: Variant;
  loading?: boolean;
}

interface TextButtonProps extends BaseProps {
  size?: TextSize;
  icon?: ReactNode;
  children: ReactNode;
}

/**
 * Icon-only: a square 44px target whose only content is the glyph, so it has
 * no visible text to name it. `aria-label` is therefore required by the type
 * (WCAG 4.1.2), and the glyph is passed as children.
 */
interface IconButtonProps extends BaseProps {
  size: "icon";
  "aria-label": string;
  icon?: never;
  children: ReactNode;
}

type ButtonProps = TextButtonProps | IconButtonProps;

const variantStyles: Record<Variant, string> = {
  primary:
    // Flat fill: no coloured shadow and no hover lift (productization plan
    // §2). Hierarchy comes from the solid accent alone.
    "bg-accent-solid hover:bg-accent-solid-hover text-accent-solid-ink disabled:bg-surface-inset disabled:text-ink-dim",
  secondary:
    "bg-surface-panel hover:bg-surface-hover text-ink border border-line hover:border-line-strong",
  danger:
    "bg-danger-solid/10 hover:bg-danger-solid text-state-danger-ink hover:text-danger-solid-ink border border-state-danger-line hover:border-danger-solid",
  ghost: "bg-transparent hover:bg-surface-hover text-ink-mid hover:text-ink",
};

const sizeStyles: Record<Size, string> = {
  // `sm` keeps its compact visual padding but gets a ≥44px hit area
  // (min-h-11) so touch targets stay WCAG 2.5.8 compliant (was h-~28px).
  // All sizes use the `label` type role (13/18/500); size changes padding only.
  sm: "px-3 py-1.5 min-h-11 gap-1.5",
  md: "px-4 py-2.5 min-h-11 gap-2",
  lg: "px-5 py-3 min-h-11 gap-2",
  // Square 44×44 (WCAG 2.5.8 target), glyph centred, no padding.
  icon: "h-11 w-11 shrink-0 p-0",
};

export default function Button({
  variant = "primary",
  size = "md",
  loading = false,
  children,
  className = "",
  disabled,
  ...rest
}: ButtonProps) {
  const { icon, ...props } = rest as BaseProps & { icon?: ReactNode };
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={`focus-ring inline-flex items-center justify-center text-label rounded-control transition-colors duration-120 ease-fluid cursor-pointer disabled:cursor-not-allowed ${variantStyles[variant]} ${sizeStyles[size]} ${className}`}
      {...props}
    >
      {loading ? (
        <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
      ) : icon ? (
        <span className="shrink-0">{icon}</span>
      ) : null}
      {/* An icon button swaps its glyph for the spinner rather than showing both. */}
      {loading && size === "icon" ? null : children}
    </button>
  );
}
