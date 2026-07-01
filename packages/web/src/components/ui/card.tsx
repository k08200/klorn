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
      className={`bg-stone-950/35 border border-stone-700/45 rounded-xl ${paddings[padding]} ${variantStyles[variant]} ${
        hover ? "hover:border-stone-700 hover:bg-stone-950 transition-colors cursor-pointer" : ""
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
  return <h3 className={`font-semibold text-stone-100 ${className}`}>{children}</h3>;
}

export function CardDescription({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <p className={`text-sm text-stone-400 ${className}`}>{children}</p>;
}
