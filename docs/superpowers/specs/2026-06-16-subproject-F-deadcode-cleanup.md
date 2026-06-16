# Sub-project F — Dead-code, no-op, and low-risk cleanup sweep

**Date:** 2026-06-16
**Status:** Design — pre-implementation
**Parent:** Refactoring/hardening campaign (sub-project F of 6). Referenced by the
A spec as the home for "envelope/no-op cleanups." Independent of C and E.

## Context

A grab-bag of confirmed-real, low-risk, zero-behavior-change cleanups the other
sub-projects deliberately deferred so they could stay tightly scoped. Each is
verified against `main`. F is the place they land together, behind tests where the
change is observable.

## Scope (all confirmed on `main`)

### F1 — No-op ternary in `createVisionCompletion`
`packages/api/src/openai.ts` (~line 408) — `provider.name === "gemini" ?
provider.resolveModel(visionModel) : provider.resolveModel(visionModel)` — both
branches are identical. Collapse to `provider.resolveModel(visionModel)`. (The A
spec explicitly deferred this here.)

### F2 — Dead auto-reply paths carrying a live `sendEmail`
`packages/api/src/routes/email.ts` — `checkAndExecuteAutoReply` (~1156) and
`autoAddContacts` (~247) are unreferenced from any route but still call
`sendEmail` with no rate-limit. Confirm no caller (grep), then delete. Removing a
live, unguarded send path is a safety win, not just tidiness.

### F3 — `crypto-tokens` legacy-plaintext cutoff (handle with care)
`crypto-tokens.ts:35-39` — `decryptToken` silently returns non-`v1:` values as
plaintext. If `TOKEN_ENCRYPTION_KEY` is ever cleared, plaintext OAuth tokens are
read with no signal.
**Approach (must not break real legacy tokens):**
1. First, *measure*: add a `captureError`/`console.warn` (one-time per token) when
   a non-`v1:` value is read in production, so we learn whether any legacy
   plaintext tokens still exist in prod.
2. Only after that signal is clean (no legacy reads for N days) add a hard
   cutoff: in production, a non-`v1:` value throws rather than silently passing
   plaintext through. Do **not** ship the hard cutoff blind — it would break any
   user still on a pre-encryption token.

### F4 — Redundant indexes
`prisma/schema.prisma` — drop three indexes fully covered by an existing unique:
`Skill @@index([userId])` (covered by `@@unique([userId, key])`),
`ContactTrustScore @@index([userId])` (covered by `@@unique([userId, contactEmail])`),
`LlmCostLedger @@index([userId, dayKey])` (duplicate of `@@unique([userId, dayKey])`).
One migration with `DROP INDEX`. Negligible perf gain — do it for schema hygiene,
not urgency.

### F5 — Dead `wrapUntrusted` import
`tool-executor.ts:39` imports `wrapUntrusted` but never calls it (orphaned when
#433 deleted the notion/imessage/news integrations). Each tool module already
wraps its own untrusted output, so this is purely a dead import — delete it (or,
if executor-layer defense-in-depth is wanted, that's a separate enhancement, not
F).

### F6 — Timestamptz migration (optional, larger)
104 `DateTime` columns are `timestamp without time zone`. Converting to
`@db.Timestamptz` is correct long-term but is a real data migration touching every
table. **Recommend splitting out** — it does not fit the "low-risk grab-bag"
theme. Keep F to F1–F5; track F6 separately and pair it with E (scaling), since
timezone correctness matters most when load/region grows.

## Testing
- F1, F5: covered by tsc/biome (no behavior change); no new test needed.
- F2: assert (test or grep in PR) that the deleted functions had no callers.
- F3: unit-test the measurement path (non-`v1:` read triggers captureError);
  later, the cutoff path (prod throws on non-`v1:`).
- F4: migration applies cleanly; existing query tests stay green.

## PR structure
One PR for F1/F2/F4/F5 (pure cleanup). F3 as its **own** PR (it carries a behavior
change + needs the measure-then-cut sequencing). F6 separate if pursued.

## Acceptance criteria
- No-op ternary gone; dead auto-reply/import removed (no callers); redundant
  indexes dropped.
- `crypto-tokens` non-`v1:` reads are observable in prod before any hard cutoff.
- Zero behavior change for F1/F2/F4/F5; full suite + build green.

## Coordination note
F3 touches `crypto-tokens.ts` (token = security-sensitive) → the pre-merge hook
will require a security-reviewer pass + `KLORN_SKIP_SEC_REVIEW=1`. F1/F2/F5 touch
non-sensitive files. Rebase onto `main` before each PR.
