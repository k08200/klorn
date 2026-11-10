# Google OAuth Verification & CASA Tier 2 — Submission Pack

Klorn requests two **restricted** Gmail scopes (`gmail.readonly`, `gmail.modify`)
plus sensitive Gmail/Calendar scopes, so it must pass restricted-scope
verification **and** an annual CASA Tier 2 security assessment. This file is the
copy-paste source for every field in the OAuth verification form and the
assessor's SAQ. Keep it in sync with the code.

> **Which pack do I follow?** `docs/oauth-verification/` is the canonical
> step-by-step submission runbook (console steps in order, prerequisites, the
> paste-ready Limited Use declaration). **This** file is the CASA-facing
> companion: its §6 holds the code-backed SAQ answers the assessor asks for,
> which the runbook only summarizes. Use the runbook to drive the submission and
> this file to answer the assessor. They must agree — if they ever diverge, the
> code in `packages/api/src/mail/gmail.ts` wins.

Google Cloud project: **`gen-lang-client-0294713076`** ("Default Gemini Project"),
project number **19950762743**, under `k0820086@gmail.com`. The name is an
auto-generated one from AI Studio, not a mistake — confirmed 2026-08-04 by matching
the console's client list against the client id production actually redirects with
(`19950762743-cb3t502kt3cp1ean72hh00t0102fukge.apps.googleusercontent.com`, readable
from the `Location` header of `GET /api/auth/google/login`). Check that id before
trusting any console screen; the project picker defaults elsewhere.

Console path: **Google Auth Platform → Audience** (older consoles:
**APIs & Services → OAuth consent screen**).

## Audience mode while the review is pending

The audience is **In production**, unverified — verified 2026-08-04, and it must stay
that way. Do not press "Back to testing":

| | Testing | In production, unverified (current) | Verified |
|---|---|---|---|
| Authorization lifetime | **expires 7 days after consent** | normal | normal |
| Who can sign in | only emails listed as test users (max 100) | anyone | anyone |
| User cap | 100 listed test users (editable) | **100 new users, counted for the life of the project, no reset** | none |
| Unverified-app warning | yes, on every re-consent | yes, once | no |

Testing mode would be unusable for a real cohort: the 7-day expiry sends every tester
back through the unverified-app consent screen weekly. The cost of production is the
lifetime cap, which is why `BETA_GATE_ENABLED` stays **on** — the waitlist is the only
thing stopping a traffic spike from permanently burning all 100 slots. Probe the gate
without console access: `GET /api/auth/signup-status` returns `{"open":false}` when it
is armed.

Consent-screen basics (must match exactly):
- App name: **Klorn**
- Homepage: `https://klorn.ai` (public, no login)
- Privacy policy: `https://app.klorn.ai/privacy` (same domain family, states Limited Use)
- Authorized redirect URI (production): `https://klorn-api.onrender.com/api/auth/google/callback`

---

## 1. Scope justification (paste into each scope's "justification" box)

Principle: every scope is the **least privilege** that makes a user-facing,
prominently-visible feature work. We do not request `gmail.full`, `gmail.settings.*`,
or any scope that permits permanent deletion.

### Scope inventory (source of truth: `packages/api/src/mail/gmail.ts`)

| Scope | Google tier | Needs CASA? |
|---|---|---|
| `…/auth/gmail.readonly` | **Restricted** | ✅ yes |
| `…/auth/gmail.modify` | **Restricted** | ✅ yes |
| `…/auth/gmail.send` | Sensitive | (covered by CASA) |
| `…/auth/calendar.events` | Sensitive | — |
| `…/auth/calendar.readonly` | Sensitive | — |
| `…/auth/userinfo.email` | Non-sensitive | — |
| `…/auth/userinfo.profile` | Non-sensitive | — |
| `openid` | Non-sensitive | — |

> Because two **restricted** Gmail scopes are present, the app requires full
> verification **and** an annual CASA assessment. There is no way around CASA
> while reading mail content — it is the price of the core firewall feature.

The consent screen must list exactly this set. It is the union of the four
scope arrays in `packages/api/src/mail/gmail.ts`: `getAuthUrl`,
`getLoginAuthUrl`, `getLinkCalendarAuthUrl` (calendar-only link), and
`getLinkInboxAuthUrl` (mail-only link) — the link flows are strict subsets, so
linking a second account requests no new scope.

### `https://www.googleapis.com/auth/gmail.readonly` — RESTRICTED
**Feature:** Klorn's core value — it reads the user's incoming mail to classify
each message into one of five attention lanes (PUSH / MEETING / QUEUE /
INFO / SILENT),
generate a one-line summary, and surface only what needs the user's attention.
**API calls:** `users.messages.list`, `users.messages.get`, `users.threads.*`.
**Why nothing narrower works:** There is no metadata-only scope that returns
message bodies, and the classification/summary requires the body text. Header-only
access cannot distinguish an urgent request from a newsletter.

### `https://www.googleapis.com/auth/gmail.modify` — RESTRICTED
**Feature:** When the user acts on a message inside Klorn — marks it handled,
archives it, or snoozes it — Klorn reflects that state back in Gmail so the two
stay consistent, and lets the user **undo** the action.
**API calls (write):** `users.messages.modify` (`removeLabelIds:["UNREAD"]` to
mark read; `removeLabelIds:["INBOX"]` / `addLabelIds:["INBOX"]` to archive /
un-archive), `users.messages.trash` / `users.messages.untrash`.
**Why nothing narrower works:** `gmail.readonly` cannot write labels or change
message state, so the "mark handled / archive / undo" feature is impossible with
it. `gmail.modify` is deliberately chosen over `gmail.full` **because it cannot
permanently delete mail** (`messages.delete` is not available under modify) — it
is the minimum scope that supports reversible state changes.

### `https://www.googleapis.com/auth/gmail.send` — SENSITIVE
**Feature:** The user reviews an AI-drafted reply in Klorn and presses send;
Klorn sends that reply from the user's own account.
**API calls:** `users.messages.send`.
**Why nothing narrower works:** Sending mail has no lower-privilege alternative;
`gmail.send` is send-only (it cannot read the mailbox), which is exactly the least
privilege for this feature.

### `https://www.googleapis.com/auth/calendar.events` + `calendar.readonly` — SENSITIVE
**Feature:** Klorn shows the user's day, prepares a "meeting prep pack" before
events, detects conflicts, and creates an event from a confirmed draft.
**API calls:** `events.list`, `events.insert`, `events.delete`, `freebusy.query`.
**Why nothing narrower works:** Reading the schedule needs `calendar.readonly`;
creating/removing the events the user confirms needs `calendar.events`. Secondary
calendar *linking* requests only `calendar.readonly` (no write) — least privilege
per surface.

### `openid`, `userinfo.email`, `userinfo.profile` — NON-SENSITIVE
Used only to identify the signed-in account and which mailbox was linked.

---

## 2. Limited Use / data-handling statement (for the form + assessor)

- Google user data is used **only** to provide the user-facing features above,
  visible and prominent in Klorn's UI, and only with the user's OAuth consent.
- Klorn sends message content to third-party AI providers (OpenAI, Google, and
  OpenRouter-routed models) **solely** to generate the summaries and reply drafts
  the user sees. These providers act as our **service providers / data processors**
  under API terms that **do not train** their models on the data. This is the
  permitted "provide user-facing features, with consent" transfer under the
  Limited Use policy — it is **not** a sale or transfer to advertisers/brokers.
- Google user data is **never** used to train generalized/non-personalized AI/ML
  models, never sold, and never transferred for advertising.
- **Human access is limited**: no human reads Google user data except with the
  user's explicit consent, where necessary for security or to comply with
  applicable law, or in aggregated/anonymized form for internal operations.
- OAuth refresh/access tokens are encrypted at rest with **AES-256-GCM** (unique
  IV per record, key from env, key-rotation tooling); they are never returned to
  any client.
- Users can disconnect Google (`DELETE /api/auth/google`) and delete their account,
  which removes stored Google data. (See §6 Data Retention & Deletion.)

The privacy policy (`/privacy`) already states the above, including the verbatim
"Limited Use" reference and the "do not train" commitment.

> **2026-11-01** — The provider list above is the text as prepared for the
> original verification submission; leave it as the record. If this statement
> is reused (e.g. at the next CASA re-assessment), the current server-side AI
> providers are Anthropic (Claude API) and Google (Gemini API). OpenRouter was
> removed from Klorn on 2026-11-01; the privacy policy and DPA name the same two
> providers.

---

## 3. Demo video script (unlisted YouTube, English, screen recording)

Requirements Google checks: consent flow in English, correct app name on the
consent screen, the OAuth client ID visible in the browser address bar, and a
demonstration of **each restricted scope's** functionality.

1. **Intro (10s):** "This is Klorn, an AI email assistant at klorn.ai. I'll show
   the Google sign-in consent flow and how each requested permission is used."
2. **Consent flow (30s):** Start sign-in on `app.klorn.ai`. When redirected to
   Google, **pause on the consent screen** so the app name "Klorn" is clearly
   visible, then **highlight the browser address bar** showing
   `accounts.google.com/...client_id=...` (the OAuth client ID). Approve.
3. **gmail.readonly (30s):** Show the inbox classified into
   PUSH/MEETING/QUEUE/INFO/SILENT
   with AI summaries — "this uses read access to classify and summarize mail."
4. **gmail.modify (30s):** Open a message, click "mark handled / archive", switch
   to Gmail in another tab to show it moved, then click **Undo** in Klorn and show
   it restored — "modify is used only to reflect the user's own actions and undo them."
5. **gmail.send (20s):** Open an AI reply draft, edit it, press Send, show it in
   Gmail's Sent — "send is used only when the user explicitly sends a reply."
6. **calendar (20s):** Show the day view / meeting prep, then create an event from
   a confirmed draft.
7. **Close (10s):** "All access is used only for these in-app features, disclosed
   in our privacy policy, and never used to train AI models or shared with third
   parties for advertising."

Keep it under ~3 minutes, no cuts inside the consent flow.

---

## 4. Consent screen — what to fill (order)

1. **App info**: name `Klorn`, user support email, app logo, developer contact.
2. **App domain**: home `https://klorn.ai`, privacy `https://app.klorn.ai/privacy`,
   terms `https://app.klorn.ai/terms`. Authorized domain `klorn.ai`.
3. **Scopes**: add the scopes from §1; paste each justification.
4. **Test → Production**: set the app to In production / **Submit for
   verification**. Attach the demo video link.
5. Google reviews → for the restricted scopes they will email **CASA**
   instructions (see §5).

> Policy URLs are settled — use the `app.klorn.ai` ones above. `klorn.ai/privacy`
> and `klorn.ai/terms` are not separate documents: `website/privacy/index.html`
> and `website/terms/index.html` are 14-line stubs that `noindex`, declare
> `rel="canonical"` to the `app.klorn.ai` pages, and immediately redirect there.
> The real policy is `packages/web/src/app/privacy/page.tsx`. Give Google the
> canonical URL, not the redirect.

---

## 5. CASA (after the console submission)

- Google emails a link to authorized **CASA assessors**. Pick one from their
  list, contact them, and complete a **Tier 2** assessment (self-assessment
  questionnaire + an authorized scan of the app).
- The assessor issues a **Letter of Assessment (LoA)** to Google; verification
  completes once Google has it.
- **Annual**: CASA must be re-done every ~12 months regardless of changes.
- Cost: roughly **$540–$1,800/yr** depending on assessor (historical estimate —
  confirm with the assessor).

---

## 6. CASA Tier 2 SAQ — pre-filled answers (code-backed)

The assessor sends a ~54-question Self-Assessment Questionnaire. These are the
answers grounded in the current codebase, ready to paste/adapt.

**Pre-scan pass (2026-08-04, live against production)** — what a DAST will see:
TLS 1.0/1.1 rejected at handshake, 1.2/1.3 negotiated (openssl s_client, both
hosts); all headers below re-verified on live responses; CORS echoes only the
pinned origin; 404/500 bodies are generic JSON (no stack traces); rate-limit
headers live (`x-ratelimit-limit: 100`); no cookies anywhere (JWT header auth),
so no cookie-flag findings are possible. Two findings were fixed the same day:
a request with an unrecognized `Origin` header returned HTTP 500 (now a quiet
CORS denial), and `pnpm audit --prod` showed 43 advisories (19 high, all
transitive) — driven to **zero** via in-range updates plus `pnpm.overrides`
(`postcss` ≥8.5.23, `sharp` ≥0.35.0, `uuid` ≥11.1.1). Re-run
`pnpm audit --prod` the week the assessor scan is booked; new advisories land
continuously.

**Transport security:** All traffic is HTTPS. TLS 1.3 supported on both
`app.klorn.ai` (Vercel) and `klorn-api.onrender.com` (Render/Cloudflare); TLS
1.0/1.1 rejected; AEAD ciphers only (CHACHA20-POLY1305 / no CBC). HSTS enabled
with `includeSubDomains` (max-age 2y web, 1y API).

**Security headers:** CSP (`default-src 'self'`, `object-src 'none'`,
`frame-ancestors 'none'`, `base-uri 'self'`), X-Frame-Options: DENY,
X-Content-Type-Options: nosniff, Referrer-Policy, Permissions-Policy on the web;
the API returns `default-src 'none'` CSP + X-Frame-Options: DENY on every
response. `Access-Control-Allow-Origin` is pinned to the app origin (no wildcard).

**Authentication & session:** Google OAuth + email/password (bcrypt, cost 10).
Session JWT is HMAC-SHA256, 7-day expiry, `algorithms:["HS256"]` pinned on verify.
Per-device session table (hashed tokens) allows remote revocation; a global
`sessionsInvalidatedAt` epoch revokes every outstanding token on password reset.
Desktop OAuth uses PKCE (SHA-256 challenge, verifier via header, never in URL) —
enforced (challenge-less nonce mints are rejected) — plus a deep-link relay that
never parks the JWT for polling.

**Access control (IDOR):** Every data route enforces per-user ownership
(`where:{ id, userId }`); `/api/admin/*` is gated by a `requireAdmin` preHandler
(role ADMIN or `ADMIN_EMAILS`, audit-logged).

**Encryption at rest:** OAuth tokens AES-256-GCM (env key + keyring rotation);
Postgres managed by Render with encryption at rest.

**Injection:** Prisma ORM (parameterized); the only raw SQL is
`pg_advisory_lock($1)` with a bound integer — no user input reaches raw SQL. No
`dangerouslySetInnerHTML`; stored mail is rendered as escaped React text.

**Webhooks:** Gmail Pub/Sub verified via Google-signed OIDC (audience + email
bound) or a timing-safe shared secret; Stripe/Paddle/RevenueCat/Telegram/Twilio
all signature-verified; events deduped in a `WebhookEvent` table.

**Rate limiting:** Global 100/min/IP; tighter per-route limits on auth
(register 5/15min, login 10/15min, desktop-token 30/min) and LLM endpoints; a
server-enforced per-user daily cost cap bounds spend.

**Logging & secrets:** No hardcoded secrets (dev-only JWT fallback throws outside
dev/test). Sentry `beforeSend` strips Authorization/Cookie headers, redacts
password/token/apiKey body fields, and scrubs the URL query string (so OAuth
`code`/`state` never ship to Sentry).

**Data retention & deletion:** Users can disconnect Google (`DELETE
/api/auth/google`, removes the stored `UserToken`) and delete their account.
Handled mail state is reconciled from Gmail; on account deletion Google-derived
data is removed. `DELETE /api/auth/account` → `deleteUserAndAllData`, checked against
the schema 2026-08-02: 42 of the 43 `userId` relations are `onDelete: Cascade` and the
one exception (`LlmUsageLog`, `SetNull`) is deleted explicitly in the same transaction,
so no row survives the user.

**Dependency & build:** pnpm lockfile pinned; production source maps not served
publicly; server does not run as root on Render.

---

## 7. Pre-submission checklist

- [ ] OAuth consent screen: app name "Klorn", homepage `klorn.ai`, privacy
      `app.klorn.ai/privacy`, all 8 scopes listed with the §1 justifications.
- [ ] Production redirect URI is the only one registered; no `localhost` in prod client.
- [ ] Demo video (§3) recorded, uploaded unlisted, linked in the form.
- [ ] Privacy policy live and states Limited Use + do-not-train (already true).
- [ ] Headers/TLS re-verified live (done 2026-07-20: no wildcard ACAO, CSP,
      X-Frame-Options, TLS 1.3, legacy TLS rejected).
- [x] Account-deletion endpoint confirmed to remove all Google-derived data.
      `DELETE /api/auth/account` → `deleteUserAndAllData`; checked against the schema
      2026-08-02: 42 of the 43 `userId` relations are `onDelete: Cascade` and the one
      exception (`LlmUsageLog`, `SetNull`) is deleted explicitly in the same transaction,
      so no row survives the user.
- [ ] Pick an approved CASA assessor (e.g. TAC Security ~$540) and book the scan.
- [ ] Run OWASP ZAP against production yourself first to catch findings early.

---

## 8. After verification — when features change (rule of thumb)

- **No new scope** (UI, new classification logic, features within existing Gmail/
  Calendar access) → **no re-verification**; just ship.
- **New scope added** → update the consent screen (new scope + justification +
  refreshed demo video) and **re-submit**; if it's another restricted scope,
  the CASA assessment scope expands too.
- **Identity change** (name/logo/domain/privacy policy) → update consent screen;
  usually a lighter re-review.
- **Design to reuse the already-granted scopes** so most features never need
  re-verification. (Linking a second Gmail inbox already reuses the same scope
  set — no new verification — see `packages/api/src/mail/gmail.ts`
  `getLinkInboxAuthUrl`.)
