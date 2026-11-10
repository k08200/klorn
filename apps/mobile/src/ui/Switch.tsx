/**
 * The app's one on/off switch: Settings (notification toggles, quiet hours),
 * the lane sheet's "keep this sender here" and the new-event "all day".
 *
 * A native checkbox with role="switch" (aria-checked mirrors `checked`) — the
 * state is announced as on / off, Space toggles it, and a wrapping <label> (or
 * `id` + htmlFor) names it. The input is invisible but covers the whole
 * control, a 51×44 hit area (WCAG 2.5.8 / the 44px floor) around the 51×31
 * track. Keyboard focus rings the track; reduced motion drops the slide.
 */
import type { InputHTMLAttributes } from "react";
import "./switch.css";

export interface SwitchProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "role" | "checked" | "onChange"> {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export function Switch({ checked, onChange, className, ...input }: SwitchProps) {
  return (
    <span className={className ? `switch ${className}` : "switch"}>
      <input
        {...input}
        type="checkbox"
        role="switch"
        aria-checked={checked}
        className="switch__input"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch__track" aria-hidden="true">
        <span className="switch__thumb" />
      </span>
    </span>
  );
}
