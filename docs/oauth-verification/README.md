# Google OAuth Restricted-Scope Verification — Submission Checklist

Step-by-step submission guide for Klorn (app.klorn.ai). Follow in order; each step
unblocks the next. Budget 2–6 weeks end-to-end (Google's review) plus the CASA
Tier 2 assessment window.

## What we are submitting for

Klorn requests **restricted** Gmail scopes (`gmail.readonly`, `gmail.modify`)
and **sensitive** scopes (`gmail.send`, `calendar.events`,
`calendar.readonly`), plus non-sensitive identity scopes (`openid`,
`userinfo.email`, `userinfo.profile`). Restricted Gmail scopes require:

1. Brand/consent-screen verification
2. Per-scope justifications (see `scope-justifications.md`)
3. A demo video (see `demo-video-script.md`)
4. A CASA Tier 2 security assessment (annual)
5. A compliant privacy policy with the Limited Use disclosure (see
   `limited-use-disclosure.md`)

## Prerequisites (verify before starting)

- [ ] Google Cloud project that owns the production OAuth client ID.
- [ ] Domain ownership of `klorn.ai` verified in
      [Google Search Console](https://search.google.com/search-console) with the
      **same Google account** that is a project owner/editor. Verify the bare
      domain (Domain property) so `app.klorn.ai` is covered.
- [ ] Privacy policy live at `https://app.klorn.ai/privacy` and linked from the
      landing page footer (`klorn.ai`). It must contain the Limited Use
      disclosure verbatim — confirm against `limited-use-disclosure.md`.
- [ ] Terms of service live at `https://app.klorn.ai/terms`.
- [ ] The homepage must describe what the app does with Google user data (a
      short "Klorn reads your Gmail to triage it into PUSH/MEETING/QUEUE/
      INFO/SILENT" line with a link to the privacy policy satisfies this).
- [ ] App is functional in production — reviewers will create an account and
      click through.
- [x] `LOG_RETENTION_ENABLED=true` set on Render — confirmed by the founder
      2026-08-26. The privacy policy states concrete log-retention windows
      (90/30/180 days); the sweep that enforces them is OFF by default
      (`packages/api/src/log-retention.ts:17`), so the claim is only true with
      the flag on. Five of the six tables are deleted by that sweep alone:
      `pruneOldPushDeliveryLogs` is reachable only from
      `scripts/prune-push-logs.ts`, and the one flag-free prune
      (`push-rate-limit.ts:94`) covers PushRingEvent on a 60-minute window for
      active users. If the flag is ever turned off, the policy sentence stops
      being true the same day — change the sentence, not just the flag.

## Step 1 — Complete the OAuth consent screen

Cloud Console → **APIs & Services → OAuth consent screen** (now under
**Google Auth Platform → Branding** in newer consoles):

1. User type: **External**.
2. App name: `Klorn` (must match the visible product name on klorn.ai —
   mismatches are a common rejection reason).
3. User support email: `k0820086@gmail.com` — **pinned 2026-08-05**. This is
   the literal used by the live privacy policy (3 places) and the landing-page
   footer; the consent screen must use the exact same address. Switching to a
   domain address (e.g. `support@klorn.ai`) later re-triggers brand review —
   change it everywhere before submission or not at all.
4. App logo: 120×120px. Note: uploading a logo puts the app into review even
   before scope verification; do it now, once.
5. App domain fields:
   - Homepage: `https://klorn.ai`
   - Privacy policy: `https://app.klorn.ai/privacy`
   - Terms of service: `https://app.klorn.ai/terms`
6. Authorized domains: `klorn.ai`.
7. Developer contact email(s): `k0820086@gmail.com` (same pinned address) —
   all review correspondence goes here.

## Step 2 — Declare exactly the scopes the code requests

Console → **OAuth consent screen → Scopes → Add or remove scopes**. Declare
**only** these (the exact set requested in
`packages/api/src/mail/gmail.ts` — declaring more than the code uses is a
rejection reason; using more than you declare is worse):

> **Incremental auth (2026-08-05):** sign-in requests only the identity
> scopes (`getLoginAuthUrl`); the Gmail/Calendar scopes are requested by the
> separate Connect step (`getAuthUrl`, reached via
> `POST /api/auth/google/start` from onboarding/Settings). The table below is
> the union across flows — it is still the exact set to declare.

| Scope | Classification |
|---|---|
| `openid` | Non-sensitive |
| `https://www.googleapis.com/auth/userinfo.email` | Non-sensitive |
| `https://www.googleapis.com/auth/userinfo.profile` | Non-sensitive |
| `https://www.googleapis.com/auth/gmail.readonly` | **Restricted** |
| `https://www.googleapis.com/auth/gmail.send` | Sensitive |
| `https://www.googleapis.com/auth/gmail.modify` | **Restricted** |
| `https://www.googleapis.com/auth/calendar.events` | Sensitive |
| `https://www.googleapis.com/auth/calendar.readonly` | Sensitive |

## Step 3 — Submit for verification

Console → **OAuth consent screen → Publishing status → Publish app**, then
**Prepare for verification / Submit for verification**. The form asks for:

1. **Scope justifications** — one text box per sensitive/restricted scope.
   Paste from `scope-justifications.md` (written to fit the form).
2. **Demo video link** — an **unlisted YouTube URL** (not private, not a Drive
   link). Record per `demo-video-script.md`. The video must show the OAuth
   consent screen with the production client ID visible in the URL bar, and
   each requested scope being exercised in the app.
3. **How the app uses Google user data** — a short narrative; reuse the
   opening paragraph of `scope-justifications.md`.
4. Confirmation that the privacy policy contains the Limited Use disclosure.

Submit. Expect a reply from `api-oauth-dev-verification@google.com` (or the
Trust & Safety team) within days; respond promptly — threads that idle get
closed and you restart.

## Step 3.5 — Reviewer and assessor test access (beta gate)

`BETA_GATE_ENABLED=true` stays on, which makes signup invite-only on both the
email/password and Google paths. Google reviewers click through the production
app, and the CASA lab's DAST scanner needs working login credentials — neither
can pass the gate on their own. Pre-provision access like this:

1. Add the reviewer/assessor email to the waitlist (admin token required):
   `POST /api/admin/waitlist` with `{ "email": "<their-address>" }`. The
   public `POST /api/waitlist` was deleted 2026-08-26 — it had no caller and
   the landing says "no invite, no waitlist" — so this is now the only way a
   row is created. Ask them for the address they will actually use.
2. Approve it (admin token required):
   `GET /api/admin/waitlist?status=PENDING` → find the entry id →
   `PATCH /api/admin/waitlist/:id` with `{ "status": "APPROVED" }`.
   Approval fires the beta invite email automatically.
3. Register the account with email + password
   (`POST /api/auth/register`, or the invite-email flow). For the DAST
   scanner, register a dedicated account yourself (e.g.
   `<your-alias>+casa@gmail.com`) and hand the lab the URL
   (`https://app.klorn.ai`) plus those credentials — the crawl does not need
   a Google grant.
4. For the Google reviewer, connect a disposable Gmail account to the test
   login first so every scoped feature is demonstrable in-app, matching the
   demo video.
5. Disable or delete the test accounts after the review concludes (Settings →
   Delete account, or the admin users endpoint).

## Step 4 — CASA Tier 2 security assessment

Triggered automatically after Step 3 because of the restricted Gmail scopes.
Google emails instructions naming an authorized assessor.

1. **Follow the notification email's instructions** — as of 2026 the ADA has
   deprecated the standalone self-scan compliance path ("The CASA self scanning
   process is deprecated. For CASA compliance follow instructions provided in
   your notification."); an independent Authorized Assessor must be involved.
   Labs on the [ADA assessor list](https://appdefensealliance.dev/casa/casa-assessors)
   sell Tier 2 (AL1) packages. TAC Security pricing as of 2026-08
   (casa.tacsecurity.com): Basic **$675**/app (includes 2 revalidation
   cycles + LoV, quoted 2–3 weeks to LoV), Premium $855 (unlimited
   revalidation), Enterprise tiers above that; other labs up to ~$3,000.
   TAC delivers the Letter of Validation to Google directly; Google then
   confirms to the developer within ~5–6 business days.
2. Self-scanning is still useful as **readiness checking** before paying the
   assessor: use the CASA Accelerator to export the required CWE list, load it
   into an AST scan policy (see the ADA tooling matrix), and fix findings
   first. Klorn's own pre-scan pass (2026-08-04) lives in the CASA companion
   doc — headers/TLS/CORS/error-shape verified live, `pnpm audit --prod`
   driven to zero.
3. Evidence you already have for the questionnaire (keep handy):
   - OAuth tokens encrypted at rest with AES-256-GCM with key rotation
     support (2026-07-20 security audit).
   - All DB access through Prisma parameterized queries; no string-built SQL.
   - Per-user tenancy enforcement (Postgres RLS with per-request tenant
     context; per-user scoping on every query).
   - No third-party trackers; Google user data lives only in first-party
     Postgres.
   - Webhook endpoints verify authenticity (timing-safe shared-token check on
     Gmail Pub/Sub push; signature verification on billing webhooks).
   - Irreversible actions (send / delete / forward) go through a deterministic
     approval floor: an `ActionReceipt` with a SHA-256 payload hash minted at
     approval time and verified at execute time.
   - Server-side daily LLM cost cap per user.
   - User-facing full-account deletion (self-service; purges all
     Google-derived data).
4. The lab issues a Letter of Assessment / Validation; it is delivered to
   Google (or you forward it on the review thread).
5. **Recurring**: CASA revalidation is annual — calendar it.

## Step 5 — After approval

- [ ] Publishing status shows **In production / Verified**; consent screen no
      longer shows the "unverified app" warning and the 100-user cap is lifted.
- [ ] Do **not** add new scopes casually: any new sensitive/restricted scope
      reopens verification. (Linking a second inbox or calendar reuses the
      already-verified scope set by design — see the comments in
      `packages/api/src/mail/gmail.ts`.)
- [ ] Keep the privacy policy URL, app name, and logo stable; changing them
      can re-trigger review.
- [ ] Set a reminder for annual CASA recertification.

## Files in this directory

| File | Purpose |
|---|---|
| `README.md` | This checklist |
| `scope-justifications.md` | Paste-ready per-scope justifications |
| `demo-video-script.md` | Scene-by-scene demo video script |
| `demo-video-captions.srt` | Upload-ready English captions matching the scene timings (record silently, attach on YouTube) |
| `limited-use-disclosure.md` | Limited Use compliance statement + privacy-policy gap list |

One file lives outside this directory: `docs/launch/google-oauth-verification.md`
is the CASA-facing companion — its §6 has the code-backed answers to the
assessor's ~54-question SAQ, which Step 4 above only summarizes. This directory
drives the Google submission; that file answers the assessor.

<!--
CODE EVIDENCE (strip before submission)
- Requested scopes (the superset above): packages/api/src/mail/gmail.ts getAuthUrl (primary
  Gmail/Calendar connect grant), getLoginAuthUrl (identity-only sign-in — incremental auth),
  gmail.ts:95-99 (getLinkCalendarAuthUrl, secondary calendar:
  openid + userinfo.email + calendar.readonly only), gmail.ts:118-124 (getLinkInboxAuthUrl, secondary inbox:
  openid + userinfo.email + gmail.readonly/send/modify; comment at gmail.ts:103-111 notes it reuses the
  verified scope set so it does not reopen CASA).
- AES-256-GCM token encryption at rest: packages/api/src/crypto-tokens.ts:5,23,135.
- Parameterized queries / RLS tenancy: packages/api/src/db-tenant.ts:1-43 (withTenant at :41; ":33" comment
  on set_config preventing SQL splicing). All data access is Prisma.
- Deterministic floor / ActionReceipt + SHA-256 payload hash: packages/api/src/judge/attention-floor.ts:17,27,77-83,109;
  packages/api/src/agentcore/auto-reply-send.ts:16-40; packages/api/src/agentcore/action-outbox.ts:105-113.
- Webhook verification: packages/api/src/routes/gmail-push.ts:73 (timingSafeEqualStr on Pub/Sub token),
  packages/api/src/timing-safe-equal.ts:10, packages/api/src/index.ts:208 (Stripe raw-body signature).
- Daily LLM cost cap: packages/api/src/config.ts:152 (DAILY_COST_CAP_CENTS, default 100¢/user/day).
- User-facing deletion: packages/api/src/user-deletion.ts:5-14, packages/api/src/purge-user-data.ts,
  packages/api/src/routes/auth.ts:1295 (comment: restricted-scope review requires user-facing deletion).
- Delete = Gmail trash (reversible), not permanent: packages/api/src/mail/gmail.ts:1266 (messages.trash),
  gmail.ts:1351 (untrash).
-->
