import type { ReactNode } from "react";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}

export default function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      {icon && (
        <div className="w-12 h-12 rounded-xl bg-stone-900 border border-stone-700 flex items-center justify-center mb-4 text-stone-500">
          {icon}
        </div>
      )}
      <h3 className="text-base font-medium text-stone-300 mb-1">{title}</h3>
      <p className="text-sm text-stone-500 max-w-xs mb-5">{description}</p>
      {action}
    </div>
  );
}
