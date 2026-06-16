# Sub-project A — Two latent bugs (vision ledger priority + calendar timezone)

**Date:** 2026-06-16
**Status:** Design approved, pre-implementation
**Parent:** Refactoring/hardening campaign (sub-project A of 6). B (type-debt) and D
(email-sync split) are already in flight on a parallel branch; A is independent of both.

## Context

A refactoring analysis of the Klorn engine surfaced two real bugs (not just smells),
each confirmed against current code. They are small, independent, and carry no
dependency on the larger structural work. This sub-project fixes both behind
regression tests, with minimal scope.

## Bug 1 — Vision call billed to the wrong cost bucket

`createVisionCompletion` gates the per-user call against the **background** bucket
but records the usage ledger as **foreground** when no explicit priority is passed:

- `packages/api/src/openai.ts:392` — `checkAndRecordUserCall(userId, { priority: options.priority ?? "background" })`
- `packages/api/src/openai.ts:422` — `recordLlmUsage({ ..., source: options.priority ?? "foreground" })`

The function comment (openai.ts:389–390) states vision is a worker-triggered batch and
must charge the background bucket so it can never starve foreground chat. The ledger
default contradicts that intent.

**Fix:** change the `recordLlmUsage` default at line 422 from `"foreground"` to
`"background"` so the gate and the ledger agree. When a caller passes an explicit
`options.priority`, both already use it — only the default diverges.

**Out of scope (deferred to sub-project B):** the no-op ternary at openai.ts:408–411
(both branches identical) is dead code, not a bug. Not touched here.

## Bug 2 — Calendar events written with a naive timezone on first login

The Gmail/Calendar `init-sync` route parses Google event times with a naive
`new Date(startTime)`, while the 60-second scheduler parses the same data with a
timezone-aware helper. First-login writes therefore disagree with every subsequent
scheduler write by the user's UTC offset.

- Naive: `packages/api/src/routes/auth.ts:1123,1133` — `new Date(startTime)` / `new Date(endTime)`
- Canonical: `packages/api/src/automation-scheduler.ts:417,449–453` —
  `const userTimezone = normalizeTimeZone(userRow?.timezone)`, then
  `parseGoogleDateTime(startTime, item.start?.timeZone ?? null, userTimezone)` with an
  `isTimed` (all-day) branch.

The canonical timezone source is `user.timezone` passed through `normalizeTimeZone`
(which supplies the default when the column is null) — **not** `automationConfig`.
The `init-sync` handler (routes/auth.ts:1058) only has `userId` in scope; it does **not**
load the `user` row, so the fix adds a single `select: { timezone: true }` fetch (init-sync
is a low-frequency login-bootstrap call, so one extra query is fine).

**Approach — A1 (minimal in-place fix, chosen):**
1. In the `init-sync` handler, fetch the timezone once
   (`prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } })`)
   and derive `userTimezone = normalizeTimeZone(userRow?.timezone)`, exactly as the
   scheduler does (import `normalizeTimeZone` from `./time-zone.js`).
2. Replace the two `new Date(startTime)` / `new Date(endTime)` upsert fields with the
   exact `isTimed ? parseGoogleDateTime(..., userTimezone) : new Date(...)` logic the
   scheduler uses, for both the `create` and `update` branches.

**Rejected — A2 (extract shared `calendar-sync.ts` now):** correct long-term, but pulls
sub-project D's deduplication into A and turns a zero-risk bug fix into a mid-risk
structural change. The duplication is accepted here on purpose; **D removes it later**
by extracting `syncUserCalendar(userId, auth, windowDays)` that both callers share.

## Testing (TDD — write the failing test first)

- **Bug 1:** unit test on `createVisionCompletion` (or the ledger call) asserting that
  with `options.priority` undefined, `recordLlmUsage` receives `source: "background"`.
  Mock the provider + `recordLlmUsage`.
- **Bug 2:** unit-level test that the `init-sync` calendar mapping applies
  `parseGoogleDateTime` for timed events (a `dateTime` with a non-UTC `timeZone`
  produces the same instant as the scheduler), rather than `new Date(rawString)`.
  If a full googleapis mock proves heavy, extract the per-item mapping into a small
  pure function and test that directly (this also pre-stages D's extraction cleanly).

## PR structure

One PR, two commits:
1. `fix: bill vision ledger to the background bucket (was foreground)`
2. `fix: parse calendar times with the user timezone in init-sync`

## Acceptance criteria

- Vision calls with no explicit priority gate **and** record against `background`.
- `init-sync` calendar writes produce the same `startTime`/`endTime` instants as the
  scheduler for the same event.
- Both behaviors are covered by a regression test that fails before the fix.
- No change to the scheduler, no calendar-sync extraction, no envelope/no-op cleanups
  (those belong to D / B / F).

## Coordination note

Sub-projects B (type-debt) and D (email-sync split, "M3 step N/6") are being executed
in parallel on another branch. A touches only `openai.ts` and `routes/auth.ts`, which
those commits do not modify — no conflict expected. Rebase A onto `main` before opening
its PR so the agent-guide and in-flight refactor commits do not leak into A's diff.
