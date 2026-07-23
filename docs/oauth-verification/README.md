# Google OAuth Restricted-Scope Verification — Submission Checklist

Step-by-step submission guide for Klorn (app.klorn.ai). Follow in order; each step
unblocks the next. Budget 2–6 weeks end-to-end (Google's review) plus the CASA
Tier 2 assessment window.

## What we are submitting for

Klorn requests **restricted** Gmail scopes (`gmail.readonly`, `gmail.send`,
`gmail.modify`) and **sensitive** Calendar scopes (`calendar.events`,
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
      short "Klorn reads your Gmail to triage it into PUSH/QUEUE/SILENT/AUTO"
      line with a link to the privacy policy satisfies this).
- [ ] App is functional in production — reviewers will create an account and
      click through.

## Step 1 — Complete the OAuth consent screen

Cloud Console → **APIs & Services → OAuth consent screen** (now under
**Google Auth Platform → Branding** in newer consoles):

1. User type: **External**.
2. App name: `Klorn` (must match the visible product name on klorn.ai —
   mismatches are a common rejection reason).
3. User support email: the founder support address.
4. App logo: 120×120px. Note: uploading a logo puts the app into review even
   before scope verification; do it now, once.
5. App domain fields:
   - Homepage: `https://klorn.ai`
   - Privacy policy: `https://app.klorn.ai/privacy`
   - Terms of service: `https://app.klorn.ai/terms`
6. Authorized domains: `klorn.ai`.
7. Developer contact email(s): an address you actually monitor — all review
   correspondence goes here.

## Step 2 — Declare exactly the scopes the code requests

Console → **OAuth consent screen → Scopes → Add or remove scopes**. Declare
**only** these (the exact set requested in
`packages/api/src/mail/gmail.ts` — declaring more than the code uses is a
rejection reason; using more than you declare is worse):

| Scope | Classification |
|---|---|
| `openid` | Non-sensitive |
| `https://www.googleapis.com/auth/userinfo.email` | Non-sensitive |
| `https://www.googleapis.com/auth/userinfo.profile` | Non-sensitive |
| `https://www.googleapis.com/auth/gmail.readonly` | **Restricted** |
| `https://www.googleapis.com/auth/gmail.send` | **Restricted** |
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

## Step 4 — CASA Tier 2 security assessment

Triggered automatically after Step 3 because of the restricted Gmail scopes.
Google emails instructions naming an authorized assessor.

1. Pick an Authorized Lab from the
   [App Defense Alliance CASA list](https://appdefensealliance.dev/casa/casa-assessors)
   (e.g. TAC Security, Leviathan, Prescient — TAC has a low/free self-scan
   tier commonly used by small apps).
2. Choose the **self-assessment + verified scan** track (Tier 2 allows it):
   run the lab's SAST/DAST tooling against the deployed app and the
   `packages/api` codebase, complete the CASA questionnaire.
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
      already-verified scope set by design — see `gmail.ts` comments.)
- [ ] Keep the privacy policy URL, app name, and logo stable; changing them
      can re-trigger review.
- [ ] Set a reminder for annual CASA recertification.

## Files in this directory

| File | Purpose |
|---|---|
| `README.md` | This checklist |
| `scope-justifications.md` | Paste-ready per-scope justifications |
| `demo-video-script.md` | Scene-by-scene demo video script |
| `limited-use-disclosure.md` | Limited Use compliance statement + privacy-policy gap list |

<!--
CODE EVIDENCE (strip before submission)
- Requested scopes (the superset above): packages/api/src/mail/gmail.ts:66-78 (getLoginAuthUrl, primary login),
  gmail.ts:46-55 (getAuthUrl, reconnect), gmail.ts:95-99 (getLinkCalendarAuthUrl, secondary calendar:
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
