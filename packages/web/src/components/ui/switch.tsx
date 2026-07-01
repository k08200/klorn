"use client";

import { useId } from "react";

interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name. Rendered as a visible label when `label` is a string. */
  label: string;
  /** Hide the visible label but keep the accessible name (aria-label). */
  hideLabel?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * Accessible toggle. Settings hand-rolls 3 identical toggles today; this is
 * the shared primitive. `role="switch"` + `aria-checked`, keyboard-operable
 * (native <button>, so Space/Enter work), ≥44px hit area (WCAG 2.5.8), thumb
 * and track accent from the --color-accent token.
 */
export default function Switch({
  checked,
  onChange,
  label,
  hideLabel = false,
  disabled = false,
  className = "",
}: SwitchProps) {
  const id = useId();
  const labelId = `${id}-label`;

  const toggle = () => {
    if (disabled) return;
    onChange(!checked);
  };

  return (
    <div className={`inline-flex items-center gap-3 ${className}`}>
      {!hideLabel && (
        <span id={labelId} className="text-sm font-medium text-stone-200">
          {label}
        </span>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={hideLabel ? label : undefined}
        aria-labelledby={hideLabel ? undefined : labelId}
        disabled={disabled}
        onClick={toggle}
        className={`relative inline-flex min-h-11 min-w-14 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 focus-visible:ring-offset-1 focus-visible:ring-offset-stone-950 disabled:cursor-not-allowed disabled:opacity-50 ${
          checked ? "bg-accent" : "bg-stone-700"
        }`}
      >
        <span
          aria-hidden="true"
          className={`absolute left-1 h-6 w-6 rounded-full bg-white transition-transform ${
            checked ? "translate-x-6" : ""
          }`}
        />
      </button>
    </div>
  );
}
