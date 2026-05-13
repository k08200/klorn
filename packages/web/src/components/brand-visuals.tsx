interface EveSignalFieldProps {
  className?: string;
  tone?: "hero" | "panel";
}

const SIGNAL_POINTS = [
  { label: "Mail", x: 14, y: 26, accent: "bg-sky-300" },
  { label: "Calendar", x: 40, y: 14, accent: "bg-amber-300" },
  { label: "Tasks", x: 68, y: 30, accent: "bg-emerald-300" },
  { label: "Memory", x: 28, y: 68, accent: "bg-teal-300" },
  { label: "Review", x: 76, y: 72, accent: "bg-stone-100" },
];

export function EveSignalField({ className = "", tone = "panel" }: EveSignalFieldProps) {
  const isHero = tone === "hero";

  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none relative overflow-hidden border ${
        isHero
          ? "border-white/12 bg-[#111318]/72 shadow-xl shadow-black/20"
          : "border-stone-800 bg-[#111318]"
      } ${className}`}
    >
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),transparent)]" />
      <div className="relative flex h-full min-h-32 flex-col justify-between p-4">
        <div className="flex items-center justify-between gap-4 border-b border-white/8 pb-3">
          <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-500">
            Work signals
          </span>
          <span className="rounded-full border border-emerald-400/20 px-2 py-0.5 text-[10px] text-emerald-200">
            Live
          </span>
        </div>
        <div className="mt-3 space-y-2.5">
          {SIGNAL_POINTS.slice(0, 4).map((point, index) => (
            <div key={point.label} className="flex items-center gap-2.5">
              <span className={`h-2 w-2 rounded-full ${point.accent}`} />
              <span className="w-14 text-[10px] font-medium uppercase tracking-[0.1em] text-stone-500">
                {point.label}
              </span>
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-stone-800">
                <span
                  className={`block h-full rounded-full ${point.accent}`}
                  style={{ width: `${44 + index * 12}%` }}
                />
              </span>
            </div>
          ))}
        </div>
        <div className="mt-4 rounded-md border border-white/8 bg-black/20 px-3 py-2">
          <p className="text-[11px] leading-5 text-stone-400">
            Only items that need attention enter the decision queue with context and approval state.
          </p>
        </div>
      </div>
    </div>
  );
}

export function EveBrandRail({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute overflow-hidden border border-amber-300/10 bg-black/18 ${className}`}
    >
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(216,164,93,0.26),transparent_34%,rgba(45,212,191,0.16)_74%,transparent)]" />
      <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-gradient-to-b from-transparent via-amber-300/55 to-transparent" />
      <div className="absolute left-1/2 top-[18%] h-2 w-2 -translate-x-1/2 rounded-full bg-amber-300" />
      <div className="absolute left-1/2 top-[48%] h-2 w-2 -translate-x-1/2 rounded-full bg-teal-300" />
      <div className="absolute left-1/2 top-[76%] h-2 w-2 -translate-x-1/2 rounded-full bg-stone-100" />
    </div>
  );
}
