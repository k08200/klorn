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

## Planned: repoint the canary at real mail

`judge-canary.yml` runs the **synthetic** set, so a green canary proves
"the model didn't silently drift", NOT "the thesis holds on real mail". The
launch GO/NO-GO bar (POC.md) is ≥80% on the founder's real 50 — and that
number has never been the thing CI measures.

The repoint is one line once the data exists:

```diff
- run: ... poc-accuracy.ts --in=eval/judge-eval-set.json ...
+ run: ... poc-accuracy.ts --in=eval/real-eval-set.json ...
```

**The blocker is the data, not the wiring** — and it is deliberately a manual,
human-reviewed step, not automation:

1. `eval/real-eval-set.json` must be a PII-scrubbed extract of the private
   `poc-ground-truth.json` (same schema), scrubbed per the "Adding cases" rules
   above: fictional sender/domain, no real names or addresses, structural
   signal preserved.
2. Because this repo is **public**, every row must be eyeballed by the founder
   before commit. An auto-scrubber must not commit real mail to a public repo —
   one missed address is an irreversible leak. There is intentionally no script
   here that does this for you.
3. Once committed and reviewed, flip the `--in=` above. Then "green canary" and
   "thesis proven on real mail" become the **same auditable event** — the whole
   point of the gate.

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
