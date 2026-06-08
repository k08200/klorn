# Changelog

All notable changes to Klorn are recorded here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Klorn is pre-1.0 — the public API can break between minor versions. The
`v1.0.0` threshold is gated on POC retention (3/5 ICP sustaining use through
the Day 14+7 measurement window) plus the cost-gate gap closure, not on
calendar time.

## [Unreleased]

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
