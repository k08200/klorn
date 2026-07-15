/**
 * Ontology write-side — approval gate (C): the effective-threshold cache.
 *
 * Write-side v0 produced advisory proposals. This lets an admin APPROVE one so
 * the classifier reads it live, without going to auto-live (B). The merge is
 * deliberately built so the engine stays safe:
 *   - `tierFromFeatures` stays a pure function taking a ThresholdConfig; this
 *     module only builds the config it's handed at the judge call site.
 *   - The cache starts at the base `const` and is rebuilt only by
 *     refreshOverrideCache() (server startup + after approve/revert). The eval
 *     harness and unit tests never call it, so effective == base there → the CI
 *     eval gate is unaffected. With zero APPLIED rows, prod == base too.
 *   - Every override is re-validated at build time (finite + [0,1] + tier
 *     ordering); a bad or stale row is ignored, never breaking classification.
 *
 * See docs/superpowers/specs/2026-06-23-ontology-approval-gate-design.md.
 */

import { prisma } from "../db.js";
import { captureError } from "../sentry.js";
import { type ThresholdConfig, TIER_THRESHOLDS } from "../tier-policy.js";

export interface AppliedOverride {
  knob: string;
  proposedValue: number;
  updatedAt: Date | string;
}

/** Setters for the knobs a proposal can target. Unknown knobs are ignored. */
const KNOB_SETTERS: Record<string, (c: ThresholdConfig, v: number) => void> = {
  "tier.lowConfidenceFloor": (c, v) => {
    c.lowConfidenceFloor = v;
  },
  "tier.push.confidence": (c, v) => {
    c.push.confidence = v;
  },
  "tier.push.urgency": (c, v) => {
    c.push.urgency = v;
  },
  "tier.silent.senderTrust": (c, v) => {
    c.silent.senderTrust = v;
  },
  "tier.silent.urgency": (c, v) => {
    c.silent.urgency = v;
  },
  "tier.silent.reversibility": (c, v) => {
    c.silent.reversibility = v;
  },
  "tier.auto.reversibility": (c, v) => {
    c.auto.reversibility = v;
  },
  "tier.auto.confidence": (c, v) => {
    c.auto.confidence = v;
  },
  "tier.auto.urgency": (c, v) => {
    c.auto.urgency = v;
  },
  "tier.auto.senderTrust": (c, v) => {
    c.auto.senderTrust = v;
  },
};

function deepCopy(base: ThresholdConfig): ThresholdConfig {
  return {
    lowConfidenceFloor: base.lowConfidenceFloor,
    push: { ...base.push },
    silent: { ...base.silent },
    auto: { ...base.auto },
  };
}

/** Keep only the most recent row per knob (latest approval wins). */
function latestPerKnob(rows: readonly AppliedOverride[]): Map<string, number> {
  const latest = new Map<string, { value: number; at: number }>();
  for (const row of rows) {
    const at = new Date(row.updatedAt).getTime();
    const prev = latest.get(row.knob);
    if (!prev || at >= prev.at) latest.set(row.knob, { value: row.proposedValue, at });
  }
  return new Map([...latest].map(([knob, v]) => [knob, v.value]));
}

/**
 * Merge applied overrides onto a deep copy of `base`. Pure. Each override must
 * be a known knob with a finite value in [0,1]; the result must keep PUSH
 * reachable (push.confidence > lowConfidenceFloor) or the push override is
 * dropped. Anything invalid is silently ignored — a bad row can never corrupt
 * the live policy.
 */
export function buildEffectiveThresholds(
  base: ThresholdConfig,
  rows: readonly AppliedOverride[],
): ThresholdConfig {
  const out = deepCopy(base);
  for (const [knob, value] of latestPerKnob(rows)) {
    // Own-property lookup only: a knob like "__proto__"/"constructor" must not
    // resolve to an inherited member (prototype-pollution / crash guard).
    if (!Object.hasOwn(KNOB_SETTERS, knob)) continue; // unknown knob
    if (!Number.isFinite(value) || value < 0 || value > 1) continue; // out of range
    KNOB_SETTERS[knob](out, value);
  }
  // Ordering invariant: PUSH must stay reachable above the QUEUE floor. If an
  // override (to push.confidence OR lowConfidenceFloor) breaks it, drop BOTH
  // back to base — base always satisfies the invariant, so PUSH can never be
  // made unreachable by an approval.
  if (out.push.confidence <= out.lowConfidenceFloor) {
    out.push.confidence = base.push.confidence;
    out.lowConfidenceFloor = base.lowConfidenceFloor;
  }
  return out;
}

// The live effective config the judge reads. Starts at an owned copy of base
// (never the `as const` object itself, so a consumer of getEffectiveThresholds()
// can't mutate the module const). Only refreshOverrideCache()/applyOverrides()
// replace it.
let cache: ThresholdConfig = deepCopy(TIER_THRESHOLDS);

/** The thresholds the classifier should use right now (base + applied overrides). */
export function getEffectiveThresholds(): ThresholdConfig {
  return cache;
}

/** Rebuild the cache from a set of applied overrides (sync; used by refresh + tests). */
export function applyOverrides(rows: readonly AppliedOverride[]): void {
  cache = buildEffectiveThresholds(TIER_THRESHOLDS, rows);
}

/** Reset the cache to an owned copy of base (tests; safe state). */
export function resetOverrideCache(): void {
  cache = deepCopy(TIER_THRESHOLDS);
}

/** Count knobs whose effective value differs from base (for logging/surfacing). */
export function overriddenKnobs(): string[] {
  const eff = cache;
  const out: string[] = [];
  if (eff.lowConfidenceFloor !== TIER_THRESHOLDS.lowConfidenceFloor)
    out.push("tier.lowConfidenceFloor");
  for (const group of ["push", "silent", "auto"] as const) {
    for (const field of Object.keys(TIER_THRESHOLDS[group]) as Array<
      keyof (typeof TIER_THRESHOLDS)[typeof group]
    >) {
      if (
        (eff[group] as Record<string, number>)[field as string] !==
        (TIER_THRESHOLDS[group] as Record<string, number>)[field as string]
      ) {
        out.push(`tier.${group}.${String(field)}`);
      }
    }
  }
  return out;
}

/**
 * Load APPLIED proposals and rebuild the effective-threshold cache. Best-effort:
 * on failure it logs + captures and leaves the cache at its last known state
 * (base on first load; the previously-loaded overrides on a later transient
 * failure), never throwing. Returns true on success so a caller (approve/revert)
 * can tell the admin whether the change actually went live. Call at server
 * startup and after approve/revert.
 */
export async function refreshOverrideCache(): Promise<boolean> {
  try {
    const rows = await prisma.ontologyProposal.findMany({
      where: { status: "APPLIED" },
      select: { knob: true, proposedValue: true, updatedAt: true },
    });
    applyOverrides(rows);
    console.log(
      `[ontology] override cache refreshed: ${overriddenKnobs().length} active override(s)`,
    );
    return true;
  } catch (err) {
    console.error("[ontology] override cache refresh failed; cache unchanged", err);
    captureError(err, { tags: { scope: "ontology.override-cache" } });
    return false;
  }
}
