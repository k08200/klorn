# Ontology write-side — approval gate (C)

**Date:** 2026-06-23
**Status:** Approved (design)
**Scope:** single PR
**Builds on:** 2026-06-23-ontology-write-side-design.md (proposal-only, A)

## Problem

Write-side v0 (#552) produces advisory threshold proposals; applying one means a
human edits the `const` in a code PR. The next rung (C) lets a human **approve**
a proposal in-app so the classifier reads it live — without going to the
irreversible auto-live B. This is the deliberate A → C → B middle rung.

## Decision (locked in brainstorming)

**Apply mechanism: parameterized `tierFromFeatures` + a startup-loaded override
cache. No module-mutable state in the engine.**

- `tier-policy.ts`: `tierFromFeatures(features, thresholds = TIER_THRESHOLDS)`
  stays a pure function — it now takes the threshold config instead of reading
  the `const` directly. Crown-jewel engine remains pure and testable.
- `ontology-overrides.ts` (new): holds a module-level cache initialized to the
  `const` defaults. `getEffectiveThresholds()` returns it. `refreshOverrideCache()`
  rebuilds it by merging APPLIED proposals over the base. Called only at API
  server startup and after an approve/revert.
- `poc-judge.ts`: the two `tierFromFeatures` call sites pass
  `getEffectiveThresholds()`.

**Why this is eval-safe by construction:** the eval harness (`poc-accuracy.ts`)
and unit tests never call `refreshOverrideCache()` (they don't start the server),
so the cache stays at its initial `const` value → effective == base → the CI eval
gate (overall ≥80%, PUSH recall ≥90%, SILENT precision ≥90%) is unaffected.
Likewise, with zero APPLIED proposals, prod behaves exactly as today (inert).

## Architecture

### Effective-threshold merge (pure, testable)

`buildEffectiveThresholds(base, appliedRows)`:
- Group APPLIED rows by `knob`, take the most recent per knob (latest approval
  wins).
- Apply each `knob` (dotted path, e.g. `tier.push.confidence`) onto a deep copy
  of `base`.
- Re-validate every overridden value: `CLAMP` to `[0,1]` and enforce the
  tier-ordering invariant (`push.confidence` stays above `lowConfidenceFloor`,
  etc.). A row that fails validation is ignored (defense — a bad/stale row can
  never break the classifier).
- Unknown knobs are ignored.

### State + lifecycle

- `OPEN → APPLIED` on approve (cache refresh). `APPLIED → DISMISSED` on revert
  (cache refresh). The recompute auto-dismiss only targets `OPEN`, so APPLIED
  overrides are never auto-cleared.
- A knob can have an APPLIED override and a newer OPEN proposal (a further
  adjustment on top of the live value). `buildEffectiveThresholds` uses APPLIED
  only.

### Endpoints (admin, requireAdmin)

- `POST /api/admin/ontology/proposals/:id/approve` → set APPLIED, refresh cache.
- `POST /api/admin/ontology/proposals/:id/revert` → set DISMISSED, refresh cache.
- `GET /api/admin/ontology` already returns the snapshot; extend `describePolicy`
  to expose `base`, `effective`, and the set of overridden knobs so the
  inspector/web can show "live value (overridden from X)".

### Startup

`index.ts` calls `refreshOverrideCache()` once after the server is ready (best
effort: a failure logs + captureError and leaves the cache at `const`, i.e.
today's behavior — never blocks boot).

### Surfaces

- Desktop Brain Inspector and `/admin/ontology` web page: an **Approve** button
  on each OPEN proposal and a **Revert** on APPLIED ones; show base vs effective.

## Safety (CASA / locked 4-tier)

- Engine stays pure; overrides enter only via an explicit parameter at the judge
  call site.
- Every override is re-clamped + ordering-checked at cache build; failures are
  ignored.
- Only admin-approved knobs apply; revert is one click; audit = the proposal row
  + status transitions.
- 4-tier vocabulary/structure untouched (PUSH/QUEUE/SILENT/AUTO) — scalar
  thresholds only.
- Single-dyno assumption: other dynos see an approval only after restart/refresh.
  Acceptable today (prod is single-dyno); a periodic refresh can be added later.

## Testing (TDD)

- `buildEffectiveThresholds`: merge applies override; latest-per-knob wins;
  out-of-range value ignored (re-clamp); tier-ordering violation ignored; unknown
  knob ignored; empty rows → base unchanged.
- `tierFromFeatures(features, overriddenThresholds)` changes the tier as expected
  vs `tierFromFeatures(features)` (default base).
- `getEffectiveThresholds()` returns base before any refresh (eval-safety
  invariant) and the merged config after a refresh.
- Approve endpoint flips status + the next `getEffectiveThresholds()` reflects it.
- Eval gate stays green (run the judge eval locally; effective == base in that
  context).

## Out of scope

- Auto-live override (B) — still requires a human approval.
- Overrides on sender priors / keyword scores (proposals only cover tier
  thresholds today).
- Multi-dyno cache invalidation (single-dyno today).
