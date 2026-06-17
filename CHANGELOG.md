# Changelog

All notable changes to Klorn are recorded here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Klorn is pre-1.0 — the public API can break between minor versions. The
`v1.0.0` threshold is gated on POC retention (3/5 ICP sustaining use through
the Day 14+7 measurement window) plus the cost-gate gap closure, not on
calendar time.

## [Unreleased]

### Added — Engine sprint (PR #500)
- **Judge eval gate.** Synthetic, PII-free 50-email eval set
  (`packages/api/eval/`) with two enforcement layers: a deterministic CI
  gate (fast-path + keyword fallback, 70% accuracy ratchet plus two safety
  invariants — a missed PUSH degrades to QUEUE, never SILENT; SILENT
  marketing is never predicted PUSH) and an LLM end-to-end workflow
  (≥80%, runs on PRs touching judge files when a provider secret exists).
- **Correction loop.** Manual tier overrides now feed back into
  classification: up to 5 few-shot examples (same-sender → same-domain →
  recency) injected into the judge prompt, plus a sender prior that skips
  the LLM for stable senders (≥2 identical overrides in 60 days, or ≥3
  unanimous recent classifications for QUEUE). Urgent-looking
  content always routes back to the LLM unless the prior itself is PUSH.
  A prior never resolves to SILENT without the LLM — see Fixed below.
- **Quiet hours enforcement.** Extracted into `quiet-hours.ts` with its own
  `quiet_hours` skip reason (previously conflated with category opt-outs),
  midnight-crossing windows and timezones tested.
- **Telegram delivery adapter.** BYO BotFather token, one-time link codes,
  secret-verified webhook, PUSH interrupts mirrored with Move-to-Queue /
  Silence inline buttons that feed override ground truth. Works without
  VAPID keys.
- **Phone escalation v0.** One plain Twilio TTS call when a PUSH
  notification stays unacknowledged for 5 minutes. Rails: one call per
  notification ever (DB-unique), daily cap of 3, 10-minute cooldown, quiet
  hours always win, per-user opt-in on top of a global flag, Twilio
  signature verification. A delivery channel for PUSH — not a new tier.
- **Local/OpenAI-compatible LLM provider.** `OPENAI_COMPAT_BASE_URL`
  (Ollama, LM Studio, vLLM) routes classification local-first with cloud
  as failover only; fully local when no cloud keys are set. Env-only by
  design (no per-user URLs — SSRF surface).
- **LLM usage ledger.** `LlmUsageLog` records the actual post-failover
  provider, model, and token counts per call; founder-facing summary at
  `GET /api/admin/llm-usage`.
- **Reject-with-feedback.** Rejections persist an optional reason; the
  last five feed the agent prompt so repeated bad proposals stop.

### Added — Web wiring (PR #501)
- Settings: Telegram connect card (deep link + one-time code + disconnect)
  and a phone-escalation opt-in toggle with the rails spelled out.
- Inbox + notification bell: reject now opens an optional-reason dialog
  (500-char max); skipping the reason keeps the old behavior.

### Fixed
- **Cost gate charged 0¢ per call** (PR #500). The pre-bill estimated
  `estimateModelCostUsd(model, 0, 0)`, which is token-linear and therefore
  always zero — daily caps never accumulated for paid models. Pre-bill now
  uses a nominal-token floor and settles against actual usage after each
  call (the cost-gate gap named in the v1.0.0 threshold above).
- Keyword fallback could never SILENT a newsletter during an LLM outage —
  marketing features sat exactly on the SILENT branch's strict floors
  (PR #500).
- Unit tests silently hit the live LLM provider on machines with a local
  `.env` (Prisma's env autoload ran before provider-registry init); the
  suite is offline again (PR #500).
- `getProviderChain()` registered the env API key twice under separate
  quota keys, duplicating attempts and bypassing cooldowns (PR #500).
- **A learned sender prior could mute a sender with no LLM look.** A prior
  (≥2 overrides, or ≥3 unanimous history) that resolved to SILENT
  short-circuited the judge and produced no AttentionItem — so a stale or
  wrong prior muted real mail invisibly, and the user never saw the message
  to correct the prior (a silent one-way door, structurally invisible
  over-suppression). SILENT is now excluded from both prior allowlists: a
  would-be-SILENT sender falls through to the LLM on every email (which can
  still decide SILENT, with full content and urgency in view). The
  deterministic marketing fast-path remains the only no-LLM route to SILENT.
- **Scope-budget CI gate never failed.** The `check` helper set `fail=1`
  inside a `check | tee` pipeline, so it ran in a subshell and the flag
  never reached the job shell — the gate always exited 0 (green) even when a
  surface was over budget, so the anti-relapse lock was never actually
  enforcing. `check` now returns non-zero and an `emit` wrapper sets `fail`
  in the current shell (no pipe), so an over-budget surface turns the job red
  as intended (all three axes still report).
- **Proactive agent loop gated on explicit opt-in.** The scheduler skipped
  only on a strictly `false` flag (`=== false`, opt-out); it now runs only
  when the flag is explicitly `true` (`!== true`), matching the classify-only
  default — an absent/null flag means OFF. Runtime behavior is unchanged today
  (the column is a non-nullable Boolean) but the gate stays correct if the
  flag is ever missing.

## [0.3.0] — 2026-06-09

First release after the firewall doctrine work and the production incident
recovery. Brings versioning back into lockstep across `@klorn/api`,
`@klorn/web`, and `@klorn/core`, all on `0.3.0`.

### Added — Attention Firewall doctrine
- **PR #468** — Content-hash binding on every `AttentionItem`. The classifier
  bytes (from, subject, snippet, labels) are hashed at decision time and
  re-verified at read time, so any post-decision mutation surfaces as
  `AttentionHashMismatchError` instead of silently being trusted.
- **PR #472** — Read-path integration for the hash. Stale tiers are flagged
  via a `hashStale` field, captured to Sentry, and surfaced to the firewall
  view.
- **PR #480** — Deterministic-floor doctrine. `FLOOR_ACTIONS` const +
  `ActionReceipt` schema + sha256 payload-hash helpers for every action whose
  effect cannot be undone with a single user click. Doctrine documented at
  [`docs/doctrine/deterministic-floor.md`](docs/doctrine/deterministic-floor.md).
- **PR #481** — Floor enforcement. `send_email` now throws
  `FloorReceiptRequiredError` without a verified receipt and
  `ActionReceiptMismatchError` if the bytes mutated between approve and
  execute. Receipt is minted at `/approve` time and stored on the
  `PendingAction` row.

### Added — Calendar
- **PR #476** — `formatTime` reads the user's stored IANA timezone instead of
  the browser default; 24-hour rendering throughout.
- **PR #477** — Compact agenda-style layout with inline delete per event.
- **PR #479** — Google-Calendar-style month grid view.
- **PR #482** — `createEvent` returns canonical times from Google's response;
  `tool-executor` writes those (not the raw LLM input). Eliminates the +13h
  shift seen in 2026-06-04 dogfood.

### Added — POC measurement infra
- **PR #470** — Calibration CLI (`pnpm --filter @klorn/api calibration`) for
  Day 14+7 retention measurement. Reads `AttentionItem` rows + `FeedbackEvent`
  overrides and emits per-tier confidence stats, override rate, ground-truth
  accuracy, and a drift signal. No LLM calls; safe to schedule.

### Added — Cron + provider hygiene
- **PR #467** — External cron entrypoint (`/api/cron/briefing-tick`) with
  timing-safe `BRIEFING_CRON_SECRET` so Render Free dynos can be woken by
  cron-job.org without violating Render's keepalive policy.
- **PR #471** — Vision-model default ends in `:free`; startup warns loud when
  any of `CHAT_MODEL` / `AGENT_MODEL` / `VISION_MODEL` is set to a
  vendor-prefixed paid ID.
- **PR #485 / PR #486** — Failover walks the free-model chain on OpenRouter
  before giving up the provider.

### Fixed
- **PR #466** — Guard `invalidateGoogleToken` against non-prod env writes
  after a script run wiped the founder's prod token row.
- **PR #487** — Emergency `BACKGROUND_AGENTS_DISABLED` kill switch +
  removed duplicate `preDeployCommand` that doubled the Render deploy hang
  window. Shipped during the 2026-06-05 Google Cloud billing incident.

### Changed
- `/api/health` now reports `version` from `packages/api/package.json` so
  operators can identify which release a container is running without
  decoding the commit hash.

### Known follow-ups (tracked, not in this release)
- Cost-gate gap for system calls (`createCompletion` callers that omit
  `userId`) — the 2026-06-05 incident root cause. Tracked separately.
- Issue #488 — read-refusal class as anti-surveillance gate. Marker only
  until the first triggering tool ships.

## Older history

Pre-0.3.0 history is captured in git tags `v0.1.4` … `v0.2.1` and in the
merged PR list. Versioning fell out of sync with `package.json` files during
the 2026-04 → 2026-06 sprint; this release re-aligns them.
