# Sub-project C — Error-handling observability discipline

**Date:** 2026-06-16
**Status:** Design — pre-implementation
**Parent:** Refactoring/hardening campaign (sub-project C of 6). A (vision/calendar
bugs), B (type-debt = typed `db`), and D (email-sync split) already landed on `main`.
C is independent of E (multi-dyno) and F (dead-code).

## Context

The grounded re-review flagged a recurring failure mode: errors swallowed with no
signal, so a persistent failure is invisible in prod. The worst offenders were
fixed during the campaign (per-email persist isolation, `summarizeEmail` swallow,
`createVisionCompletion` masking, unawaited push rejections). What remains is **not
a large sweep** — an exact-empty `catch {}` count on `main` is now 1 — but the
codebase has no *guardrail* preventing the pattern from coming back, and a few
silent-swallow sites still merit a one-line `captureError`.

C is therefore two things: a lint guardrail (prevent regression) + a small,
evidence-led triage of the remaining swallows. It is explicitly **not** a
mechanical "add captureError to every catch" sweep — many catches are intentional
(e.g. the decompression offset-scan "most offsets are not deflate streams", JSON
parse fallbacks). Blindly logging those would flood Sentry.

## Scope

### C1 — Lint guardrail (prevent regression)
Add a biome rule so a *silent, empty* catch can't merge again:
- Enable `correctness/noEmptyBlockStatements` (or the catch-specific equivalent)
  at **warn** first, then ratchet to error once the tree is clean.
- An intentional empty catch must carry an explanatory comment (biome's rule
  treats a comment-only block as non-empty), forcing the author to state *why*
  the error is safe to drop. This is the real win: every silent swallow becomes a
  conscious, documented decision.

### C2 — Triage the remaining swallows (evidence-led, NOT mechanical)
Enumerate every `catch` in `packages/api/src` that drops the error without
`captureError`/`console.warn`, and classify each as:
- **Intentional** (expected non-error control flow — scan probes, optional
  parses): leave it, add a one-line comment if missing.
- **Real swallow** (a genuine failure that should be observable): add
  `captureError(err, { tags: { scope: ... }, extra: ... })`.

Only the "real swallow" set is changed. The reviewer must *justify each
classification in the PR description* — no blanket edits.

### C3 — Tier-decision authority (stretch, optional)
The push-tier decision authority is fragmented across `poc-judge` →
`notification-policy` → `push.ts` → `automation-scheduler`. The campaign already
fixed the worst symptom (`authoredSurface` so a judge=PUSH email bypasses the
noise heuristic). C3 would consolidate the "is this allowed to interrupt"
decision into a single function the bell/push/telegram paths all call, so the
decision can't drift again. Defer if C1+C2 already fills the PR.

## Testing
- C1: CI runs biome; the rule change is self-testing (the build stays green only
  if every empty catch is commented).
- C2: each newly-instrumented swallow gets a unit test that forces the failure
  path and asserts `captureError` was called (mock Sentry), mirroring the
  `email.summarize` and per-email-isolation tests already in the suite.

## PR structure
One PR:
1. `chore(lint): require a comment on every empty catch (no silent swallows)`
2. `fix(observability): capture <N> previously-swallowed errors` (only the real ones)

## Acceptance criteria
- biome fails on a new, undocumented empty `catch {}`.
- Every remaining silent swallow in `packages/api/src` is either commented as
  intentional or instrumented with `captureError`, justified per-site in the PR.
- No Sentry-noise regressions (intentional scan/parse catches stay silent).

## Coordination note
C touches scattered `.ts` files + `biome.json`. It does not move modules (D) or
change deploy topology (E). Rebase onto `main` before the PR. If a touched file is
security-sensitive (auth/gmail/push/token/prisma), the pre-merge hook will require
a security-reviewer pass + `KLORN_SKIP_SEC_REVIEW=1`.
