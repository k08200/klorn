import type { ReactNode } from "react";

/**
 * Connected / Failed / Pending status chip. Deliberately NOT color-only
 * (WCAG 1.4.1): every status carries a distinct dot SHAPE + a text label, so
 * it reads without relying on hue. Colors flow from tokens where available.
 *
 *   connected — filled emerald dot
 *   failed    — rose ring (hollow) so it differs from `connected` by shape too
 *   pending   — stone dot with a soft pulse
 */
type Status = "connected" | "failed" | "pending";

interface StatusChipProps {
  status: Status;
  /** Override the default label text (still English UI copy). */
  label?: string;
  /** Optional leading icon rendered before the dot. */
  icon?: ReactNode;
  className?: string;
}

interface StatusMeta {
  label: string;
  chip: string;
  dot: string;
}

const STATUS_META: Record<Status, StatusMeta> = {
  connected: {
    label: "Connected",
    chip: "bg-emerald-500/10 text-emerald-300 border-emerald-500/25",
    // filled dot
    dot: "bg-emerald-400",
  },
  failed: {
    label: "Failed",
    chip: "bg-rose-500/10 text-rose-300 border-rose-500/25",
    // hollow ring — distinct shape, not just a different color
    dot: "bg-transparent border-2 border-rose-400",
  },
  pending: {
    label: "Pending",
    chip: "bg-stone-800/60 text-stone-300 border-stone-600/40",
    // pulsing dot signals in-progress without color reliance
    dot: "bg-stone-400 animate-pulse",
  },
};

export default function StatusChip({ status, label, icon, className = "" }: StatusChipProps) {
  const meta = STATUS_META[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded-md border ${meta.chip} ${className}`}
    >
      {icon && (
        <span className="shrink-0" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className={`w-2 h-2 rounded-full shrink-0 ${meta.dot}`} aria-hidden="true" />
      {label ?? meta.label}
    </span>
  );
}
