import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  description?: string;
  /** Small mono uppercase label above the title (e.g. section name). */
  eyebrow?: string;
  actions?: ReactNode;
}

export default function PageHeader({ title, description, eyebrow, actions }: PageHeaderProps) {
  return (
    <div className="mb-8 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
      <div>
        {eyebrow && (
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-amber-300/80">
            {eyebrow}
          </p>
        )}
        <h1 className="text-2xl font-semibold tracking-tight text-stone-50">{title}</h1>
        {description && (
          <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-500">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
