# Changelog

All notable changes to Klorn are recorded here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Klorn is pre-1.0 — the public API can break between minor versions. The
`v1.0.0` threshold is gated on POC retention (3/5 ICP sustaining use through
the Day 14+7 measurement window) plus the cost-gate gap closure, not on
calendar time.

## [Unreleased]

### Added — Firewall logs why a PUSH-tier email fired no notification
- **`pushForFirewallEmail` now logs its two silent early returns.** A PUSH-tier
  email can be correctly suppressed before any push is attempted — it's older
  than the 6h recency window (dyno slept, or a late manual sync / backfill
  surfaced old mail), or it deduped against an existing notification. Both
  returned with zero log output, so "a PUSH email fired no alarm" left no signal
  to check. `push.ts` already logs every downstream suppression reason
  (missing VAPID, no subscriptions, rate-limit); these two upstream returns were
  the last blind spot. Now each emits a `[PUSH] Firewall PUSH suppressed/deduped`
  line, making the missing-alarm case diagnosable from prod logs without a repro.
  Logging only — no behavior change.

### Changed — OntologyProposal.status is a Prisma enum
- **`status` moved from raw `String` to a `ProposalStatus` enum
  (OPEN/APPLIED/DISMISSED).** Status became load-bearing with the approval gate —
  `APPLIED` drives the live classifier — so a typo must fail at compile time (and
  a bad value at the DB) instead of silently mis-applying or skipping an override.
  No code changes (the existing string literals match the enum); migration casts
  in place.

### Added — Ontology approval gate (live overrides)
- **Approved threshold proposals now drive the classifier (opt-in, per-knob).**
  The write-side's next rung: an admin can APPROVE a proposal so the firewall
  reads it live, instead of only editing the `const` in a PR. `tierFromFeatures`
  became a pure function taking a `ThresholdConfig`; a startup-loaded
  effective-threshold cache (`ontology-overrides.ts`) merges APPLIED proposals
  over the git base, re-clamped and ordering-checked so a bad/stale row can never
  break classification. The eval harness and unit tests never refresh the cache,
  so effective == base there — the CI eval gate is unaffected; with zero
  approvals, prod == base too. New `POST /api/admin/ontology/proposals/:id/approve`
  and `/revert` (with status guards + a `cacheRefreshed` signal); the web
  `/admin/ontology` page gained Approve / Revert and a "Live overrides" section.
  Still human-gated — no auto-apply. See
  `docs/superpowers/specs/2026-06-23-ontology-approval-gate-design.md`.

### Added — Web admin ontology view
- **`/admin/ontology` web page.** Renders the shared ontology snapshot (tiers,
  relation thresholds, sender priors, keyword scores, model dial) and the open
  write-side proposals ("current → proposed" with evidence) in the browser, not
  only the desktop Brain Inspector. Adds Recompute and per-proposal Dismiss
  actions so the founder can drive the proposal loop from the web. Read-only over
  the policy itself — proposals are still applied by a code PR. AuthGuard + the
  API's `requireAdmin` gate.

### Added — Ontology write-side (proposals)
- **Override signal now produces advisory threshold-change proposals.** The
  shared ontology was read-only; this adds the write side. A new
  `OntologyProposal` table + `ontology-proposals.ts` turn the aggregate override
  metrics (PUSH `recallUpperBound`, SILENT `overSuppressionRate`) into *proposed*
  adjustments to `tier.push.confidence` / `tier.silent.reversibility`, bounded
  (min-sample floor, max step, `[0,1]` clamp, never crossing the adjacent tier).
  **Proposal-only by design:** the classifier never reads the table — it keeps
  running the git `const`s — so an approved proposal is applied by a human via a
  code PR (git = audit + revert). Surfaced read-only via `GET /api/admin/ontology`
  (now returns `proposals`) and in the desktop Brain Inspector ("current →
  proposed"). Recomputed daily by the calibration job and on demand via
  `POST /api/admin/ontology/proposals/recompute`; manual `…/:id/dismiss`. See
  `docs/superpowers/specs/2026-06-23-ontology-write-side-design.md`.

### Changed — Deterministic core extraction
- **Firewall decision logic split into single-source policy modules.** The tier
  rule, sender-knowledge schema/thresholds, and no-LLM keyword patterns were
  extracted out of `poc-judge.ts` (which held them as inline magic numbers) into
  `tier-policy.ts` (relation), `sender-policy.ts` (entity), and
  `keyword-policy.ts` (pattern). `poc-judge.ts` keeps only LLM orchestration and
  re-exports the moved symbols for back-compat. Behavior is identical — every
  threshold, inequality, regex, and score is unchanged.
- **`ontology.ts` shared surface + `GET /api/admin/ontology`.** A barrel over
  the four policy modules plus `describePolicy()`, a detached JSON-serializable
  snapshot of the whole deterministic core — the read side of a shared ontology
  a second surface can query.

### Added — Model dial
- **Confidence-based judge escalation (`judge-dial.ts`).** Off by default. When
  `JUDGE_ESCALATION_MODEL` is set, the judge scores on the cheap `JUDGE_MODEL`
  first and re-judges with the stronger model only when the cheap model reports
  low confidence (< 0.5) — "frontier only on the blind spot". A failed
  escalation retains and logs the cheap result; caller-pinned models
  (playground/eval) never escalate.

### Added — Desktop shell
- **`@klorn/desktop` Electron shell.** A thin native window wrapping the Klorn
  web app, with a read-only `window.klorn.getOntology()` bridge — the first
  non-API consumer of the shared ontology. Sandboxed renderer, http(s)-only
  navigation allowlist, env-injected API base.
- **Brain Inspector window (Cmd/Ctrl+B).** The first native surface that draws
  the shared brain instead of the web app: a read-only panel rendering the live
  ontology snapshot (tiers, relation thresholds, sender priors, keyword scores,
  model dial). The inspector has no access to the web app's `localStorage`, so it
  fetches over IPC — the main process reads the JWT from the signed-in window and
  performs the authenticated request itself; only the non-sensitive ontology JSON
  crosses into the inspector renderer, never the token. CSP-locked page; the
  render logic is a pure, unit-tested function.
- **Fixed the ontology bridge auth.** `window.klorn.getOntology()` sent
  `credentials: "include"` (a cookie), but the API has no cookie session and
  `/api/admin/ontology` is `requireAdmin` — so the bridge always 401'd. It now
  reads the web app's JWT from `localStorage` and forwards it as
  `Authorization: Bearer`, matching how the web app authenticates.

### Security
- **Upgraded `@klorn/desktop` Electron 33 → 42.4.1.** Electron 33.2.1 carried
  four HIGH advisories (three renderer use-after-free + a command-line-switch
  injection), and the 33 line is past Electron's support window (only the latest
  three majors get security fixes). 42.4.1 clears all four and puts the shell on
  a supported branch. The shell uses only stable Electron APIs, so no code
  changes were needed (tsc/build/tests pass against the 42 types).
- **Removed the unauthenticated `GET /api/health/email` diagnostic.** It sent a
  real email to the admin on every request with no auth (Resend quota / inbox
  spam vector). Its purpose (verifying delivery) is long done.
- `naver-imap` classify failure now logs to console before `captureError` (was
  silent when Sentry is off).
- **Closed a session-revocation bypass on routes gated only by `getUserId()`.**
  `getUserId()` verifies the JWT signature but skips the device-kick and
  password-reset-epoch checks that `requireAuth` enforces, so a stolen token
  revoked by a password reset still had access on those routes. Added
  `requireAuth` to the email plugin (file-level, covering its sub-routes), the
  chat pending-actions plugin, and the 10 private `auth.ts` routes (`/me`,
  password change/set, has-password, Google connect/disconnect/status,
  resend-verification, init-sync). `/logout` stays ungated so a revoked token
  can still be cleaned up; public login/OAuth/registration routes are unchanged.

### Added — Public playground
- **Login-free BYOK playground (`/playground`).** A public page that runs the
  real 4-tier classifier (`judgeEmail`) on a single pasted email using the
  visitor's own OpenRouter / OpenAI / Gemini key. It removes the OAuth wall for
  the *experience* step; it is a top-of-funnel demo, not a measure of per-user
  recall (the visitor self-selects the input, so it cannot test what the
  firewall would miss). Backed by a stateless `POST /api/playground/classify`
  (+ `/feedback`): strict schema, per-IP rate limit, no auth. The visitor key
  is used for one call and is never persisted, logged, or sent to Sentry.
- **`playgroundOnly` provider guard.** The playground chain contains the
  visitor key *only* — never the server's env keys — so a bad key fails closed
  instead of falling through to Klorn's quota (a zero-auth billing-theft path).
  It also skips the global cost gate and the cross-request cooldown, disables
  SDK retry so a 429 fails fast, and caps the judge's `max_tokens` so
  OpenRouter's up-front credit reservation can't trigger a spurious 402.
- **Direct OpenAI provider.** A visitor's `sk-…` key now routes to
  `api.openai.com` (previously only OpenRouter/Gemini were reachable).

### Hardening
- Sentry `beforeSend` now scrubs request bodies (`apiKey`/`password`/`token`),
  and the API runs with `trustProxy` so per-IP rate limits resolve the real
  client IP behind the load balancer.

### Added — Calibration measurement
- **Decision-label ledger.** Every email classification now records the tier
  the firewall *showed* you plus the features behind it, in a `DecisionLabel`
  table that survives the in-place tier overwrite a manual override performs.
  An override stamps the row with your correction. This is the raw material
  for measuring per-user PUSH recall and over-suppression from real traffic —
  the drift-tripwire complement to a held-out human audit, not the launch gate
  itself. Best-effort: it never fails a classification, and never silently
  swallows an error either.
- **Decision-metrics read path.** The ledger now has a reader. `GET
  /api/admin/decision-metrics` reports per-user PUSH recall and SILENT
  over-suppression as honest *bounds* — a null outcome is never counted as
  agreement, so recall is an upper bound (confirmed escalations only) and
  over-suppression a lower bound (confirmed rescues only). The same headline is
  appended to the daily calibration snapshot, turning the ledger into a per-day
  drift series surfaced on `/admin/calibration`. The admin read is bounded to a
  trailing window (default 90d) so it stays index-served as the table grows.
  A CLI (`pnpm --filter @klorn/api decision-metrics`) reads the same numbers
  straight from the DB — no running server or admin token — for dogfooding.

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
- **GitHub firewall PUSH was silently vetoed by the inbound-mail noise filter.**
  GitHub pushes were sent with category `system`, which `authoredSurface()`
  maps to `null`, so a judge=PUSH thread whose title held a collision word
  (`verify`, `deal`, `confirm your`) was dropped as "noise" and never
  interrupted the user. A new `github_urgent` category maps to the `firewall`
  surface (like `email_urgent`), bypassing the noise heuristic while still
  honoring quiet hours, the rate limit, and category gating. A failed push now
  reports to Sentry instead of `console.warn` only.
- **Dismissed/resolved GitHub firewall items resurrected on re-poll.** The
  GitHub `AttentionItem` upsert forced `status: "OPEN"` on every update, so a
  thread the user had DISMISSED/RESOLVED reappeared the next time the poller
  re-ingested it with new activity. The update path no longer touches `status`
  (kept only on create), mirroring the email path's terminal-decision
  preservation.
- **Notifications only appeared after a manual refresh on laptop resume.**
  WebSocket notification delivery is best-effort and lives only in server
  memory (`broadcastToUser`), so anything pushed while a tab was suspended
  (laptop closed) or the socket was down never reached the client — it only
  landed in the DB and stayed invisible until the user refreshed. The bell
  now reconciles against `GET /api/notifications` whenever the tab is
  reactivated (`focus` / `online` / `visibilitychange→visible`) or the
  realtime socket reconnects (`connected` false→true), throttled to 1s to
  collapse the focus + visibilitychange burst. The bell-flash was also
  extracted into `triggerFlash()` with timer cleanup so an in-flight flash
  can't fire onto a remounted instance.
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
- **Fallback models silently degraded the firewall to keyword-only.** The
  judge and batch classifier ask for bare JSON, but OpenRouter `:free`
  fallback models (e.g. `llama-3.3-70b:free`) ignore the `response_format`
  hint and wrap their output in a Markdown code fence, so `JSON.parse` threw
  and every fallback-served email dropped to the keyword floor — burying
  urgent PUSH mail in QUEUE whenever the paid model was rate-limited or
  retired. A shared `parseLlmJson` helper now strips the fence before parsing,
  applied across all eight LLM-output parse sites (judge, classifier, summary,
  attachments, commitment path/refiner, voice profile, meeting notes).
- **The deterministic action floor only enforced `send_email`.** The doctrine
  reserves an ActionReceipt for three irreversible actions (send_email /
  delete_permanent / forward_external), but only `send_email` was guarded,
  case-by-case. A central fail-closed guard now refuses any floor action
  without a verified receipt before the tool switch runs, so a future
  irreversible tool cannot ship a receipt-less path. The refusal also logs a
  console signal (not just Sentry) so it stays visible in CI and local dev.

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
