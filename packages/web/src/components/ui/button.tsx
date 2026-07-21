"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
  children: ReactNode;
}

const variantStyles: Record<Variant, string> = {
  primary:
    "bg-accent hover:bg-sky-600 text-white disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none shadow-lg shadow-sky-500/25 hover:shadow-xl hover:shadow-sky-500/35 hover:-translate-y-px active:translate-y-0 transition-all",
  secondary:
    "bg-white hover:bg-slate-100 text-slate-900 border border-slate-200 hover:border-slate-300",
  danger:
    "bg-red-600/10 hover:bg-red-600 text-red-600 hover:text-white border border-red-200 hover:border-red-600",
  ghost: "bg-transparent hover:bg-slate-100 text-slate-500 hover:text-slate-900",
};

const sizeStyles: Record<Size, string> = {
  // `sm` keeps its compact visual padding but gets a ≥44px hit area
  // (min-h-11) so touch targets stay WCAG 2.5.8 compliant (was h-~28px).
  sm: "px-3 py-1.5 min-h-11 text-xs gap-1.5",
  md: "px-4 py-2.5 text-sm gap-2",
  lg: "px-5 py-3 text-sm gap-2",
};

export default function Button({
  variant = "primary",
  size = "md",
  loading = false,
  icon,
  children,
  className = "",
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center font-medium rounded-lg transition-all duration-150 cursor-pointer disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 focus-visible:ring-offset-1 focus-visible:ring-offset-white ${variantStyles[variant]} ${sizeStyles[size]} ${className}`}
      {...props}
    >
      {loading ? (
        <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
      ) : icon ? (
        <span className="shrink-0">{icon}</span>
      ) : null}
      {children}
    </button>
  );
}
