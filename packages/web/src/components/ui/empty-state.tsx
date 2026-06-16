import type { ReactNode } from "react";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}

export default function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="glass flex flex-col items-center justify-center rounded-2xl border border-dashed border-stone-800/70 px-4 py-16 text-center">
      {icon && (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-stone-800 bg-stone-900/60 text-stone-500">
          {icon}
        </div>
      )}
      <h3 className="mb-1 text-base font-medium text-stone-300">{title}</h3>
      <p className="mb-5 max-w-xs text-sm text-stone-500">{description}</p>
      {action}
    </div>
  );
}
