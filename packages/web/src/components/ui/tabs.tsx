"use client";

interface Tab {
  id: string;
  label: string;
  count?: number;
}

interface TabsProps {
  tabs: Tab[];
  active: string;
  onChange: (id: string) => void;
}

export default function Tabs({ tabs, active, onChange }: TabsProps) {
  return (
    <div
      role="tablist"
      className="flex gap-1 p-1 bg-stone-950/60 border border-stone-800/60 rounded-lg w-fit"
    >
      {tabs.map((tab) => {
        const isActive = active === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            // Roving tabindex: only the active tab is in the tab order.
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
              isActive
                ? "bg-stone-900 text-white shadow-sm"
                : "text-stone-400 hover:text-stone-200 hover:bg-stone-900/50"
            }`}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span className={`ml-1.5 ${isActive ? "text-stone-400" : "text-stone-400"}`}>
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
