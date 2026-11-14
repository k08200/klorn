/**
 * The app-password preset card's `/api/<slug>-imap/status` probe, as pure rules
 * (components/imap-preset-section.tsx; pinned by
 * api/src/__tests__/web-imap-presets.test.ts).
 *
 * A preset is shown only after its /status has answered once. Seven presets
 * probe on every Settings visit: a 404 (IMAP_PRESETS_ENABLED off, or the user
 * outside the cohort) or a probe that never succeeded (5xx, 429, offline) must
 * draw nothing, not seven panels with an error in each.
 */

import type { ImapStatusAccount } from "./account-health";

/** A mailbox as `/api/<slug>-imap/status` lists it. */
export interface PresetAccount extends ImapStatusAccount {
  host: string | null;
  connectedAt: string;
}

export interface PresetStatus {
  /** Whether a NEW mailbox may be connected now (the first is free, a second Pro). */
  canConnect?: boolean;
  accounts?: PresetAccount[];
}

export interface PresetProbe {
  /** The last successful answer; null until one arrives, and after a 404. */
  status: PresetStatus | null;
  loading: boolean;
  /** The last answer was 404: the routes are closed to this user. */
  unavailable: boolean;
  /** The last load failed for another reason (the previous answer is kept). */
  failed: boolean;
}

export type PresetProbeEvent =
  | { type: "start" }
  | { type: "loaded"; status: PresetStatus }
  | { type: "notFound" }
  | { type: "failed" };

export const INITIAL_PRESET_PROBE: PresetProbe = {
  status: null,
  loading: true,
  unavailable: false,
  failed: false,
};

export function presetProbeReducer(probe: PresetProbe, event: PresetProbeEvent): PresetProbe {
  switch (event.type) {
    case "start":
      return { ...probe, loading: true };
    case "loaded":
      return { status: event.status, loading: false, unavailable: false, failed: false };
    case "notFound":
      return { status: null, loading: false, unavailable: true, failed: false };
    case "failed":
      return { ...probe, loading: false, failed: true };
  }
}

export type PresetCardView = "hidden" | "loading" | "accounts" | "connect" | "proGate";

/** `entitled`: the plan's answer, used only when /status carries no `canConnect`. */
export function presetCardView(probe: PresetProbe, entitled: boolean): PresetCardView {
  if (probe.unavailable || probe.status === null) return "hidden";
  if (probe.loading) return "loading";
  if ((probe.status.accounts ?? []).length > 0) return "accounts";
  return (probe.status.canConnect ?? entitled) ? "connect" : "proGate";
}

/** Only the newest request may write its answer, and none after dispose (unmount). */
export function latestOnly() {
  let current = 0;
  let disposed = false;
  return {
    begin: (): number => {
      current += 1;
      return current;
    },
    isCurrent: (token: number): boolean => !disposed && token === current,
    dispose: (): void => {
      disposed = true;
    },
  };
}
