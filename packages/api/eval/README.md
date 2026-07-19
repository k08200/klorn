# Judge eval set

`judge-eval-set.json` is a **synthetic, PII-free** 50-email set used to
regression-test the 4-tier judge (`src/poc-judge.ts`). It is NOT the
founder's private 50-email ground truth (that file is gitignored and never
leaves the machine) — it encodes the same locked mental model:

- **QUEUE** is the default ("I'll look at this on my own schedule")
- **SILENT** is narrow: clear marketing/promo only
- **PUSH** is urgent + confident
- **AUTO** is reversible + confident + not urgent (classify-only during POC)

## The two gates

| Gate | What runs | Where | Bar |
|---|---|---|---|
| Deterministic | fast-path + keyword fallback (no LLM, no keys) | `src/__tests__/judge-eval-set.test.ts`, every CI test run | ≥70% accuracy floor + safety invariants |
| LLM end-to-end | real provider via `judgeEmail` | `.github/workflows/eval.yml` (PRs touching judge files) or `pnpm eval:judge` | ≥80% (poc-accuracy exits 2 below it) |

Safety invariants (enforced on every run, even on misses):

1. A missed PUSH must degrade to **QUEUE** (visible), never SILENT (hidden).
2. A SILENT-labelled marketing item must never be predicted PUSH.

## Numbers at introduction (2026-06-12)

- No-LLM pipeline: 39/50 = **78%**. The 11 misses are urgent-human-non-investor
  PUSH items and all AUTO items — both need LLM feature extraction, which is
  exactly why the fallback floor sits at 70%, not 80%.

The deterministic floor is a **ratchet**: raise it when the fallback improves;
never lower it to make a PR pass.

## JUDGE_INCLUDE_BODY measurement (2026-07-20)

`pnpm eval:judge:body` (the 8-item body-dependent set, where from+subject+snippet
deliberately point at the WRONG tier) against claude-sonnet-5 via OpenRouter:

| | body OFF | body ON | Δ |
|---|---|---|---|
| overall accuracy | 0% | **62.5%** | +62.5pt |
| PUSH recall | 0% | **100%** | +100pt |
| PUSH precision | 0% | **100%** | +100pt |
| QUEUE recall | 0% | 50% | +50pt |

Zero provider errors in either run; the OFF-side zeros are by construction (the
set exists to isolate the body's contribution). Both remaining ON-side misses
(1 SILENT, 1 AUTO) degraded to QUEUE — the safe direction. Conclusion: the flag
stays ON in prod (flipped 2026-07-20); on snippet-misleading mail it is the
difference between missing every PUSH and catching them all.

## Adding cases

Add cases when you find a real misclassification worth locking in:

1. Reproduce the email **synthetically** — fictional sender/domain, no real
   names, no real addresses. Keep the structural signal (sender pattern,
   subject markers, urgency words), drop the identity.
2. Set `label` to the tier the founder would choose, add a `note` saying why
   it's interesting (e.g. "hard for keyword fallback").
3. Run `npx vitest run src/__tests__/judge-eval-set.test.ts` and
   `pnpm eval:judge` (needs `OPENROUTER_API_KEY` or `GEMINI_API_KEY`).

## Running against the private ground truth

The original POC measurement still works unchanged:

```bash
DATABASE_URL=... OPENROUTER_API_KEY=... npx tsx scripts/poc-accuracy.ts \
  --in=../../poc-ground-truth.json
```

## Weekly canary: verdict flips + margin erosion (#769)

`judge-canary.yml` re-scores the committed set every Monday and compares the
run against the previous week's baseline with `scripts/canary-compare.ts`:

- **Verdict flip = alarm.** An item present in both runs whose predicted tier
  changed (with an unchanged label) fails the workflow. On a fixed set with a
  temperature-0 judge, a flip means the decision boundary itself moved —
  prompt drift, threshold change, or provider-side model drift. This is the
  signal the PR-gate eval cannot see: it only runs when a PR touches judge
  files, never on an unchanged codebase.
- **Margins = readout.** Per floor check, `value − floor` for both runs and
  the delta, so a floor that is still green but clearing by less every week
  (e.g. PUSH recall 0.92 → 0.91 → 0.901 against a 0.90 floor) is visible
  before the run that finally trips it.

Baseline lifecycle: on a stable run the baseline refreshes (rolling
actions/cache key); on an alarm it is kept, so the flip keeps firing weekly
until investigated. To accept a new normal, run the workflow manually with
`accept-baseline=true`.

## 2026-07-16: real mail is measured on every PR (report-only, ratchet pending)

The judge was measured on **`eval/real-eval-set.json`** — 53 founder-labeled
real emails (18 SILENT / 31 QUEUE / 4 PUSH, 50 with bodies) — for the first
time. Cold-start (no sender context), with role-preserving scrub so the
deterministic sender floors fire:

- **Overall 81.1% (43/53)** — the original POC GO/NO-GO bar (≥80% on real
  mail) PASSES. QUEUE recall 80.6%, SILENT recall 100%.
- **PUSH recall 0/4** — 3 of 4 are the founder's own `OVERRIDE:PUSH` senders
  (waitlist notifications): in prod those overrides form a sender-prior that
  short-circuits to PUSH; the cold-start eval can't see it. The context-aware
  fix is per-item fixtures from the ledger (`--context=fixture`).
- **SILENT precision 78.3%** — newsletters the founder actually reads,
  buried by the generic rule. This is the gap the (dark) engagement flag
  exists to close; these numbers are its flip evidence.

Wiring, until PUSH support matures:
- **`eval.yml`**: the synthetic set stays the GATE; a second
  "Real-mail readout (report-only)" step prints the real numbers on every
  judge PR (a floor breach is a `::warning`, never a fail).
- **`judge-canary.yml`** runs the real set weekly for FLIP detection only —
  floor breaches are expected (warning), drift alarms are not.
- **Warm-start fixtures**: items carry `context` snapshots (senderPrior +
  senderFacts, numeric-only) taken from the production `buildJudgeContext`
  via `--emit-context` — so the readout measures the judge the way prod runs
  it (the founder's OVERRIDE:PUSH priors short-circuit). Re-emit after
  ledger-heavy dogfood stretches.
- **Ratchet condition**: when the regenerated set reaches **PUSH support
  ≥10** (every in-app override/confirm adds ledger rows for the next
  `draft-real-eval-set.ts` run), repoint the gate step at
  `real-eval-set.json` and delete the report-only step.
- The synthetic 50-item set stays committed — the deterministic no-LLM test
  (`judge-eval-set.test.ts`) still pins it.

**The blocker is the data, not the wiring** — and the review step is
deliberately manual. The drafting kit (`scripts/draft-real-eval-set.ts`, #648)
automates everything AROUND that step, never the step itself:

1. **DRAFT** (local, never committed — the output name matches the gitignored
   `poc-*.json` pattern):
   ```bash
   npx tsx scripts/draft-real-eval-set.ts --user=<founder email> \
     --in=../../poc-ground-truth.json
   ```
   Collects real labeled mail from the POC ground-truth file (bodies joined
   from the DB) **plus** the DecisionLabel ledger (`OVERRIDE:<tier>` /
   `CONFIRM:<tier>` rows — every override/confirm in the app grows this set),
   then mechanically scrubs addresses/URLs/phones with deterministic,
   sender-consistent placeholders (`src/eval-scrub.ts`).
2. **REVIEW** — the founder eyeballs every row: fix names/orgs the patterns
   can't see (each row carries `scrubNotes` showing what was replaced), then
   set `reviewed: true`. This step stays human; an auto-scrubber must never
   commit real mail to a public repo — one missed address is an irreversible
   leak.
3. **FINALIZE + VERIFY**:
   ```bash
   npx tsx scripts/draft-real-eval-set.ts \
     --finalize=../../poc-real-eval-set.draft.json --final-out=eval/real-eval-set.json
   npx tsx scripts/draft-real-eval-set.ts --verify=eval/real-eval-set.json
   ```
   Finalize refuses unless every row is `reviewed:true`, strips the review
   fields, and runs the leak-linter; verify is the standalone pre-commit
   tripwire (exit 2 on any address/URL/phone-shaped remnant). Run verify
   before every commit that touches the file.
4. Once committed, flip the `--in=` above. Then "green canary" and "thesis
   proven on real mail" become the **same auditable event** — the whole point
   of the gate.

Keep the deterministic floor + safety invariants identical; only the data set
changes.

## Context modes (#650 — eval runs the judge's real context path)

`poc-accuracy.ts` used to judge every item with `EMPTY_JUDGE_CONTEXT`, so the
context flags (`LEARNED_RULES_IN_JUDGE`, `CONTACT_ENGAGEMENT_IN_JUDGE`,
`SENDER_TRAITS_IN_JUDGE`) were structurally invisible to the eval — an ON/OFF
A/B was a no-op by construction. Three modes close that hole:

| Mode | Flag | What feeds the judge |
| --- | --- | --- |
| `fixture` (default) | `--context=fixture` | per-item `context` fixtures from the eval JSON (strictly validated — a typo fails the run); items without one get the empty context, byte-identical to the old eval |
| `empty` | `--context=empty` | forces the empty context — the A/B baseline |
| `db` | `--context=db --user=<email>` | the **production** `buildJudgeContext` against a real `DATABASE_URL` — the offline instrument for measuring a context flag on a real account before flipping it in prod |

A fixture may carry `corrections`, `senderPrior`, `senderFacts`,
`senderTraits`, and `learnedRules` (see `src/eval-context.ts` for the exact
shapes). The CI gate runs with `JUDGE_INCLUDE_BODY=true` to match prod (#653);
this is inert on the committed set until items carry `body` fields (#648).

**db mode requires an UNSCRUBBED input** (`poc-ground-truth.json` or the local
draft) and refuses scrubbed sets. Placeholder senders (`*.example`) resolve to
nothing in the DB, so every sender-scoped channel comes back empty while the
user-scoped correction few-shots still land in every prompt — a context no
real email ever gets. Measured 2026-07-16: the committed set under db mode
scored 69.8% vs 84.9% in fixture mode — pure instrument artifact, not drift.

## Per-tier gating floors

`--gate-floor=auto-recall=0.5,push-recall=0.95` promotes a report-only tier to
a gating check and/or tightens a committed floor. Floors are ratchets: a
default-gating floor (overall, push-recall, silent-precision) can only be set
at or above its committed value; report-only tiers (queue-recall, auto-recall)
may gate at any floor once a stable baseline exists.

## Model canary (#526 — the non-judge surfaces)

`model-canary.yml` (Mondays 02:00 UTC) extends the same flip-alarm machinery to
the models the judge canary cannot see: **chat (`MODEL`)** and
**agent (`AGENT_MODEL`)**, with **vision (`VISION_MODEL`) via manual dispatch**
(its default pin is a `:free` SKU whose quota flakiness would false-alarm a
schedule). These have no ground-truth labels, so instead of accuracy floors the
probe set (`src/llm/model-canary-probes.ts`) mixes:

- **objective probes** — micro-tasks with one canonical answer (arithmetic,
  extraction, date math, logic) → a report-only accuracy readout, and
- **fingerprint probes** — tasks with many valid answers where a
  temperature-0 model makes a stable idiosyncratic choice → a different model
  behind the same SKU id almost certainly picks differently.

Any answer flip on an identical probe fails the workflow (same
`scripts/canary-compare.ts`, same baseline lifecycle and
`accept-baseline=true` procedure as the judge canary).
