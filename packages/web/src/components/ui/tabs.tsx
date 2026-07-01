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
    <div className="flex gap-1 p-1 bg-stone-950/60 border border-stone-800/60 rounded-lg w-fit">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
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
