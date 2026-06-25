# Sender Trait Extraction (Phase 3 / B2) — Design

**Date:** 2026-06-25
**Status:** Approved design, pending implementation plan
**Origin:** AutoBE-adoption plan, Phase 3 (B2). See `project_klorn_autobe_adoption_plan_2026_06_25` memory.

## Context

Klorn's "living ontology" is already ~60% parity with AutoBE's decision-ledger
pattern. What exists today (build **on top of**, do not rebuild):

- `DecisionLabel` — immutable per-`(userId, source, sourceId)` ledger with the
  4-feature vector, `shownTier`, `sender`, `decidedBy`, and a frozen `outcome`.
- `attention-input-hash.ts` — SHA-256 content signature (`from, subject, snippet,
  labels`) with `HASH_SCHEMA_VERSION`; stored on `AttentionItem.inputHash` for
  staleness detection.
- `decision-metrics.ts` — bounded recall / over-suppression (honest by
  construction); `ontology-proposals` / `ontology-overrides` — threshold
  auto-proposals + approval gate.
- `sender-policy.ts` — `SenderFacts` interface: **DB-derived** facts
  (`tierHistory`, `manualOverrides`, `interaction`, `commitments`) assembled in
  `judge-context.ts`; the judge stays pure.
- `AttentionItem.evidence Json?` — already holds per-decision supporting
  snippets.

**The gap (vs AutoBE's decision-ledger):** there is no deterministic, structured
extraction of per-sender facts *from email text* — facts that cannot be computed
from existing tables (who a sender is, what they recurrently want), carried with
quoted evidence, versioned, signature-invalidated, and contradiction-checked.

## Goals (v0)

Extract + store + **measure** per-sender traits. The judge is **not** modified.

- Extract a small, fixed taxonomy of per-sender traits from email text, each with
  quoted evidence and a confidence score.
- Persist them versioned and signature-gated in a new `SenderTrait` table.
- Detect contradictions at write time (never silently overwrite).
- Surface coverage / conflict-rate / confidence / an evidence inspector so the
  extraction quality can be judged **before** any trait touches classification.

## Non-goals (v0 — deferred to fast-follow)

- **Judge injection.** Feeding traits into `judge-context.ts` is a separate,
  eval-gated fast-follow, entered only once the v0 measurements pass (see
  "Measure / gate"). v0 leaves the hot path byte-for-byte unchanged.
- **Conflict *resolution* policy** (which contradicting value wins). v0 only
  *detects and flags*; resolution (human review or a confidence rule) is later.
- **Domain-level rollup** (all `@stripe.com` as one sender). v0 keys on the
  sender address, consistent with `sender-policy.ts`.
- **`cadence` as an extracted trait** — it is derivable from
  `SenderFacts.interaction` (emailCount / lastEmailDaysAgo); extracting it would
  violate "measure not inject."

## Naming

The new persisted layer is **`SenderTrait`** (singular model, one row per fact),
deliberately distinct from the existing runtime-assembled `SenderFacts` interface
(DB-derived bundle). "Trait" = an observed sender characteristic extracted from
content.

## Data model

```prisma
enum SenderTraitKind {
  relationship      // who the sender is to the user
  recurring_intent  // what they recurrently want
}

enum SenderTraitStatus {
  active
  superseded
  conflicted
}

model SenderTrait {
  id     String @id @default(uuid())
  userId String
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)

  sender   String           // sender address — same key as sender-policy.ts
  factKind SenderTraitKind
  factValue String          // validated per-kind by llm-coerce (see taxonomy)
  confidence Float          // 0..1 (asUnitInterval)
  evidenceText String       // quoted snippet justifying the trait

  // attention-input-hash-style signature over the sampled source emails; an
  // unchanged signature means the evidence set is unchanged → skip re-extraction.
  sourceSig String
  observedCount Int @default(1)

  // Contradiction capture (write-time). On a different extracted value the row
  // flips to `conflicted`, keeps the incumbent value, and stashes the challenger
  // here — never a silent overwrite.
  conflictValue    String?
  conflictEvidence String?
  conflictedAt     DateTime?

  status SenderTraitStatus @default(active)

  firstSeenAt DateTime @default(now())
  lastSeenAt  DateTime @default(now())
  updatedAt   DateTime @updatedAt

  // One current value per (sender, kind) per user — the contradiction point.
  @@unique([userId, sender, factKind])
  @@index([userId, sender])
  @@index([userId, factKind, status])
}
```

### Starter taxonomy (allowed values — validated by `llm-coerce`)

Vocabulary aligns with `EmailCategory` where sensible (investor, customer,
internal, automated) for cross-signal consistency.

- **relationship:** `vendor | customer | investor | internal_colleague |
  recruiter | service_automated | personal | unknown`
- **recurring_intent:** `billing | scheduling | newsletter |
  transactional_receipt | support | sales_outreach | personal_correspondence |
  none`

`factValue` stays a Prisma `String` (the value set differs per kind, so a single
Prisma enum can't span it); it is validated in code against the kind's allowed
set via `llm-coerce.asEnum`. `factKind` and `status` ARE Prisma enums
(load-bearing — a typo must fail at compile time, per the `OntologyProposal`
doctrine).

## Extraction placement & data flow

Runs as a **scheduler batch job**, mirroring the existing weekly
`extractVoiceProfilesForAllUsers` job (`automation-scheduler.ts`): async, off the
hot path, per-user, dynamic-imported, skip-if-fresh.

```
extractSenderTraits  (automation-scheduler, async, best-effort)
  1. Select senders with new mail since last extraction (or active top-N).
  2. Sample the sender's most recent K emails.
  3. sourceSig = content signature over the sample (attention-input-hash style).
     └ if sourceSig unchanged since the stored row → SKIP (idempotent, cost).
  4. ONE LLM call per sender → { relationship, recurring_intent, evidence } as a
     structured JSON object.
  5. Validate values with llm-coerce (Phase 1). Invalid value → drop that fact.
  6. Upsert per (userId, sender, factKind): strengthen | conflict | create.
```

The judge does **not** read `SenderTrait` in v0. Hot-path classification is
unchanged. Model = the paid judge model (batch, low volume per sender); BYOK key
when set, env fallback otherwise (existing pattern).

## Conflict detection (write-time)

`detectSenderTraitConflicts` is the upsert resolver, a pure function of
`(incumbent, challenger)`:

- **No incumbent** → create (`active`, observedCount 1).
- **Same value** → strengthen: `observedCount++`, refresh
  `sourceSig`/`evidenceText`/`lastSeenAt`. Stays `active`.
- **Different value** → contradiction: set `status = conflicted`, keep the
  incumbent `factValue`, fill `conflictValue` / `conflictEvidence` /
  `conflictedAt`. Never a silent overwrite. The contradiction is a visible
  signal; resolution is deferred.

A `conflicted` trait is, in the fast-follow, *not* consumed by the judge (do not
ground on a contested fact).

## Measure / gate

v0 leaves the judge untouched, so the measurements ARE the deliverable — they
decide whether traits are trustworthy enough to inject later. Mirrors
`decision-metrics.ts` ("honest by construction"):

1. **Coverage** — % of active senders with ≥1 trait.
2. **Conflict rate** — % of `(sender, kind)` in `conflicted`. High = unstable
   extraction (model flip-flops) = not ready to inject.
3. **Confidence distribution** — histogram of `confidence`.
4. **Evidence inspector** — admin/CLI view of `sender → traits + evidenceText`,
   so the founder dogfood-verifies on their own inbox that the evidence actually
   justifies each trait (precision-gate doctrine: founder account = truth source).
5. *(optional)* Cross-check `relationship` against accumulated `EmailCategory`
   history for agreement.

**Gate to the fast-follow (judge injection):** reasonable coverage + low conflict
rate + founder evidence eyeball passes.

Surface: trait metrics alongside `decision-metrics.ts` / `calibration-snapshot.ts`
+ an evidence inspector route/CLI.

## Components & boundaries

Small, single-purpose units:

- `sender-trait-policy.ts` — taxonomy (kinds + allowed values) + per-kind
  validation. Pure.
- `sender-trait-extractor.ts` — prompt + LLM call + parse + validate → candidate
  traits. Mockable (mock `createCompletion`).
- `sender-trait-store.ts` — `detectSenderTraitConflicts` resolver + upsert. Pure
  resolver + thin DB layer.
- `sender-trait-metrics.ts` — coverage / conflict-rate / confidence aggregation.
  Pure read.
- scheduler wiring in `automation-scheduler.ts` — mirror the voice-profile job.
- admin route / CLI — evidence inspector.
- Prisma migration — `SenderTrait` + two enums.

## Error handling (Phase 0 discipline — never swallow)

- The job follows the Phase 0 pattern: on failure `console + captureError(scope:
  "sender-traits.extract")`.
- **Per-sender isolation** — `Promise.allSettled` + per-result inspection (the F2
  fix pattern). One sender's failure never sinks the batch.
- LLM failure → skip that sender + capture, continue. Validation failure → drop
  that fact + log (no garbage persisted).
- Signature gate skips unchanged senders (cost + safety). Upsert is transactional.
- A job failure is captured but never blocks the scheduler tick.

## Testing strategy (TDD, vitest, repo conventions)

- `sender-trait-policy` — relationship / recurring_intent enum whitelists.
- `sender-trait-store` conflict resolver — same-value→strengthen,
  different-value→conflicted, first-time→create; all branches, pure, no DB/LLM.
- signature skip — unchanged sig → skip.
- `sender-trait-extractor` (mocked LLM) — valid → correct upserts; invalid enum →
  dropped/coerced; LLM failure → captured, no crash; per-sender isolation.
- `sender-trait-metrics` — coverage / conflict-rate aggregation (pure).

## Migration

Prisma migration adds `SenderTrait` + `SenderTraitKind` + `SenderTraitStatus`. No
change to existing tables. Additive and reversible.

## Open questions / deferred

- Judge injection shape (how traits render into `judge-context.ts` without
  bloating the prompt) — fast-follow, eval-gated.
- Conflict *resolution* policy (confidence rule vs human review).
- Domain-level rollup for org-wide senders.
- Sampling size K and batch selection (top-N vs all-with-new-mail) — tune in the
  plan against cost.
