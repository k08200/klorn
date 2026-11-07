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
      className="flex gap-1 p-1 bg-surface-hover border border-line rounded-control w-fit"
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          aria-pressed={active === tab.id}
          onClick={() => onChange(tab.id)}
          className={`inline-flex min-h-11 items-center px-3 py-1.5 rounded-md text-xs font-medium transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 ${
            active === tab.id
              ? "bg-surface-panel text-ink"
              : "text-ink-mid hover:text-ink hover:bg-surface-inset"
          }`}
        >
          {tab.label}
          {tab.count !== undefined && (
            <span className={`ml-1.5 ${active === tab.id ? "text-ink-dim" : "text-ink-dim"}`}>
              {tab.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
