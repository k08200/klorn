# Social login activation — Apple, Naver, and the beta gate

Everything below is a **founder action**: it needs the Apple/Naver developer
consoles and the Render environment. The code is already merged and inert —
each provider stays dark until its flag flips, and the routes 404 while dark so
nothing advertises a half-configured flow.

Verify the live state before and after every step:

```bash
curl -s https://klorn-api.onrender.com/api/auth/providers; echo
curl -s https://klorn-api.onrender.com/api/auth/signup-status; echo
```

As of 2026-08-22 those return `{"providers":[{"id":"google"}]}` and
`{"open":false}` — Google only, sign-ups gated.

---

## 1. Beta gate — the decision that gates everything else

`BETA_GATE_ENABLED=true` makes **every** sign-in path refuse to create a new
account without an `APPROVED` Waitlist row: the email register endpoint
(`packages/api/src/routes/auth.ts:403`), the Google callback
(`packages/api/src/routes/auth.ts:1275` → `/login?error=invite_only`), and the
Apple/Naver callbacks (`packages/api/src/auth/social-login.ts:137`). Existing
users always pass through.

Turning it off opens sign-up to anyone:

| Env on Render (`klorn-api`) | Effect |
| --- | --- |
| `BETA_GATE_ENABLED=false` (or removed) | Open sign-up. The login page drops the invite wall on its own — no deploy needed, the page reads `/api/auth/signup-status`. |
| `BETA_GATE_ENABLED=true` | Invite wall. Access request leads, providers move under "Already approved?". |

**The cost of opening it.** The Google OAuth app is *In production, unverified*,
which spends a **lifetime cap of 100 new users** that cannot be reset. The gate
is what has been holding that line. Check the remaining slots in the Google
Cloud console (project `gen-lang-client-0294713076`, number `19950762743`) before
flipping, and watch them after. See `google-oauth-verification.md`.

Flipping the flag is a one-line env change; there is no code to deploy.

---

## 2. Sign in with Apple

### 2a. Apple Developer console

1. **Certificates, Identifiers & Profiles → Identifiers → App IDs** — the app id
   must have the *Sign in with Apple* capability enabled.
2. **Identifiers → Services IDs** — create one (e.g. `ai.klorn.web`). This value
   becomes `APPLE_CLIENT_ID`; it is *not* the bundle id.
3. On that Services ID, configure *Sign in with Apple*:
   - **Domains**: `klorn-api.onrender.com`
   - **Return URLs**: `https://klorn-api.onrender.com/api/auth/apple/callback`

   The Return URL must match `APPLE_REDIRECT_URI` byte for byte — Apple rejects
   a trailing-slash mismatch.
4. **Keys → new key** with *Sign in with Apple* checked. Download the `.p8`
   **once** — Apple never shows it again. Note the Key ID and your Team ID.

### 2b. Render env (`klorn-api`)

| Key | Value |
| --- | --- |
| `APPLE_LOGIN_ENABLED` | `true` |
| `APPLE_CLIENT_ID` | the Services ID, e.g. `ai.klorn.web` |
| `APPLE_TEAM_ID` | 10-character team id |
| `APPLE_KEY_ID` | 10-character key id |
| `APPLE_PRIVATE_KEY` | the full `.p8` PEM. `\n` escapes are accepted, so a single-line value works |
| `APPLE_REDIRECT_URI` | `https://klorn-api.onrender.com/api/auth/apple/callback` |

Apple has no static client secret: the server signs a 5-minute ES256 JWT from
the `.p8` on every token exchange (`packages/api/src/auth/apple.ts`). A wrong
Team ID or Key ID surfaces as `apple_failed`, not as a startup error.

### 2c. Verify

```bash
curl -s https://klorn-api.onrender.com/api/auth/providers
```

Expect `apple` in the list. The login page then renders the Apple row with no
deploy — it reads the same probe. Walk one real sign-in end to end: Apple's
callback is a **POST** (`response_mode=form_post`, mandatory once a scope is
requested), so a proxy that drops POST bodies breaks it silently.

### 2c-bis. Check the deployment's own view first

`/admin` shows a **Social login configuration** card: which variables this
deployment actually has, and whether the Apple key still parses as ES256. Names
and booleans only — it never returns a value.

Reach for it the moment a sign-in returns `apple_config`. A `.p8` pasted into a
field that strips newlines looks, from outside, exactly like a variable that was
never set, and the card separates the two in a glance.

### 2d. When it fails, read the redirect

A failed sign-in lands on `/login?error=<provider>_<stage>`. The stage is the
diagnosis:

| error | what broke | what fixes it |
| --- | --- | --- |
| `apple_denied` | the visitor cancelled at Apple, or Apple sent no code | nothing — they can retry |
| `apple_config` | env missing, or `APPLE_PRIVATE_KEY` is not a usable ES256 key | check the six vars; a truncated `.p8` paste lands here |
| `apple_exchange` | Apple refused the token exchange | the server log carries Apple's slug: `invalid_client` = wrong Team ID / Key ID / key / Services ID (an APNs key looks identical to a Sign in with Apple key); `invalid_grant` = the code, not the secret |
| `apple_token` | the id_token failed verification | usually `aud` — `APPLE_CLIENT_ID` must equal the Services ID byte for byte |
| `apple_claims` | valid token, no email claim | the visitor declined to share an address; they can retry and share |
| `apple_failed` | something else in the tail (DB, session) | server logs |

Apple's own error slug is logged, never redirected — `[APPLE] token exchange
failed: 400 invalid_client` in the service log is the line to grep for.

---

## 3. Naver login

Distinct from the Naver **IMAP mail connect** in `routes/imap-connect.ts` — that
is which mail a user reads, this is who they are.

1. **developers.naver.com → 애플리케이션 등록**, service URL `https://app.klorn.ai`,
   callback `https://klorn-api.onrender.com/api/auth/naver/callback`.
2. Request the **이메일 주소** profile field. The callback rejects an identity
   without a verified email, so an app without it fails every sign-in.

| Key | Value |
| --- | --- |
| `NAVER_LOGIN_ENABLED` | `true` |
| `NAVER_CLIENT_ID` | from the console |
| `NAVER_CLIENT_SECRET` | from the console |
| `NAVER_REDIRECT_URI` | `https://klorn-api.onrender.com/api/auth/naver/callback` |

Verify the same way — `naver` appears in `/api/auth/providers`.

---

## 4. What the login page does with all this

- Google renders **unconditionally**. It is never held hostage to the providers
  probe, so an API outage still leaves a working sign-in button.
- Apple and Naver render only when the probe lists them, and the browser caches
  the last answer (`klorn.auth.providers.v1`, 24h) so a repeat visitor sees the
  full lane on first paint instead of watching it grow.
- The native shell renders **Google only**: Apple and Naver block WebView OAuth
  the same way Google does, and the external-browser relay speaks Google alone
  (`packages/web/src/lib/native/native-auth.ts`). Enabling Apple on the web does
  not put an Apple button in the desktop or mobile shell.
