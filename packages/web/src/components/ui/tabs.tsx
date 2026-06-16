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
    <div className="glass flex w-fit gap-1 rounded-xl border border-stone-800/60 bg-stone-950/50 p-1">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
            active === tab.id
              ? "bg-stone-800/80 text-stone-50 shadow-sm"
              : "text-stone-400 hover:bg-stone-900/50 hover:text-stone-200"
          }`}
        >
          {tab.label}
          {tab.count !== undefined && (
            <span className={`ml-1.5 ${active === tab.id ? "text-stone-400" : "text-stone-600"}`}>
              {tab.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
