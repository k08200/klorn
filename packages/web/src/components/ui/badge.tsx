import type { ReactNode } from "react";

type BadgeVariant = "default" | "blue" | "green" | "yellow" | "red" | "purple";

interface BadgeProps {
  variant?: BadgeVariant;
  children: ReactNode;
  dot?: boolean;
  className?: string;
}

const variantStyles: Record<BadgeVariant, string> = {
  default: "bg-stone-900 text-stone-300 border-stone-700",
  blue: "bg-amber-300/10 text-amber-300 border-amber-300/20",
  green: "bg-green-500/10 text-green-400 border-green-500/20",
  yellow: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  red: "bg-red-500/10 text-red-400 border-red-500/20",
  purple: "bg-purple-500/10 text-purple-400 border-purple-500/20",
};

const dotColors: Record<BadgeVariant, string> = {
  default: "bg-stone-400",
  blue: "bg-amber-300",
  green: "bg-green-400",
  yellow: "bg-yellow-400",
  red: "bg-red-400",
  purple: "bg-purple-400",
};

export default function Badge({
  variant = "default",
  children,
  dot = false,
  className = "",
}: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded-md border ${variantStyles[variant]} ${className}`}
    >
      {dot && <span className={`w-1.5 h-1.5 rounded-full ${dotColors[variant]}`} />}
      {children}
    </span>
  );
}
