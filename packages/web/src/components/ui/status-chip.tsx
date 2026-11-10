"use client";

import type { ReactNode } from "react";
import { useT } from "../../lib/i18n";

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
  /** Override the default (localized) label text. */
  label?: string;
  /** Optional leading icon rendered before the dot. */
  icon?: ReactNode;
  className?: string;
}

interface StatusMeta {
  /** i18n key of the default label. */
  label: string;
  chip: string;
  dot: string;
}

const STATUS_META: Record<Status, StatusMeta> = {
  connected: {
    label: "statusChip.connected",
    chip: "bg-state-ok-bg text-state-ok-ink border-state-ok-line",
    // filled dot
    dot: "bg-emerald-400",
  },
  failed: {
    label: "statusChip.failed",
    // Theme tokens, not light-only rose/stone literals: those stayed pastel
    // on the dark panel.
    chip: "bg-state-danger-bg text-state-danger-ink border-state-danger-line",
    // hollow ring — distinct shape, not just a different color
    dot: "bg-transparent border-2 border-state-danger-ink",
  },
  pending: {
    label: "statusChip.pending",
    chip: "bg-surface-raised text-ink-mid border-line-strong",
    // pulsing dot signals in-progress without color reliance
    dot: "bg-ink-dim animate-pulse",
  },
};

export default function StatusChip({ status, label, icon, className = "" }: StatusChipProps) {
  const { t } = useT();
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
      {label ?? t(meta.label)}
    </span>
  );
}
