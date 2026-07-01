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
  ariaLabel?: string;
}

// Segmented control: these buttons filter/switch state in place rather than
// revealing separate content panels, so they use role="group" + aria-pressed
// (a toggle-button group) instead of a faked tablist without roving tabindex.
export default function Tabs({ tabs, active, onChange, ariaLabel = "View" }: TabsProps) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="flex gap-1 p-1 bg-stone-950/60 border border-stone-800/60 rounded-lg w-fit"
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          aria-pressed={active === tab.id}
          onClick={() => onChange(tab.id)}
          className={`inline-flex min-h-11 items-center px-3 py-1.5 rounded-md text-xs font-medium transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 ${
            active === tab.id
              ? "bg-stone-900 text-white shadow-sm"
              : "text-stone-400 hover:text-stone-200 hover:bg-stone-900/50"
          }`}
        >
          {tab.label}
          {tab.count !== undefined && (
            <span className={`ml-1.5 ${active === tab.id ? "text-stone-400" : "text-stone-400"}`}>
              {tab.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
