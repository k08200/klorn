# Judge eval set

`judge-eval-set.json` is a **synthetic, PII-free** 56-email set used to
regression-test the judge. It is NOT the founder's private ground truth (that
file is gitignored and never leaves the machine) — it encodes the same locked
mental model. It was a 50-item, 4-tier set at introduction; #1134 dual-labelled
it for v2 and grew it to 56, and #1138 made v2 the default, so the live label
distribution is **17 QUEUE / 13 PUSH / 12 SILENT / 10 INFO / 4 MEETING**:

- **QUEUE** is the default ("I'll look at this on my own schedule")
- **SILENT** is narrow: clear marketing/promo only
- **PUSH** is urgent + confident
- **MEETING** is scheduling; **INFO** is an automated record worth keeping
- **AUTO** is not a lane — it is a per-email eligibility flag plus an
  account-level mode. The set carries **zero** truth-AUTO items, so every
  AUTO readout below is vacuous by construction, not a passing score.

## The two gates

| Gate | What runs | Where | Bar |
|---|---|---|---|
| Deterministic | fast-path + keyword fallback (no LLM, no keys) | `src/__tests__/judge-eval-set.test.ts`, every CI test run | ≥70% accuracy floor + safety invariants |
| LLM end-to-end | real provider via `judgeEmail` | `.github/workflows/eval.yml` (PRs touching judge files) or `pnpm eval:judge` | ≥80% (poc-accuracy exits 2 below it) |

Safety invariants (enforced on every run, even on misses):

1. A missed PUSH must degrade to **QUEUE** (visible), never SILENT (hidden).
2. A SILENT-labelled marketing item must never be predicted PUSH.

## Numbers at introduction (2026-06-12 — historical, 50-item 4-tier set)

- No-LLM pipeline: 39/50 = **78%**. The 11 misses are urgent-human-non-investor
  PUSH items and all AUTO items — both need LLM feature extraction, which is
  exactly why the fallback floor sits at 70%, not 80%.

## No-LLM pipeline re-measured (2026-08-26 — current 56-item v2 set)

- **46/56 = 82.1%** overall, with per-lane recall SILENT 12/12, MEETING 4/4,
  INFO 9/10, QUEUE 15/17, **PUSH 6/13 (46.2%)**.
- The fallback's weak axis is unchanged and worth stating plainly: **it does
  not reliably interrupt.** Seven of thirteen urgent items miss, because
  urgency on human mail needs LLM feature extraction. What it does hold is the
  invariant that matters — all seven misses landed in `QUEUE` and **none in
  `SILENT`** (silenced precision 12/12). Degraded mode costs the interrupt,
  never the message.
- Reproduce with no provider key configured:
  `pnpm eval:judge` (every item drops to the keyword path; the run exits 3
  INSTRUMENT DEGRADED, which is the intended signal when you are measuring the
  LLM and the correct one to ignore when you are deliberately measuring the
  fallback).

The deterministic floor is a **ratchet**: raise it when the fallback improves;
never lower it to make a PR pass.

## Model bake-off re-run (2026-08-26 — current model generation)

> **Superseded 2026-09-04** by the three-run measurement at the end of this file. The table below is a single run per model and ranks a one-email gap; keep it as history, cite the 09-04 tiers instead.

The bake-off the README quotes had gone stale on three axes at once: the set
had grown 50 → 56 and gained two lanes, and the comparison models (`gpt-4o`,
`gemini-2.5-pro`) were a generation behind the ones the product now offers.
Re-measured against the shipped catalog ([`model-catalog.ts`](../src/llm/model-catalog.ts)),
one run per model, identical prompt and rule, `--context=fixture`,
`JUDGE_INCLUDE_BODY=true` — i.e. the `eval.yml` environment:

| model | overall | urgent recall | silenced precision | $/M in | gate |
|---|---|---|---|---|---|
| `openai/gpt-5.4` | 56/56 = 100.0% | 13/13 | 100% | $2.50 | pass |
| `google/gemini-3.5-flash` | 55/56 = 98.2% | 13/13 | 100% | $1.50 | pass |
| `google/gemini-2.5-flash` *(default pin)* | 54/56 = 96.4% | 13/13 | 92.3% | $0.30 | pass |
| `x-ai/grok-4.3` | 53/56 = 94.6% | 12/13 | 100% | $1.25 | pass |
| `anthropic/claude-opus-4.8` | 51/56 = 91.1% | 10/13 | 100% | $5.00 | **fail** |
| `anthropic/claude-sonnet-5` | 45/56 = 80.4% | 5/13 | 100% | $2.00 | **fail** |

Three findings worth keeping:

1. **"A cheap model beats the frontier" no longer holds and has been retired
   from the README.** `gpt-5.4` scores perfectly. What replaced it is a
   stronger claim anyway: price does not order the table (the $5.00 model
   places fifth), and the spread *among* frontier models (19.6pt) is over five
   times the best-frontier-to-default-pin gap (3.6pt).
2. **`claude-sonnet-5` fails on calibration, not comprehension.** Seven of its
   eight urgent misses cleared `urgency` (0.80–1.00) and failed `confidence`
   (0.55–0.60) against the 0.70 bar in `tier-policy.ts`. It reads the mail and
   then declines to say it is sure. This is exactly the diagnosis a
   model-picks-the-tier design cannot produce.
3. **Safety invariant 1 held for every model.** Across a 19.6-point spread
   including two gate failures, truth-`PUSH` → predicted-`SILENT` was **0** in
   all six runs. Every miss degraded to `QUEUE`.

Instrument integrity for the run: zero items dropped to the keyword fallback,
and every disagreement carried an `[llm]` source tag — so the two failures are
model behaviour, not provider flakiness.

## Real-mail set: the 94.3% expired when INFO shipped (2026-08-26)

`real-eval-set.json` was last touched at #867 and its labels are drawn from the
**three-lane** vocabulary (`PUSH`/`QUEUE`/`SILENT`). The judge has since moved
to five lanes (#1125 foundation, #1138 default-ON). Re-measured on the default
pin, `--context=fixture`, three consecutive runs, byte-identical results each
time:

| run | overall | urgent recall | silenced precision |
|---|---|---|---|
| ×3 | **46/53 = 86.8%** | 3/4 | 95.5% (21/22) |

The README quoted **50/53 = 94.3%** for this set. The gap is fully accounted
for and is *not* a quality regression — **4 of the 7 misses are `QUEUE` →
`INFO`**, a prediction the label vocabulary cannot score as correct because
`INFO` did not exist when the labels were written. 46 + 4 = 50.

The four, judged on their merits rather than on the stale label:

| item | predicted | verdict |
|---|---|---|
| "Thanks for applying to Google" | `INFO` | judge looks right — automated record |
| Reddit digest recommendation | `INFO` | judge looks right — automated record |
| "[GitHub] Please verify your email address." ×2 | `INFO` | **arguable** — a verification link is an action, which argues `QUEUE` |

The remaining three are genuine misses and should stay on the books: one
`QUEUE` → `SILENT` (a product-update mail was hidden), one `QUEUE` → `PUSH` (a
confirmation code interrupted), one `PUSH` → `QUEUE`.

Model and context axes, measured separately so neither is confounded:

| configuration | overall | urgent recall |
|---|---|---|
| `gemini-2.5-flash`, warm (fixture context) | **86.8%** | 3/4 |
| `gpt-5.4`, warm | 84.9% | 3/4 |
| `gemini-3.5-flash`, warm | 77.4% | 3/4 |
| `gemini-2.5-flash`, **cold** (empty context) | 77.4% | 0/4 |

Two things worth noting. First, **synthetic-set performance does not transfer**:
`gpt-5.4` scores 56/56 on the gate set and lands *below* the 8×-cheaper default
pin on real mail. Second, the cold-start PUSH recall of 0/4 reproduces the
behaviour already documented in the 2026-07-16 section above — three of the four
urgent items are `OVERRIDE:PUSH` senders whose prior only exists warm.

**Action required before this set's number is quotable again:** re-label it
against the five-lane ontology. Until that lands, cite 86.8% with the caveat,
or cite the synthetic gate set instead. Do not restore 94.3% — it measures a
judge that no longer exists.

> 2026-10-31: 4 items (the Google new-sign-in alerts) now carry `labelV2: INFO`,
> agreed by two independent frontier-model labelers. The other 49 keep their
> 3-lane labels; the disagreements are listed for founder review in the
> "Attention engine v3, phase P1" section below.

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

## Context-channel measurement (2026-07-20)

`pnpm eval:judge:context` (new 8-item context-dependent set — base signals point
at the WRONG tier; truth is recoverable only from the per-item fixture: sender
traits, engagement, tier history — the channels prod gates behind
SENDER_TRAITS_IN_JUDGE / CONTACT_ENGAGEMENT_IN_JUDGE). Body pinned OFF in both
runs so the context contribution is isolated. claude-sonnet-5 via OpenRouter:

| | no context | with context | Δ |
|---|---|---|---|
| overall accuracy | 37.5% | **50.0%** | +12.5pt |
| PUSH precision | 50% | **100%** | +50pt (urgency-bait stopped interrupting) |
| QUEUE recall | 66.7% | **100%** | +33.3pt (promo-shaped real work rescued) |
| predicted SILENT | — | **0** | never hides non-marketing mail |

The three truth-SILENT items (payment-scare bait, recruiter cold outreach, CI
noise) landed QUEUE even with damning context — the locked "SILENT is narrow:
clear marketing only" rule holds, so the channel's wins come with zero
over-suppression risk. Recommendation recorded here: flip both context flags ON.

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

## Bake-off re-measured with variance (2026-09-04 — 10 models × 3 runs)

The 2026-08-26 table above ranked six models on one run each. A reader
objected that on 56 items every 1.8pt is a single email, so single-run
ordering is noise; re-measuring confirmed that for the middle of the table
and refuted it for the ends. Two further defects were found in the 08-26 run
while doing so: it benchmarked the product's chat catalog (pinned 2026-07-04)
and so missed `gemini-3.7-flash`, `grok-4.6` and the `gpt-5.6` family, all of
which predated it; and it described itself as temperature-0 when the judge
sets no temperature at all (provider default — which is what production runs,
so that is what is measured here).

Configuration: `--context=fixture`, `JUDGE_INCLUDE_BODY=true`, concurrency 1,
3s pacing. **Any run in which an item fell back to the keyword path was
discarded**, not averaged — a fallback verdict measures the fallback, not the
model. 23 of 30 planned runs survived; the sweep also shared an API key with
production and briefly rate-limited it (see klorn-ops `incidents/`), which is
why eval now requires a dedicated key.

| model | runs | correct / 56 | range | urgent / 13 | gate | PUSH→SILENT |
|---|---|---|---|---|---|---|
| `openai/gpt-5.4` | 3 | 56 · 56 · 56 | 100.0 | 13 · 13 · 13 | 3/3 | 0 |
| `google/gemini-3.5-flash` | 3 | 55 · 55 · 55 | 98.2 | 13 · 13 · 13 | 3/3 | 0 |
| `openai/gpt-5.6-terra` | 2 | 55 · 55 | 98.2 | 13 · 13 | 2/2 | 0 |
| `x-ai/grok-4.6` | 1 | 55 | 98.2 | 12 | 1/1 | 0 |
| `google/gemini-3.7-flash` | 3 | 55 · 55 · 54 | 96.4–98.2 | 13 · 13 · 12 | 3/3 | 0 |
| `openai/gpt-5.6-luna` | 2 | 53 · 55 | 94.6–98.2 | 12 · 12 | 2/2 | 0 |
| `google/gemini-2.5-flash` *(default pin)* | 3 | 54 · 54 · 54 | 96.4 | 13 · 13 · 13 | 3/3 | 0 |
| `x-ai/grok-4.3` | 2 | 54 · 54 | 96.4 | 12 · 12 | 2/2 | 0 |
| `anthropic/claude-opus-4.8` | 2 | 50 · 49 | 87.5–89.3 | 9 · 8 | 0/2 | 0 |
| `anthropic/claude-sonnet-5` | 2 | 48 · 45 | 80.4–85.7 | 7 · 5 | 0/2 | 0 |

`grok-4.6` lost two runs to upstream timeouts exceeding 90 minutes each; that
is an availability finding about the provider, recorded here rather than
smoothed over, and it disqualifies the model as a judge pin regardless of its
one clean score.

Findings that survive three runs: (1) the 98.2 cluster is a tie and must be
reported as a tier; (2) gpt-5.4 at 56/56 and both Anthropic models below the
urgent floor are stable, so the ends of the table are real; (3) price still
does not order the table — the $0.20 model reaches the top tier and the $5.00
model never passes; (4) at provider-default temperature 8 of 10 models moved
≤1 email between runs and the two that moved 2–3 are the two failing the gate,
so run-to-run stability is itself a selection criterion for a per-email judge;
(5) safety invariant 1 held in all 23 runs. The sonnet-5 confidence-vs-urgency
mechanism reproduced across runs (urgent 5–7/13) with the same shape.

> ⚠️ The canary sections above describe the judge as temperature-0. It is not — `createCompletion` passes no `temperature`, so the judge runs at each provider's default. The 09-04 measurement shows most models are still stable run-to-run at that default, but the canary's flip-alarm reasoning assumes determinism it does not have. Tracked in #1297.

## Native Anthropic provider (2026-10-30 — Claude 5.5 family, PR #1543)

Measured through the native adapter (`providers/anthropic-native.ts`), Anthropic
as the ONLY provider (a failure would show as INSTRUMENT DEGRADED, never as
another model's score), `--context=fixture`, `JUDGE_INCLUDE_BODY=true`,
concurrency 2. The 5.5 family takes no `temperature`, so run-to-run variance is
part of the result. Local runs plus the PR's report-only `llm-eval-claude` job.

| model / mode | runs | correct / 56 | urgent / 13 | gate | PUSH→SILENT |
|---|---|---|---|---|---|
| `claude-haiku-5-5`, forced JSON tool, **after the schema fix** | 5 | 55 · 54 · 54 · 55 · 52 | 13 · 12 · 13 · 13 · 11 | **4/5** | 0 |
| `claude-haiku-5-5`, forced JSON tool, before the fix | 4 | 51 · 53 · 51 · 50 | 11 · 11 · 11 · 10 | 0/4 | 0 |
| `claude-haiku-5-5`, tool_choice auto (thinking), before the fix | 2 | 48 · 48 | 7 · 7 | 0/2 | 0 |
| `claude-sonnet-5-5` (auto — rejects forced tools), before the fix | 1 | 50 | 9 | 0/1 | 0 |

The fix (commit "stop wrapped JSON-tool answers from scoring every feature 0"):
with an open `{type: "object"}` tool schema the model sometimes wrapped its
answer as `{"input": {…}}` (12 of 55 calls in auto mode) or sent `{}`; the
judge then scored all four features 0 while logging an LLM success. The fix
unwraps a single wrapper key and describes the schema ("keys at the top level").
After it, forced mode returned 48/48 well-shaped answers. The five post-fix runs are 3 local + 2 CI; the one failing run missed the same two items as before the fix (urgency 0.6 on a Friday deadline; confidence 0.6 on a same-day wire) — Haiku passes most runs but is less stable on PUSH than `gemini-2.5-flash` (13/13 on every recorded run). Not isolated: whether
the schema description also moved calibration — the pre-fix forced misses were
the sonnet-5 shape (urgency 0.9, confidence 0.6), not zeroed answers.

Real-mail readout (report-only, 53 items): Haiku 39/53 (73.6%; CI 38/53) vs
`gemini-2.5-flash` 46/53 (86.8%) on the same day; PUSH 3/4 for both; SILENT
precision Haiku 100% (16/16) vs gemini 95.5%. 13 of Haiku's 14 misses are
QUEUE/SILENT predicted as INFO, a lane the v1-labelled real set has no truth
for — Haiku routes noticeably more mail to INFO (13 vs 4).

Measured cost per judge call (Haiku 5.5, forced): ~1,340 input + ~153 output
tokens ≈ $0.0002. The judge's system prompt is under the 512-token cache
minimum, so judge calls are not cached.

## Attention engine v3, phase P1: v2 score prompt vs v3 fact prompt on current models (2026-10-31)

Contract: [`docs/design/attention-engine-v3.md`](../../../docs/design/attention-engine-v3.md) (#1583; founder decisions #1584). Eval only: no product behaviour changes and no production data. Two questions:

- (a) Is the v2 judge calibration-coupled?
- (b) Does a v3 fact prompt narrow the spread between models and raise accuracy?

### Verdict

- **(a) Yes, measured.** The `confidence ≥ 0.70` PUSH bar (`TIER_THRESHOLDS`) costs urgent recall on 3 of the 4 Claude models.
  - `claude-sonnet-5-5` misses 3–4 of 13 urgent gate items per run. Of those misses, 2·2·3 have urgency ≥ 0.70 and fail only the confidence bar.
  - Re-scoring the **same answers** (no new calls) at `confidence ≥ 0.50` moves Sonnet to 12/13 in every run, with 0 false PUSH on the gate set.
  - Haiku and Fable each lose one urgent item to the bar in 1–2 of 3 runs. Opus loses none, but its lowest urgent confidence is exactly 0.70: it sits on the bar.
  - Most of the v2 between-model PUSH spread is this bar: at `confidence ≥ 0.50` it shrinks from 17.9pt to 5.1pt on the same answers.
- **(b) It narrows the spread to ~zero, but lane accuracy falls.** The fall is caused by the policy, not by the facts.
  - Gate set under v3: all four models score 12/13 urgent in every run. PUSH spread is **0.0pt** (v2: 17.9pt); overall spread 1.8pt (v2: 6.0pt).
  - Evidence validity: **358/359 = 99.7%** across all models and runs.
  - Lane accuracy under the doc's §3(4) policy, applied literally, is lower:
    - gate: 83.9–85.7% vs v2 90.5–96.4%;
    - real: 50.9–57.2% vs 60.4–74.8% for a context-matched v2 control (67.3–79.2% when v2 also sees the fixtures' sender facts).
  - On the gate set, Haiku's and Opus's v3 misses are exactly the same 8 items in every run, and the same 8 are missed by Fable and Sonnet too. On top of those, Fable adds one item in every run (eval-016, a "pay" ask read from "invoice available") and Sonnet adds one in a single run.
  - So the facts are model-invariant, and the gap comes from the §3(4) mapping and from label consistency. Each shared miss is listed below.
  - The lane score therefore cannot rank extractors. P2 should judge them on per-field fact labels.

### Setup

| axis | value |
|---|---|
| models | `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-fable-5-1`, native Anthropic adapter, `LLM_PROVIDER_ORDER=anthropic`, no other key set; every call's served model is checked against `--model` |
| v2 | the production judge, unchanged: `judgeEmail(…, modelOverride)` → 4 scores → `tierFromFeaturesV2` → floors |
| v3 | facts schema v1 prompt ([`src/eval-v3/facts-prompt.ts`](../src/eval-v3/facts-prompt.ts)) → evidence + due binding ([`evidence.ts`](../src/eval-v3/evidence.ts), same spec as the P2 extractor) → doc §3(4) policy without budget, importance or ranking ([`policy.ts`](../src/eval-v3/policy.ts)); the deadline window is measured from the mail's Date header |
| shared front | pin → marketing fast-path → sender prior → learned rule, the same order as `judgeEmail` ([`front.ts`](../src/eval-v3/front.ts)). On the gate set (no fixtures) the A/B isolates the LLM stage. On the real set, `--context=fixture` also puts sender facts into v2's prompt (50 of 53 items), which v3 does not use, so a **v2 control with `--context=front`** (prompt context stripped, front kept) was run too |
| sets | gate `judge-eval-set.json` (56, `labelV2`); real `real-eval-set.json` (53, 3-lane labels plus 4 new `labelV2`, see "Relabel" below); `--context=fixture`, `JUDGE_INCLUDE_BODY=true` |
| runs | 3 per cell, one process per run (the v2 judge's in-process prompt cache would otherwise replay run 1), concurrency 2. A run with any provider failure or another served model is discarded; **none were** (60/60 clean: 48 matrix + 12 control) |

Gemini and GPT were **not run**. The only configured routes are OpenRouter, whose CI key returned `402 credits_exhausted` in the Judge Eval run on 2026-10-31 07:04 UTC, and `GEMINI_API_KEY`, which is set nowhere. The OpenRouter catalog (read 2026-10-31) lists `google/gemini-4-argon` (2026-10-13), `google/gemini-3.8-flash`, `openai/gpt-6.1-terra(-pro)` (2026-10-26), `openai/gpt-6.1-sol(-pro)` and `openai/gpt-6-astra(-pro)`. The same command works with `LLM_PROVIDER_ORDER=openrouter OPENROUTER_API_KEY=… --model=google/gemini-4-argon`. That route is untested in this harness.

### Results: per cell (one value per run)

| set | model | prompt | overall | LLM-stage overall | PUSH recall | PUSH prec. | SILENT prec. | MEETING rec. | INFO rec. | PUSH→SILENT | evidence valid | would escalate | $/1k mails | p50 ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| judge-eval-set | `claude-fable-5-1` | v2 | 54·53·54 /56 | 46·45·46 /48 | 12·12·12 /13 | 12·12·12 /12 | 12·12·12 /12 | 4·4·4 /4 | 10·10·10 /10 | 0·0·0 | — | — | $20.10 | 2038 |
| judge-eval-set | `claude-fable-5-1` | v3 | 47·47·47 /56 | 39·39·39 /48 | 12·12·12 /13 | 12·12·12 /12 | 12·12·12 /13 | 4·4·4 /4 | 9·9·9 /10 | 0·0·0 | 100.0% (73/73) | 0·0·0 | $22.32 | 3100 |
| judge-eval-set | `claude-haiku-5-5` | v2 | 53·55·54 /56 | 45·47·46 /48 | 11·13·12 /13 | 11/11·13/13·12/12 | 11·11·11 /11 | 4·4·4 /4 | 10·10·10 /10 | 0·0·0 | — | — | $0.181 | 1069 |
| judge-eval-set | `claude-haiku-5-5` | v3 | 48·48·48 /56 | 40·40·40 /48 | 12·12·12 /13 | 12·12·12 /12 | 12·12·12 /13 | 4·4·4 /4 | 10·10·10 /10 | 0·0·0 | 100.0% (62/62) | 0·0·0 | $0.159 | 1217 |
| judge-eval-set | `claude-opus-5-5` | v2 | 54·54·54 /56 | 46·46·46 /48 | 12·12·12 /13 | 12·12·12 /12 | 12·12·12 /12 | 4·4·4 /4 | 10·10·10 /10 | 0·0·0 | — | — | $7.25 | 2075 |
| judge-eval-set | `claude-opus-5-5` | v3 | 48·48·48 /56 | 40·40·40 /48 | 12·12·12 /13 | 12·12·12 /12 | 12·12·12 /13 | 4·4·4 /4 | 10·10·10 /10 | 0·0·0 | 100.0% (69/69) | 0·0·0 | $7.07 | 2546 |
| judge-eval-set | `claude-sonnet-5-5` | v2 | 51·51·50 /56 | 43·43·42 /48 | 10·10·9 /13 | 10/10·10/10·9/9 | 12·12·12 /12 | 4·4·4 /4 | 10·10·10 /10 | 0·0·0 | — | — | $3.60 | 1884 |
| judge-eval-set | `claude-sonnet-5-5` | v3 | 48·47·48 /56 | 40·39·40 /48 | 12·12·12 /13 | 12·12·12 /12 | 12/13·12/14·12/13 | 4·4·4 /4 | 10·10·10 /10 | 0·0·0 | 100.0% (60/60) | 1·1·1 | $3.26 | 2089 |
| real-eval-set | `claude-fable-5-1` | v2 | 43·42·41 /53 | 30·29·28 /36 | 3·3·3 /4 | 3/3·3/3·3/4 | 21/23·21/22·21/22 | — | 0·0·0 /4 | 0·0·0 | — | — | $20.59 | 2133 |
| real-eval-set | `claude-fable-5-1` | v2 (front ctx) | 39·40·40 /53 | 26·27·27 /36 | 3·3·3 /4 | 3·3·3 /3 | 21·21·21 /23 | — | 0·0·0 /4 | 0·0·0 | — | — | $18.76 | 2297 |
| real-eval-set | `claude-fable-5-1` | v3 | 29·28·29 /53 | 16·15·16 /36 | 3·3·3 /4 | 3·3·3 /4 | 16·16·16 /19 | — | 0·0·0 /4 | 0·0·0 | 100.0% (23/23) | 0·1·0 | $18.62 | 2643 |
| real-eval-set | `claude-haiku-5-5` | v2 | 36·36·35 /53 | 23·23·22 /36 | 3·3·3 /4 | 3·3·3 /3 | 17/17·17/17·16/16 | — | 0·0·0 /4 | 0·0·0 | — | — | $0.191 | 1036 |
| real-eval-set | `claude-haiku-5-5` | v2 (front ctx) | 32·32·32 /53 | 19·19·19 /36 | 3·3·3 /4 | 3·3·3 /3 | 13·13·13 /13 | — | 0·0·0 /4 | 0·0·0 | — | — | $0.182 | 1175 |
| real-eval-set | `claude-haiku-5-5` | v3 | 30·30·31 /53 | 17·17·18 /36 | 3·3·3 /4 | 3·3·3 /4 | 15/18·15/18·16/19 | — | 0·0·0 /4 | 0·0·0 | 100.0% (30/30) | 3·3·3 | $0.157 | 1118 |
| real-eval-set | `claude-opus-5-5` | v2 | 38·39·38 /53 | 25·26·25 /36 | 3·3·3 /4 | 3·3·3 /4 | 21·21·21 /22 | — | 0·0·0 /4 | 0·0·0 | — | — | $7.70 | 2199 |
| real-eval-set | `claude-opus-5-5` | v2 (front ctx) | 38·38·38 /53 | 25·25·25 /36 | 3·3·3 /4 | 3·3·3 /4 | 21·21·21 /23 | — | 0·0·0 /4 | 0·0·0 | — | — | $7.26 | 2358 |
| real-eval-set | `claude-opus-5-5` | v3 | 28·26·27 /53 | 15·13·14 /36 | 3·3·3 /4 | 3·3·3 /4 | 15·15·15 /17 | — | 0·0·0 /4 | 0·0·0 | 100.0% (21/21) | 0·0·0 | $6.25 | 2536 |
| real-eval-set | `claude-sonnet-5-5` | v2 | 38·39·39 /53 | 25·26·26 /36 | 3·3·3 /4 | 3·3·3 /3 | 20/21·21/22·21/22 | — | 0·0·0 /4 | 0·0·0 | — | — | $3.77 | 1910 |
| real-eval-set | `claude-sonnet-5-5` | v2 (front ctx) | 36·37·36 /53 | 23·24·23 /36 | 3·3·3 /4 | 3·3·3 /3 | 18/20·18/19·18/20 | — | 0·0·0 /4 | 0·0·0 | — | — | $3.59 | 1991 |
| real-eval-set | `claude-sonnet-5-5` | v3 | 30·28·29 /53 | 17·15·16 /36 | 3·3·3 /4 | 3·3·3 /4 | 18/20·17/19·17/19 | — | 0·0·0 /4 | 0·0·0 | 95.2% (20/21) | 2·1·1 | $2.99 | 2076 |

Column notes:
- `LLM-stage overall` counts only the items that reached a model: 48/56 on gate and 36/53 on real. The other items go through the deterministic front, which is identical for every cell.
- `$/1k mails` divides each run's measured token cost by every mail in the set, including fast-path items that cost nothing, so it is the per-mail price at this traffic mix.
- `p50 ms` is per LLM call.
- The real-set v2 rows marked `(front ctx)` are the context-matched control.

### Spread across models (mean of 3 runs; overall % / PUSH recall %)

| set | prompt | `claude-fable-5-1` overall / PUSH % | `claude-haiku-5-5` overall / PUSH % | `claude-opus-5-5` overall / PUSH % | `claude-sonnet-5-5` overall / PUSH % | spread overall | spread PUSH |
|---|---|---|---|---|---|---|---|
| judge-eval-set | v2 | 95.8 / 92.3 | 96.4 / 92.3 | 96.4 / 92.3 | 90.5 / 74.4 | 6.0pt | 17.9pt |
| judge-eval-set | v3 | 83.9 / 92.3 | 85.7 / 92.3 | 85.7 / 92.3 | 85.1 / 92.3 | 1.8pt | 0.0pt |
| real-eval-set | v2 | 79.2 / 75.0 | 67.3 / 75.0 | 72.3 / 75.0 | 73.0 / 75.0 | 11.9pt | 0.0pt |
| real-eval-set | v2 (front ctx) | 74.8 / 75.0 | 60.4 / 75.0 | 71.7 / 75.0 | 68.6 / 75.0 | 14.5pt | 0.0pt |
| real-eval-set | v3 | 54.1 / 75.0 | 57.2 / 75.0 | 50.9 / 75.0 | 54.7 / 75.0 | 6.3pt | 0.0pt |

### v2 calibration on urgent items (truth-PUSH)

Columns:
- *misses*: conf-gated (urgency ≥ 0.70, confidence < 0.70) · urgency-low · other, per run.
- *PUSH recall at …*: the shipped rule re-run on the same features with the bar at 0.70 (shipped), 0.50, and ignored.

The re-run reproduces `judgeEmail`'s tier on every LLM-scored item (0 mismatches in all 24 v2 runs).

| set | model | prompt | urgent via LLM | confidence on urgent (min / median / max) | below 0.70 | misses: conf-gated · urgency-low · other | PUSH recall at conf ≥0.70 → ≥0.50 → ignored | false PUSH at same | re-run mismatches |
|---|---|---|---|---|---|---|---|---|---|
| judge-eval-set | `claude-fable-5-1` | v2 | 13/13·13/13·13/13 | 0.60 / 0.85 / 0.90 | 0·1·1 | 0·1·0 / 1·0·0 / 1·0·0 | 12·12·12 /13 → 12·13·13 /13 → 12·13·13 /13 | 0·0·0 → 0·0·0 → 0·0·0 | 0 |
| judge-eval-set | `claude-haiku-5-5` | v2 | 13/13·13/13·13/13 | 0.60 / 0.80 / 0.90 | 2·0·0 | 1·1·0 / 0·0·0 / 0·1·0 | 11·13·12 /13 → 12·13·12 /13 → 12·13·12 /13 | 0·0·0 → 0·0·0 → 0·0·0 | 0 |
| judge-eval-set | `claude-opus-5-5` | v2 | 13/13·13/13·13/13 | 0.70 / 0.85 / 0.85 | 0·0·0 | 0·1·0 / 0·1·0 / 0·1·0 | 12·12·12 /13 → 12·12·12 /13 → 12·12·12 /13 | 0·0·0 → 0·0·0 → 0·0·0 | 0 |
| judge-eval-set | `claude-sonnet-5-5` | v2 | 13/13·13/13·13/13 | 0.60 / 0.75 / 0.85 | 3·3·4 | 2·1·0 / 2·1·0 / 3·1·0 | 10·10·9 /13 → 12·12·12 /13 → 12·12·12 /13 | 0·0·0 → 0·0·0 → 0·0·0 | 0 |
| real-eval-set | `claude-fable-5-1` | v2 | 1/4·1/4·1/4 | 0.70 / 0.75 / 0.75 | 0·0·0 | 0·1·0 / 0·1·0 / 0·1·0 | 3·3·3 /4 → 3·3·3 /4 → 3·3·3 /4 | 0·0·1 → 0·0·1 → 0·0·1 | 0 |
| real-eval-set | `claude-fable-5-1` | v2 (front ctx) | 1/4·1/4·1/4 | 0.60 / 0.60 / 0.70 | 1·0·1 | 0·1·0 / 0·1·0 / 0·1·0 | 3·3·3 /4 → 3·3·3 /4 → 3·3·3 /4 | 0·0·0 → 0·0·0 → 0·0·0 | 0 |
| real-eval-set | `claude-haiku-5-5` | v2 | 1/4·1/4·1/4 | 0.70 / 0.70 / 0.70 | 0·0·0 | 0·1·0 / 0·1·0 / 0·1·0 | 3·3·3 /4 → 3·3·3 /4 → 3·3·3 /4 | 0·0·0 → 0·0·0 → 0·0·0 | 0 |
| real-eval-set | `claude-haiku-5-5` | v2 (front ctx) | 1/4·1/4·1/4 | 0.60 / 0.60 / 0.60 | 1·1·1 | 0·1·0 / 0·1·0 / 0·1·0 | 3·3·3 /4 → 3·3·3 /4 → 3·3·3 /4 | 0·0·0 → 0·0·0 → 0·0·0 | 0 |
| real-eval-set | `claude-opus-5-5` | v2 | 1/4·1/4·1/4 | 0.75 / 0.75 / 0.75 | 0·0·0 | 0·1·0 / 0·1·0 / 0·1·0 | 3·3·3 /4 → 3·3·3 /4 → 3·3·3 /4 | 1·1·1 → 1·1·1 → 1·1·1 | 0 |
| real-eval-set | `claude-opus-5-5` | v2 (front ctx) | 1/4·1/4·1/4 | 0.65 / 0.70 / 0.70 | 1·0·0 | 0·1·0 / 0·1·0 / 0·1·0 | 3·3·3 /4 → 3·3·3 /4 → 3·3·3 /4 | 1·1·1 → 1·1·1 → 1·1·1 | 0 |
| real-eval-set | `claude-sonnet-5-5` | v2 | 1/4·1/4·1/4 | 0.60 / 0.60 / 0.60 | 1·1·1 | 0·1·0 / 0·1·0 / 0·1·0 | 3·3·3 /4 → 3·3·3 /4 → 3·3·3 /4 | 0·0·0 → 1·0·0 → 1·0·0 | 0 |
| real-eval-set | `claude-sonnet-5-5` | v2 (front ctx) | 1/4·1/4·1/4 | 0.50 / 0.55 / 0.60 | 1·1·1 | 0·1·0 / 0·1·0 / 0·1·0 | 3·3·3 /4 → 3·3·3 /4 → 3·3·3 /4 | 0·0·0 → 0·0·0 → 0·0·0 | 0 |

A miss counts as conf-gated only if ignoring confidence would turn it into PUSH. A scheduling-rule MEETING or a floor demotion counts as "other".

On the real set only 1 of 4 urgent items reaches the LLM. The other three are the founder's `OVERRIDE:PUSH` senders, which short-circuit, so the real set cannot show the bar effect. Moving the bar there adds 0–1 false PUSH. The fixtures' sender facts also lift v2's confidence: on that urgent item, Sonnet scores 0.60 with them and 0.50–0.60 without.

### Where v3 loses: every miss shared by all models in all runs

Gate set (8 items; v3 lane ≠ label for all 4 models × 3 runs):

| item | label | v3 lane [rule] | cause |
|---|---|---|---|
| eval-018 Render "Payment processed for June" | QUEUE | INFO [info] | **label consistency**: eval-016/027/054 (invoice available, AWS bill, invoice paid) are labelled INFO |
| eval-031 Hana Bank "Statement ready" | QUEUE | INFO [info] | label consistency, same as above |
| eval-047 Notion "Receipt: subscription renewed" ("No action needed") | QUEUE | INFO [info] | label is a v1 AUTO→QUEUE fold; the ontology says receipts are INFO |
| eval-048 "Accepted: Roadmap sync" | QUEUE | INFO / MEETING | v1 AUTO→QUEUE fold |
| eval-030 OpenAI DevRel "API changelog" | QUEUE | SILENT [silent] | **policy**: §3(4) SILENTs newsletters; the locked ontology keeps SILENT for clear marketing only |
| eval-017 Linear "Issue assigned to you" | QUEUE | INFO [info] | **prompt definition**: no model treats a system-relayed assignment as an ask |
| eval-032 Notion "Jamie left 3 comments" | QUEUE | INFO [info] | prompt definition, as above |
| eval-036 Growth Fund "DD docs due Friday" | PUSH | QUEUE [queue:ask] | **policy**: the due date was extracted correctly (Fri 23:59), but it is 4 days out and PUSH needs due ≤ 24h |

On the real set, v3's shared misses repeat these shapes:
- automated notices without an ask go to INFO where the 3-lane label says QUEUE: 5 Vercel "Failed deployment" alerts, the Namecheap order receipt, "Thanks for applying", the EVE config test;
- the doc's INFO-before-SILENT order sends 2 LinkedIn notifications to INFO;
- the newsletter rule SILENTs the Reddit digest. v3 SILENT precision on real is 83.3–90.0%, **below the 90% floor in 11 of 12 runs**, while v2 holds 91.3–100%;
- one confirmation-code mail whose body says "Sign-in from unauthorized device detected — please verify" becomes `push:risk`. All 4 models extracted `security_alert` from that sentence; the founder's QUEUE label rests on context the mail does not carry.

Three non-v3 effects on the real set:
- **The context confound is real but small.** Stripping sender facts from v2's prompt costs v2 0.6–6.9pt (Haiku 67.3→60.4, Sonnet 73.0→68.6, Fable 79.2→74.8, Opus 72.3→71.7). Against that control, v3 still trails by 3–21pt.
- The 4 relabelled Google sign-in alerts are decided by a **sender-history prior** (10 past QUEUE classifications, i.e. v2's own output) before any model runs, so every cell misses them under the new label (+4/53 to every cell under the stale labels). Under v3 those priors would pin v2's past decisions onto the new policy.
- 98bf199e ("ㅎㅇ" from the founder's own alias, labelled PUSH) is missed by every model under both prompts; nothing in the mail can recover it.

Escalation triggers (doc §4) seen under v3: 0–1 per gate run and 0–3 per real run, from `ambiguous` (Haiku 3 per real run, Sonnet 1) and one dropped evidence quote (Sonnet, real). Unbound dues: 0 after replay under the final token list. Before "end of day" was added, one real PUSH (eval-039) was lost to the binding.

### Cost and latency (measured tokens, list prices in `model-fallback.ts`)

| model | v2 $/1k mails | v3 $/1k mails | v2 p50 | v3 p50 |
|---|---|---|---|---|
| `claude-haiku-5-5` | 0.18–0.19 | 0.16 | 1.0–1.1 s | 1.1–1.2 s |
| `claude-sonnet-5-5` | 3.6–3.8 | 3.0–3.3 | 1.9 s | 2.1 s |
| `claude-opus-5-5` | 7.3–7.7 | 6.3–7.1 | 2.1–2.2 s | 2.5 s |
| `claude-fable-5-1` | 20.1–20.6 | 18.6–22.3 | 2.0–2.1 s | 2.6–3.1 s |

v3 sends a ~2.9k-token prompt against v2's ~1.3k. The v3 system prompt is fixed, so Anthropic caching serves ~2.4k of it as cache reads (Haiku), which keeps v3 at or below v2's cost. The v2 judge prompt is under the cache minimum.

### Relabel of the real set (5 lanes)

Protocol, following the founder's #1584 rule for real-mail labels:
- Two frontier models labelled independently: this session's `claude-opus-5-5` (A, recorded first) and a blind `claude-fable-5-1` subagent (B).
- The rule both applied: keep the founder's label unless the 5-lane split clearly re-homes the mail into INFO or MEETING, with a non-conflicting founder precedent from the gate set's `labelV2`.
- Only agreements were applied, as `labelV2`. `label` is unchanged, and `--verify` passes.

| item | label → labelV2 | precedent |
|---|---|---|
| 22273cda, d63feb18, a8ca544a, b31d9b6b — Google "보안 알림" (new sign-in, "본인이 맞다면 조치 불필요") | QUEUE → INFO | eval-015 "Security alert: new sign-in" → INFO |

For founder review, kept at the founder's label:
- **5 EVE waitlist signups.** A proposed INFO per eval-026. B flagged the conflict with the founder's own `OVERRIDE:PUSH` on Klorn waitlist mail in the same set, and that conflict is right.
- **EVE config test.** Only B proposed INFO.
- **Unsure for both labelers:**
  - 5 Vercel failed deployments;
  - 2 GitHub verify-email;
  - the Namecheap confirmation code;
  - the Namecheap order receipt;
  - "Thanks for applying to Google".

The gate set was not relabelled. It is the CI gate and the founder's labels. Its receipt inconsistency (eval-018/031/047 vs eval-016/027/054) is the founder's call.

### Conclusion: what P2 and P3 should adopt

**P2 (fact extractor):**
- Adopt schema v1 as written. No lane decision needed a field it lacks, and evidence validity was 99.7%.
- Adopt the relative-date table and due binding. Both are in P2's doc PR; the token list must include spelled-out deadlines ("end of day", "close of business"), or real PUSH items are lost.
- Add one prompt sentence so that work a system assigns or relays to the recipient (issue assigned, review requested, comments on your doc) counts as an ask.
- Score extractors per field on the P2 fact labels. The lane score above measures the §3(4) mapping, which ranks every model the same.

**P3 (policy):** do not ship §3(4) literally. Replay it (`scripts/v3-bench-report.ts` re-scores stored facts with no LLM calls) until it matches the labels. Five fixes:
1. Keep SILENT narrow: promotions only, never newsletters or other bulk mail without a marketing kind.
2. Put SILENT-shaped social notifications ahead of INFO.
3. Decide whether automated *failure* alerts are INFO.
4. Decide what a 2–7-day investor deadline is.
5. Drop or recompute sender-history priors, which are v2 outputs, under v3.

**Models (doc §4), for P2/P4 to confirm on the fact eval:**
- **Primary: `claude-haiku-5-5`.**
  - Under v3 it matches every frontier model on every urgent item: 12/13 in all runs, the same items.
  - Its v3 gate score is 48/56 vs 47–48 for the frontier models; LLM-stage 40/48 vs 39–40.
  - It costs $0.16 per 1k mails at p50 1.2 s.
- **Escalation: `claude-opus-5-5`.**
  - `claude-fable-5-1` showed no stable advantage at ~2.9× Opus's price. Its real-set v2 lead (41–43 vs 38–39 /53) comes from contested QUEUE/INFO items and one Opus false PUSH; only 2 differing items repeat across all 3 runs.
  - The founder's "accuracy first" decision allows Fable. These sets cannot separate the two, so P4 should decide on the fact eval of the founder's own mail.
  - Escalation triggers fired on 0–6% of mail here. Under §4, PUSH candidates will be the main escalation volume.

### Reproduce

From `packages/api`:
- Env: the eval.yml env, Anthropic only.
- Each cell takes about 1–3 minutes.
- The bench refuses to run unless `LLM_USAGE_LOG_DISABLED=true`, `GLOBAL_DAILY_COST_CAP_CENTS=0` and a localhost `DATABASE_URL` are set.

```bash
export LLM_PROVIDER_ORDER=anthropic JUDGE_INCLUDE_BODY=true GLOBAL_DAILY_COST_CAP_CENTS=0 \
  LLM_USAGE_LOG_DISABLED=true DATABASE_URL=postgresql://eval:eval@localhost:5432/eval   # + ANTHROPIC_API_KEY
for set in judge-eval-set real-eval-set; do
  for model in claude-haiku-5-5 claude-sonnet-5-5 claude-opus-5-5 claude-fable-5-1; do
    for run in 1 2 3; do
      for prompt in v2 v3; do
        npx tsx scripts/v3-bench.ts --in=eval/$set.json --model=$model --prompt=$prompt \
          --run=$run --concurrency=2 --delay=300 --out=/tmp/p1/runs/$set.$model.$prompt.$run.json
      done
    done
  done
done
# context-matched v2 control on the real set (v2's prompt loses the sender facts v3 never sees)
for model in claude-haiku-5-5 claude-sonnet-5-5 claude-opus-5-5 claude-fable-5-1; do
  for run in 1 2 3; do
    npx tsx scripts/v3-bench.ts --in=eval/real-eval-set.json --model=$model --prompt=v2 --context=front \
      --run=$run --concurrency=2 --delay=300 --out=/tmp/p1/runs/real-eval-set.$model.v2-front.$run.json
  done
done
npx tsx scripts/v3-bench-report.ts --dir=/tmp/p1/runs --out=/tmp/p1/report.md
```

Exit 3 means instrument degraded: a provider failure, or a call served by another model. The file is still written, the report skips it, and you retry the run. The report re-scores every stored run against the labels in the eval file and replays v3 from the stored raw facts. A relabel or a policy change therefore costs no LLM calls.

### Spend

- Measured, at the list prices in `model-fallback.ts` from token counts: **$25.73**.
  - 60 runs (48 matrix + 12 control): $25.11 (Fable $16.38, Opus $5.79, Sonnet $2.80, Haiku $0.14).
  - 2 runs on an earlier prompt draft: $0.19.
  - Smoke runs: $0.43.
- Unmeasured: up to ~$1.8 from 4 runs stopped mid-flight when the prompt changed. Their output was never written.
- Total: **≤ $28** of the $100/month credit.
