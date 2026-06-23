# Ontology write-side v0 — threshold-adjustment proposals

**Date:** 2026-06-23
**Status:** Approved (design)
**Scope:** single PR

## Problem

The shared ontology (`describePolicy()` in `ontology.ts`) is read-only: it
snapshots the deterministic core the classifier runs on (`TIER_THRESHOLDS`,
`SENDER_PRIOR_POLICY`, `KEYWORD_SCORES`, the model dial), all compile-time
`const`s. The strategy treats a **read/write** living ontology as the moat, and
Phase 5 calibration (override signal → threshold correction) depends on a write
path existing. Today there is none: override data is measured
(`decision-metrics.ts`) but nothing turns it into changes to the policy.

## Decision (locked in brainstorming)

- **Apply model: proposal-only.** The classifier keeps reading the git `const`s.
  The write-side produces *proposed* threshold adjustments, stores and surfaces
  them, but never mutates live classification. An approved proposal is applied by
  a human via a normal code PR (git = audit trail + revert). Live DB-override and
  approval-gated override are deliberately deferred — proposal-only is their
  precondition, and going live before the loop has run a cycle is an
  irreversible call we are not making yet.
- **Source + scope: auto-derived, tier thresholds only.** Proposals come from the
  existing aggregate decision-metrics — PUSH `recallUpperBound` and SILENT
  `overSuppressionRate` — which map directly to `TIER_THRESHOLDS.push` and
  `.silent`. Sender priors and keyword scores are out of scope: override data
  does not cleanly map to them, so proposing there would be guessing, not
  measuring. They can be added once the loop produces signal that points at them.

These are consistent with the 2026-06-23 LOCKED build doctrine (the
PoC/measure-first gate is superseded for this initiative) while keeping the
safety the doctrine still requires (bounds, audit, revert).

## Architecture

### Data model — `OntologyProposal` (new Prisma model)

```
id            String   @id @default(uuid())
knob          String   // dotted path, e.g. "tier.push.confidence"
currentValue  Float    // the live const value at proposal time
proposedValue Float
direction     String   // "RAISE" | "LOWER"
evidence      Json     // { metric, value, target, windowDays, sampleSize }
status        String   @default("OPEN") // OPEN | APPLIED | DISMISSED
createdAt     DateTime @default(now())
updatedAt     DateTime @updatedAt
@@unique([knob, status])   // at most one OPEN proposal per knob (re-run updates it)
```

A dedicated model (not the `CalibrationSnapshot` Json blob) so proposals are
queryable and have a status lifecycle.

### Generation flow

1. **Pure mapper** `proposeThresholdAdjustments(metrics, opts)` in a new
   `ontology-proposals.ts`. Input: the aggregate decision-metrics
   (`recallUpperBound`, `overSuppressionRate`, sample counts). Output: an array
   of proposal candidates `{ knob, currentValue, proposedValue, direction,
   evidence }`. Rules:
   - PUSH `recallUpperBound` < `PUSH_RECALL_TARGET` (0.9, the CI gate floor)
     → propose LOWER on `tier.push.confidence` (and/or `tier.push.urgency`).
   - SILENT `overSuppressionRate` > `SILENT_OVERSUPPRESS_TARGET` (0.1)
     → propose tightening the `tier.silent` gate so SILENT fires more rarely:
     each silent knob moves in the direction that shrinks the SILENT region
     (RAISE the `reversibility` requirement; LOWER the `urgency`/`senderTrust`
     ceilings). `direction` is recorded per knob.
   - Guards: skip when `sampleSize < MIN_SAMPLE` (no proposal on thin data);
     cap the delta at `MAX_STEP` per run; `CLAMP` to `[0,1]`; never cross the
     adjacent tier's value (ordering invariant).
2. **Thin writer** persists candidates as `OPEN` proposals, updating the
   existing `OPEN` row for a knob instead of stacking duplicates (the
   `@@unique([knob, status])` rail).
3. **Cadence:** run from the existing daily `calibration.ts` job, plus an
   on-demand `POST /api/admin/ontology/proposals/recompute` (requireAdmin) so
   the founder can regenerate without waiting a day.

### Surfacing

`describePolicy()` gains a sibling read that includes open proposals (or
`describePolicy()` itself returns a `proposals` field). The desktop Brain
Inspector and a web admin view render "current → proposed (evidence)" read-only.
This makes the write-side visible: the brain shows both the value it runs on and
the value the signal suggests.

### Safety (CASA / locked 4-tier)

- The classifier runtime never reads proposals — behavior is unchanged.
- Proposed values are clamped to `[0,1]`, capped per-step, hold the tier-ordering
  invariant, and require a minimum sample size.
- Status is advisory; apply/audit/revert is the git PR that edits the `const`.
- Only threshold scalars are touched. The 4-tier vocabulary/structure
  (PUSH/QUEUE/SILENT/AUTO) is untouched — no 5th tier, no new branch.

## Testing (TDD)

- `proposeThresholdAdjustments` pure unit tests:
  - recall below target → LOWER proposal on push;
  - over-suppression above target → RAISE proposal on silent;
  - sample below floor → no proposal;
  - delta respects `MAX_STEP` and `CLAMP`;
  - never crosses the adjacent tier (ordering invariant);
  - metrics within target → no proposals.
- Writer dedup test: re-running updates the OPEN row, does not stack.
- `describePolicy` (or sibling) includes open proposals.

## Out of scope (explicit)

- Live or approval-gated override that the classifier reads at judge time.
- Proposals on sender priors or keyword scores.
- Per-user thresholds (the policy is global; proposals are global, aggregating
  the ledger — fine while prod is single-user dogfood).
- Auto-applying a proposal. Application stays a human git PR.
