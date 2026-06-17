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

## Planned: repoint the canary at real mail

Today `judge-canary.yml` runs the **synthetic** set, so a green canary proves
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
