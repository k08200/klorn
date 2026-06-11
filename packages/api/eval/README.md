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
