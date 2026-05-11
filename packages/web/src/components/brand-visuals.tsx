interface EveSignalFieldProps {
  className?: string;
  tone?: "hero" | "panel";
}

const SIGNAL_POINTS = [
  { label: "MAIL", x: 14, y: 26, accent: "bg-sky-300" },
  { label: "CAL", x: 40, y: 14, accent: "bg-amber-300" },
  { label: "TASK", x: 68, y: 30, accent: "bg-emerald-300" },
  { label: "MEM", x: 28, y: 68, accent: "bg-teal-300" },
  { label: "OK", x: 76, y: 72, accent: "bg-stone-100" },
];

export function EveSignalField({ className = "", tone = "panel" }: EveSignalFieldProps) {
  const isHero = tone === "hero";

  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none relative overflow-hidden border ${
        isHero
          ? "border-white/14 bg-black/22 shadow-2xl shadow-black/30"
          : "border-amber-300/15 bg-stone-950/55"
      } ${className}`}
    >
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.035)_1px,transparent_1px)] bg-[size:28px_28px]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_0%,transparent_46%,rgba(0,0,0,0.58)_100%)]" />
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" fill="none">
        <path
          d="M14 26 C30 10 52 12 68 30 S84 58 76 72"
          stroke="rgba(216,164,93,0.58)"
          strokeWidth="0.8"
        />
        <path
          d="M14 26 C22 52 34 62 28 68 C43 76 60 78 76 72"
          stroke="rgba(45,212,191,0.38)"
          strokeWidth="0.8"
        />
        <path d="M40 14 C45 36 38 50 28 68" stroke="rgba(255,255,255,0.18)" strokeWidth="0.7" />
        <path d="M68 30 C58 44 56 58 76 72" stroke="rgba(255,255,255,0.16)" strokeWidth="0.7" />
      </svg>
      <div className="eve-scan-line absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-amber-200/10 to-transparent" />

      {SIGNAL_POINTS.map((point) => (
        <div
          key={point.label}
          className="absolute -translate-x-1/2 -translate-y-1/2"
          style={{ left: `${point.x}%`, top: `${point.y}%` }}
        >
          <div className="relative">
            <span className={`block h-2.5 w-2.5 rounded-full ${point.accent}`} />
            <span
              className={`absolute inset-0 rounded-full ${point.accent} opacity-30 eve-pulse`}
            />
          </div>
          <span className="mt-2 block -translate-x-1/2 whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.16em] text-stone-400">
            {point.label}
          </span>
        </div>
      ))}

      <div className="absolute bottom-4 left-4 right-4 border-t border-white/10 pt-3">
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-amber-200">
            Signal field
          </span>
          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-stone-800">
            <span className="block h-full w-3/4 bg-gradient-to-r from-amber-300 to-teal-300" />
          </span>
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
