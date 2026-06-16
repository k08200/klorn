# Refactoring/hardening campaign — map (A–F)

**Date:** 2026-06-16

Six sub-projects from the grounded re-review of the Klorn engine. Each is
independent and separately shippable.

| | Sub-project | What | Status |
|---|---|---|---|
| **A** | Latent bugs (vision ledger + calendar TZ) | 2 confirmed bugs, fixed behind tests | ✅ on `main` |
| **B** | Type-debt | Kill the `prisma as any` `db` shim → typed re-export; fix the 8 latent type errors it hid | ✅ on `main` |
| **C** | Error observability discipline | Lint guard against silent empty catches + evidence-led triage of remaining swallows | 📋 designed (`subproject-C`) |
| **D** | email-sync split | Decompose the 1487-line god-file into 7 focused modules behind a back-compat barrel | ✅ on `main` |
| **E** | Multi-dyno safety | Advisory-lock pgbouncer-safety, in-process dedup → shared store, reconcile bounding | 📋 designed (`subproject-E`) — **gated on scaling** |
| **F** | Dead-code / cleanup | No-op ternary, dead auto-reply paths, crypto-tokens cutoff, redundant indexes, dead imports | 📋 designed (`subproject-F`) |

Also shipped alongside the campaign (from the grounded review, not numbered):
auth session-revocation, inbox-search 500, push noise-collision, multi-urgent
dedup, attachment decompression bomb, IMAP SSRF allowlist, OIDC audience
fail-closed, timing-safe push token, web false-success toasts, GitHub PUSH
delivery, Naver resurrection, `ws` DoS bump, and the reliability cluster
(per-email isolation, summarize/vision observability, guarded pushes).

**Remaining executable now:** C (small), F1/F2/F4/F5 (cleanup). **Gated:** E (scale),
F3 (measure-then-cut), F6 (timestamptz). All HIGH severities from the review are
shipped.
