# Launch plan (drafted 2026-08-07)

Founder-stated goals: demo video first; Google OAuth verification so anyone
can log in and use it; multi-account (2–3 inboxes) with 2+ accounts paid;
pricing $29.99 (was $8.99); more providers (iCloud, Naver, …); mobile "coming
soon"; then promotion. This file sequences that against the actual state of
the repo and adds the missing pieces. Decisions marked LOCKED are the
founder's; PENDING ones block only their own step, nothing upstream.

## P0 — Sync integrity (blocks everything user-facing)

> **P0 is closed (2026-08-26).** The four engineering items are done and
> verified against current code (file:line on each); the founder re-consent is
> done and verified in the signed-in app; and the mail gap it was supposed to
> have left does not exist.
>
> Checked rather than assumed: filtered the mail list to the PRIMARY inbox and
> paged back to 16 July — every day from 16 to 31 July is present, straight
> through the window the 07-21 token death was supposed to have emptied, and on
> into August unbroken. Whatever was lost has already been recovered.
>
> A caution for whoever measures this next: the default mail view is filtered
> to **Needs reply**, and reading dates off it shows gaps that are only the
> filter. Switch to "All signals" and pick a single inbox before concluding
> anything about ingestion.

The founder's own primary Gmail stopped ingesting ~2026-07-21 (Testing-mode
refresh token death). Diagnosis as it stood on 2026-08-07 — all four faults
below have since been fixed, and are kept here because the failure mode is
what the fixes are shaped around: ingestion retried and failed every tick with
only a console.warn; the desktop app surfaced nothing (no /google/status call,
no notification rendering, and `routes/email.ts` hardcoded
`needsReconnect: false` for the primary entry, so the desktop's reconnect UI
could never fire for it); desktop re-login was pure JWT and did not touch the
Google token.

- [x] Founder: Google re-consent — done. Verified 2026-08-26 in the signed-in
      app: Settings → Connections lists both `k0820086@gmail.com` and
      `d14947652@gmail.com` as "Synced 1m ago", with no reconnect prompt.
- [x] fix(api): primary inbox entry in `/api/email/inboxes` reports real
      `needsReconnect` (UserToken.refreshToken null) instead of `false`.
      Verified 2026-08-26: `routes/email.ts:1402` computes
      `Boolean(googleToken) && !googleToken?.refreshToken`.
- [x] fix(desktop): primary reconnect action opens the primary connect flow.
      Verified 2026-08-26: `TopBar.swift:931-934` routes PRIMARY through
      `/google/start` consent and says why link-inbox is wrong for it.
- [x] Backfill: the "catch-up" path is no longer manual. `email-sync.ts`
      snapshots at `EXPIRED_WATERMARK_CATCHUP_MAX` (250) whenever the stored
      watermark has aged out of Gmail's ~7-day retention, instead of the
      scheduler's per-tick 30. Judge calls are background-priority, so they
      queue behind `backgroundLlmPacer` rather than bursting the quota.
      Still needs the founder reconnect above before it can run for 07-21→now.
- [x] Alerting: reaches Sentry. Verified 2026-08-26:
      `automation-scheduler.ts:1595` captures "Email sync skipped every tick",
      throttled once per user per UTC day (`automation-scheduler.ts:156`).

## P1 — Login-for-everyone gate (deadline-driven)

- [ ] CASA: the 4 outstanding founder actions (docs/launch — see CASA prescan
      notes, 2026-08-04), then TAC DAST (scans prod BEFORE 2026-10-05), then
      Letter of Assessment. Until LoA: provider flags stay OFF (frozen).
- [ ] Azure app registration (personal + work/school), redirect
      `https://klorn-api.onrender.com/api/auth/outlook/callback`, delegated
      Mail.Read/ReadWrite/Send + offline_access; put MS_CLIENT_ID/SECRET/
      REDIRECT_URI in Render. (Parallel to CASA; Outlook flag flip still
      waits for LoA.)
- [ ] Beta gate policy: BETA_GATE_ENABLED is the only line between "verified
      app" and "anyone logs in" — decide open criteria (cohort size, waitlist).

## P2 — Monetization

- Multi-account = paid. LOCKED. Refined 2026-10-15 (founder, LOCKED): the FIRST
  mail account is free whatever the provider (Google, iCloud, Naver, Outlook);
  connecting a SECOND one needs Pro (`multi_account`). Every connect route asks
  `packages/api/src/billing/mail-account-entitlement.ts`; inert while
  PAYWALL_ENABLED=false.
- Price RAISED 2026-10-14: `$29.99`/mo web, `$34.99`/mo native (was `$8.99`/`$9.99`,
  decided 2026-08-10). The category sits at $30 and no one had subscribed yet. The
  single source of truth is `packages/web/src/lib/pricing.ts`; an annual tier
  (~$79/yr) is still open. Paddle live checkout was verified end-to-end with a
  real transaction on 2026-08-22.
- [ ] Create the RevenueCat (mobile) price objects; verify webhook plan sync
      end-to-end. The Paddle (web) side is done.
- [ ] PAYWALL flip per docs/launch/paywall-flip-runbook.md (trial stays 7d
      card-required). Flip AFTER beta cohort feedback, not with it.

## P2b — Unit economics at 100 users (measured 2026-08-10)

Inputs are the real ones in code, not guesses: `JUDGE_BODY_CAP = 1500` chars
of body plus prompt scaffolding ≈ 1,000 prompt tokens, ~100 completion
tokens per classification; judge/draft model `google/gemini-2.5-flash` at
$0.30 / $2.50 per 1M (the rate the cost ledger actually meters).

| Load | Volume/day | Cost/day |
|---|---|---|
| Classification | 100 users × 100 mails = 10,000 | **$5.50** |
| Reply drafts | ~10/user = 1,000 | ~$1.20 |
| Briefings | 100 | ~$0.19 |
| **Total** | | **≈ $7/day ≈ $210/mo** |

Against $29.99 × 100 = $2,999/mo that is **~7% of revenue** — viable, and the
margin improves as the fallback chain (cheap paid SKUs) absorbs spillover.

**Two findings, both actionable:**

1. ~~`GLOBAL_DAILY_COST_CAP_CENTS` defaults to $10/day~~ — **raised to
   $50/day, founder decision 2026-08-10.** At ~$7/day steady state the old
   ceiling left barely one heavy day of headroom, and tripping it stops
   classification for EVERY user mid-day — a protective ceiling that fires in
   normal operation has stopped protecting and started breaking. Per-user
   caps ($1.00/day, free $0.10/day) remain the real per-account guard; the
   global figure is only the fatal-bill backstop. Revisit at the next cohort
   step — rule of thumb is ~7x measured steady state.
2. **Mis-priced fallback SKUs cost SERVICE, not money.** Three chain entries
   were metered 60–100x their real price by the family-match table, which
   would have burned the caps in minutes at this volume. Fixed with explicit
   rows + tests (`model-fallback.ts`, 2026-08-10). Any future chain entry
   must be added to `MODEL_RATES` in the same change.

## P3 — Product surface for launch

- [ ] Demo video: script around the five-lane firewall + Decision queue +
      multi-inbox; record on web (desktop app b-roll optional).
- [x] Landing providers row — live and verified 2026-08-26 on klorn.ai:
      "Naver Mail — Connected over IMAP from Settings", "Outlook & Microsoft
      365 and iCloud Mail — already built…". Pricing section still waits on P2.
- [x] Support contact surfaced in-app (2026-08-26). It had lived only inside
      the privacy/terms/refund pages — all three on a noindex subdomain a
      signed-in user has no reason to open. Web: Settings → About. Desktop:
      the App & diagnostics disclosure in BOTH panels, next to the diagnostics
      button, opening a prefilled mail with the app version.
- [x] Legal before paywall — all three read in full 2026-08-26, not scanned.
      Privacy had two undisclosed processors and a date older than its own
      file; fixed in #1263 (Resend sends every transactional mail; Naver IMAP
      stores a second mailbox credential and was absent entirely).
      Terms and the refund policy hold up: the refund text derives the price
      from `PRO_PRICE_WEB` rather than restating it, covers Paddle as merchant
      of record, the 7-day trial, self-cancel, the 14-day first-month refund
      and Korean withdrawal rights. Its "Cancel subscription in Settings"
      claim is conditional on `canCancel`, which is true for exactly the
      web/Paddle subscribers the policy addresses — the founder's own account
      shows "not billed on the web" because it is not one of them.
      Not legal review; this only makes the documents match the code.

## P4 — Flag flips (each a separate deliberate decision, post-LoA)

Order: MULTI_INBOX_SYNC_ENABLED → PROVIDER_INBOX_SELECTOR_ENABLED →
ICLOUD_INBOX_ENABLED → OUTLOOK_INBOX_ENABLED (needs Azure creds; without
them link-start 503s by design) → AUTO_REPLY_LINKED_INBOX_ENABLED last.
Each flip: real-account connect + sync + action verification same day.
Known follow-ups riding the flips: Outlook true reply threading
(/messages/{id}/reply), Graph 3MB inline attachment pre-check.

## P5 — Distribution

- [ ] Mobile: Capacitor shell exists; TestFlight/internal track first,
      store listing with "multi-inbox firewall" positioning; RevenueCat IAP.
- [ ] Promotion after P0–P3 are true: Product Hunt, HN/Show HN, Korean dev
      communities; the demo video is the anchor asset.
- [ ] Ops for real users: manual DB backup drill on schedule (free tier has
      no automated backups — docs/launch/db-credential-runbook.md), Sentry
      alert rules, uptime monitor on /api/health.

## Non-goals for launch

Generic IMAP (Phase 4 of the provider plan) stays unbuilt until its SSRF
design passes review. No new Google scopes anywhere.
