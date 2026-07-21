import type { HTMLAttributes, ReactNode } from "react";

/**
 * `default` — flat translucent panel.
 * `glass`   — adds the signature backdrop-blur (`.glass`) glass-panel look.
 * `elevated`— tactile lift (`.lift`): rises + casts a shadow on hover.
 * `glass`/`elevated` map to the existing globals.css utilities so the
 * board's panel language is expressible through the primitive.
 */
type CardVariant = "default" | "glass" | "elevated";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  hover?: boolean;
  padding?: "sm" | "md" | "lg";
  variant?: CardVariant;
}

const paddings = {
  sm: "p-3",
  md: "p-4",
  lg: "p-5",
};

const variantStyles: Record<CardVariant, string> = {
  default: "",
  glass: "glass",
  elevated: "lift",
};

export default function Card({
  children,
  hover = false,
  padding = "md",
  variant = "default",
  className = "",
  ...props
}: CardProps) {
  return (
    <div
      className={`bg-white border border-slate-200 rounded-xl ${paddings[padding]} ${variantStyles[variant]} ${
        hover ? "hover:border-slate-300 hover:bg-slate-50 transition-colors cursor-pointer" : ""
      } ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`flex items-center justify-between mb-3 ${className}`}>{children}</div>;
}

export function CardTitle({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <h3 className={`font-semibold text-slate-900 ${className}`}>{children}</h3>;
}

export function CardDescription({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <p className={`text-sm text-slate-500 ${className}`}>{children}</p>;
}
