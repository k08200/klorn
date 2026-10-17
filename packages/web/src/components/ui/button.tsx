"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "chip" | "danger" | "ghost" | "link";
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
 * Icon-only: a square target (36px with a fine pointer, 44px on touch) whose only content is the glyph, so it has
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

/*
 * Three button roles (design detail pass W3, Row.dc canvas):
 *   primary    36px, 13/600, accent-solid fill — one per view.
 *   secondary  36px, 13/500, 1px line on the panel.
 *   chip       28px visual with a 32px hit area, 12/500, neutral fill — label
 *              menus, "Move to lane", inline tools.
 * danger / ghost / link keep their colours on the same 36px frame. Every
 * role grows to a 44px target on a coarse pointer (WCAG 2.5.8 on touch).
 */
const variantStyles: Record<Variant, string> = {
  primary:
    // Flat fill: no coloured shadow and no hover lift (productization plan
    // §2). Hierarchy comes from the solid accent alone.
    "font-semibold bg-accent-solid hover:bg-accent-solid-hover text-accent-solid-ink disabled:bg-surface-inset disabled:text-ink-dim",
  secondary:
    "bg-surface-panel hover:bg-surface-hover text-ink border border-line-strong disabled:text-ink-dim",
  chip: "bg-surface-hover hover:bg-surface-inset text-ink-strong disabled:text-ink-dim aria-pressed:bg-state-info-bg aria-pressed:text-accent-deeper",
  danger:
    "bg-danger-solid/10 hover:bg-danger-solid text-state-danger-ink hover:text-danger-solid-ink border border-state-danger-line hover:border-danger-solid",
  ghost: "bg-transparent hover:bg-surface-hover text-ink-mid hover:text-ink",
  // Inline text action ("Create an account"): link-coloured, underline on
  // hover; the 36px / 44px frame still gives it a full hit area.
  link: "bg-transparent text-accent-deep underline-offset-2 hover:underline",
};

const sizeStyles: Record<Size, string> = {
  // All text sizes use the `label` type role (13/18); size changes padding.
  sm: "min-h-9 px-3 gap-1.5 pointer-coarse:min-h-11",
  md: "min-h-9 px-3.5 gap-2 pointer-coarse:min-h-11",
  // The one large CTA on auth and onboarding screens.
  lg: "min-h-11 px-5 gap-2",
  icon: "size-9 shrink-0 p-0 pointer-coarse:size-11",
};

// The chip draws 28px and pads its hit area to 32px (44px on touch) with an
// invisible ::after, so a row of chips stays compact without small targets.
const CHIP_FRAME =
  "relative min-h-7 px-2.5 gap-1.5 text-caption font-medium rounded-control after:absolute after:inset-x-0 after:-inset-y-0.5 after:content-[''] pointer-coarse:after:-inset-y-2";
const CHIP_ICON_FRAME =
  "relative size-7 shrink-0 p-0 rounded-control after:absolute after:-inset-0.5 after:content-[''] pointer-coarse:after:-inset-2";

// A text link keeps the frame height but only a hairline of side padding, so
// it sits inline with the sentence it finishes.
const LINK_SIZE = "min-h-9 px-1 gap-1.5 pointer-coarse:min-h-11";

function frameClass(variant: Variant, size: Size): string {
  if (variant === "chip") return size === "icon" ? CHIP_ICON_FRAME : CHIP_FRAME;
  if (variant === "link") return `${LINK_SIZE} rounded-lg text-label`;
  return `${sizeStyles[size]} rounded-lg text-label`;
}

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
      className={`focus-ring inline-flex items-center justify-center transition-colors duration-120 ease-fluid cursor-pointer disabled:cursor-not-allowed ${frameClass(variant, size)} ${variantStyles[variant]} ${className}`}
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
