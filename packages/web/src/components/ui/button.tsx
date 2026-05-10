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
    "bg-amber-300 hover:bg-amber-200 text-stone-950 disabled:bg-stone-700 disabled:text-stone-500 shadow-sm shadow-amber-300/20",
  secondary:
    "bg-stone-900 hover:bg-stone-700 text-stone-200 border border-stone-700 hover:border-stone-500",
  danger:
    "bg-red-600/10 hover:bg-red-600 text-red-400 hover:text-white border border-red-800/40 hover:border-red-600",
  ghost: "bg-transparent hover:bg-stone-900 text-stone-400 hover:text-stone-200",
};

const sizeStyles: Record<Size, string> = {
  sm: "px-3 py-1.5 text-xs gap-1.5",
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
      className={`inline-flex items-center justify-center font-medium rounded-lg transition-all duration-150 cursor-pointer disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-amber-300/35 focus:ring-offset-1 focus:ring-offset-stone-950 ${variantStyles[variant]} ${sizeStyles[size]} ${className}`}
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
