# Serving app.klorn.ai from Cloudflare Pages

Decision (founder, 2026-11-12): move the web app (`packages/web`) off Vercel,
because Vercel Hobby forbids commercial use, onto Cloudflare Pages' free
plan. The landing (`klorn.ai`, `www`) stays on GitHub Pages and the API stays
on Render. **The domain stays `app.klorn.ai`.**

**Status: production. The cutover is complete (2026-11-13).**

- Cloudflare Pages project **`klorn-web`** (`klorn-web.pages.dev`) serves
  `app.klorn.ai`: at Namecheap, the `app` CNAME points to
  `klorn-web.pages.dev.` (it pointed to `cname.vercel-dns.com.` before).
- Every push to `main` deploys to production; build
  `pnpm --filter @klorn/web build:static`, output `packages/web/out`. Preview
  deployments are off.
- Post-cutover checks passed (founder-verified): security headers identical
  to the Vercel origin, routes OK, Google sign-in OK, mobile sign-in OK.
- Vercel is retired but kept as the rollback: the Vercel `klorn-web` project
  was **paused** on 2026-11-14 (Vercel API), and `packages/web/vercel.json`
  sets `git.deploymentEnabled: false`, so no branch builds there any more. The
  Ignored Build Step (`scripts/vercel-ignore-build.mjs`, #1709) went with it;
  it only ever decided whether a Git deployment builds. Both are in git
  history if Vercel is ever brought back. See [Rollback](#6-rollback).

## How it works

The Next server build is no longer Klorn's production, but it stays fully
supported: self-hosters run it (`next start`, `Dockerfile.web`), and it is what
Vercel served until the cutover.

| | Next server build (self-host; Vercel until 2026-11-13) | Cloudflare Pages (production) |
|---|---|---|
| Build | `pnpm build` (Next server build) | `pnpm --filter @klorn/web build:static` → `packages/web/out/` |
| Response headers | `next.config.ts` `headers()` | `packages/web/public/_headers` |
| Redirects | `next.config.ts` `redirects()` | `packages/web/public/_redirects` |
| `/email/<id>`, `/calendar/<id>`, `/email/candidates/<id>` | rendered per request (`page.dynamic.tsx`) | one prerendered shell per route (`page.static.tsx`, id `_`); `_redirects` rewrites every id to it with a `200`, and the page reads the id from the URL (`src/lib/route-param.ts`) |

- `KLORN_STATIC_EXPORT=1` (exactly `1`) switches `next.config.ts` to
  `output: "export"` and drops `headers()`/`redirects()`, which a static site
  cannot run. `build:static` sets it; do not set it in any dashboard.
- `_headers` is the header set the CASA Tier 2 DAST of app.klorn.ai was assessed
  against. `scripts/cloudflare-pages.test.mjs` (CI) fails if `_headers` or
  `_redirects` drift from `next.config.ts`, and `scripts/check-static-export.mjs`
  fails a static build whose own environment would need a different header
  set (for example a different `NEXT_PUBLIC_API_URL`, which changes the CSP
  `connect-src`).
- CI builds the static export on every PR (Build job, step "Web static export
  (Cloudflare Pages)").
- Local check with Cloudflare's own `_headers`/`_redirects` implementation, no
  account needed (wrangler reads both files at startup: restart it after every
  rebuild):

  ```bash
  pnpm --filter @klorn/web build:static
  (cd packages/web && pnpm dlx wrangler@4.48.0 pages dev out --port 8788)
  E2E_STATIC_EXPORT=1 E2E_BASE_URL=http://127.0.0.1:8788 \
    pnpm --filter @klorn/web exec playwright test e2e/static-export-routes.spec.ts
  ```

### Why Pages and not Workers static assets

`dig NS klorn.ai` (2026-11-12) returns `dns1/dns2.registrar-servers.com`: the
zone is on Namecheap DNS, not Cloudflare. `app.klorn.ai` was then a `CNAME` to
`cname.vercel-dns.com`.

- **Pages**: a custom *subdomain* works with DNS left at the current provider —
  "it is not necessary for your site to be a Cloudflare zone"; you add a CNAME
  to `<project>.pages.dev` at your DNS provider
  ([custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/)).
  The cutover is one CNAME edit at Namecheap.
- **Workers**: a Workers Custom Domain requires "an active Cloudflare zone"
  ([Workers custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)),
  i.e. moving klorn.ai's nameservers to Cloudflare and re-creating every
  record (GitHub Pages apex, `www`, `app`, Resend's sending records) first.

Pages needs the fewest founder actions and touches no other record. Moving
the zone (and with it the `klorn.ai` apex) to Cloudflare is a separate,
undecided founder decision.

### Cloudflare limits that apply (documented 2026-11-12)

- `_headers`: max 100 rules, 2,000 characters per line; a splat `*` "will
  greedily match all characters"; a header set by two matching rules is
  joined with a comma; `! Name` detaches a header
  ([headers](https://developers.cloudflare.com/pages/configuration/headers/)).
  We use 36 rules; no path gets the same header twice.
- `_redirects`: "2,000 static redirects and 100 dynamic redirects", 1,000
  characters per line; statuses 301/302/303/307/308, and `200` for proxying,
  which "will only support relative URLs on your site"; "the top-most redirect
  is applied"; redirects "are always followed, regardless of whether or not an
  asset matches" — which is why `/email/candidates` and
  `/email/subscriptions` rewrite to themselves before `/email/:id`
  ([redirects](https://developers.cloudflare.com/pages/configuration/redirects/)).
  We use 12 static and 9 dynamic rules.
- Free plan: 20,000 files per site (the export is ~325), 25 MiB per file
  (largest is the 2.1 MB walkthrough video), 500 builds per month, one
  concurrent build, 20-minute build timeout
  ([limits](https://developers.cloudflare.com/pages/platform/limits/)).

### Known difference: TLS cipher suites

Measured 2026-11-14 with `openssl s_client` (LibreSSL 3.3.6) against
`app.klorn.ai`: TLS 1.0 and 1.1 are refused and TLS 1.2/1.3 negotiate
CHACHA20-POLY1305 by default, but the Cloudflare edge also **accepts TLS 1.2
CBC suites** (`ECDHE-ECDSA-AES128-SHA`, `ECDHE-RSA-AES128-SHA`,
`ECDHE-ECDSA-AES128-SHA256`, `ECDHE-ECDSA-AES256-SHA`, `AES128-SHA`) **and
static-RSA key exchange** (`AES128-SHA`, `AES128-GCM-SHA256`).
`klorn-api.onrender.com` refuses all of those. The header-parity checks do
not cover TLS. Whether the suites can be narrowed for a Pages custom domain
while klorn.ai's DNS stays at Namecheap is not verified.

Recheck:

```bash
for c in ECDHE-RSA-AES128-SHA AES128-SHA AES128-GCM-SHA256; do
  echo | openssl s_client -connect app.klorn.ai:443 -servername app.klorn.ai \
    -tls1_2 -cipher "$c" 2>&1 | grep -E 'Cipher is|alert' | head -1
done
```

## Production setup (as configured at cutover)

This records how `klorn-web` is set up; follow it to rebuild the project from
scratch.

### 1. Cloudflare account and Pages project

1. Create a Cloudflare account (free plan) at https://dash.cloudflare.com/sign-up.
   Turn on 2FA, preferably a hardware security key, and keep yourself the only
   member: anyone who can edit the Pages project can ship JavaScript to
   app.klorn.ai, where the session token lives in `localStorage`.
2. **Workers & Pages → Create → Pages → Connect to Git.** Authorize the
   Cloudflare GitHub app for **only** the `k08200/klorn` repository.
3. Project name: `klorn-web` (gives `klorn-web.pages.dev`). Production
   branch: `main`.

### 2. Build settings

| Setting | Value |
|---|---|
| Framework preset | None |
| Root directory | *(empty — repository root; the pnpm workspace and lockfile live there)* |
| Build command | `pnpm --filter @klorn/web build:static` |
| Build output directory | `packages/web/out` |

Environment variables (Production). The values were copied from Vercel at
the cutover; Cloudflare → `klorn-web` → Settings → Variables and Secrets now
holds them, and is where they change (a `NEXT_PUBLIC_*` change needs a new
deployment: the values are inlined at build time). Names only here:

| Name | Note |
|---|---|
| `NODE_VERSION` | `22` |
| `PNPM_VERSION` | `10.28.2` (root `package.json` `packageManager`) |
| `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN` | Paddle client token |
| `NEXT_PUBLIC_PADDLE_ENV` | Paddle environment |
| `NEXT_PUBLIC_SENTRY_DSN` | if set |
| `NEXT_PUBLIC_REVENUECAT_IOS_KEY` | if set |
| `NEXT_PUBLIC_REVENUECAT_ANDROID_KEY` | if set |
| `NEXT_PUBLIC_NATIVE_OAUTH_SCHEME` | if set |
| `NEXT_PUBLIC_API_URL` | **leave unset** (or exactly `https://klorn-api.onrender.com`). Production's CSP connects to that origin; any other value fails the build on purpose (`check-static-export.mjs`) because `_headers` would need a new CSP. |
| `NEXT_PUBLIC_GOOGLE_DRIVE_PICKER` | **leave unset** — production runs without the Picker, and `_headers` pins the CSP without it. |

Do **not** set `KLORN_STATIC_EXPORT`; the build script sets it. Set nothing
but the `NEXT_PUBLIC_*` values above — no tokens, no `SENTRY_AUTH_TOKEN`; the
static build needs none.

Settings → Builds → Branch control → preview deployments **None** (as set).
Previews are on by default and would build every pushed branch with these
variables; the production deployment is all the check below needs. It also
saves builds (500/month). Optionally limit build watch paths to
`packages/web/*`, `packages/contract/*`, `package.json`, `pnpm-lock.yaml`,
`pnpm-workspace.yaml`.

Save and deploy. The build log must end with the `✓ static export:` lines.

### 3. Check a deployment

Before the cutover this ran against `klorn-web.pages.dev` and compared its
security headers with the Vercel origin; with Vercel paused there is no
second origin, and CI's `scripts/cloudflare-pages.test.mjs` pins `_headers`
to `next.config.ts` instead. Run it against production (or `pages.dev`)
after a change to `_headers`, `_redirects` or the shells:

```bash
NEW=https://app.klorn.ai
SEC='^(content-security-policy|strict-transport-security|x-frame-options|x-content-type-options|referrer-policy|permissions-policy|access-control-allow-origin):'
for p in / /inbox /email/x /settings/accounts /icon-192.png /login; do
  echo "== $p"; curl -sI "$NEW$p" | tr -d '\r' | grep -iE "$SEC" | sort
done
curl -sI "$NEW/inbox" | grep -i '^cache-control'          # private, no-store
curl -sI "$NEW/inbox.txt" | grep -i '^cache-control'      # private, no-store
CHUNK=$(curl -s "$NEW/login" | grep -oE '/_next/static/chunks/[a-z0-9-]+\.js' | head -1)
curl -sI "$NEW$CHUNK" | grep -i '^cache-control'          # public, max-age=31536000, immutable
curl -s -o /dev/null -w '%{http_code}\n' "$NEW/email/abc" # 200 (the email shell)
curl -sI "$NEW/dashboard?a=1" | grep -iE '^(HTTP|location)' # 307, /inbox?a=1
curl -sI "$NEW/email/abc/" | grep -iE '^(HTTP|location)'   # 308, /email/abc
curl -s -o /dev/null -w '%{http_code}\n' "$NEW/nope"      # 404
# Security headers must also be on non-200 responses:
for p in /nope /dashboard /email/abc/ /inbox.txt "$CHUNK"; do
  echo "$p: $(curl -sI "$NEW$p" | grep -ciE '^(content-security-policy|strict-transport-security|x-frame-options):') of 3"
done
curl -sI http://app.klorn.ai/ | grep -iE '^(HTTP|location)'  # a redirect to https
```

Each `cache-control` must be exactly what the comment says — a value joined
with Cloudflare's default (`public, max-age=0, …, private, no-store`) is a
failure. Every line of the last loop must say `3 of 3`.

In the first loop every path must print all seven headers, with the values
`next.config.ts` sets. Differences from the Vercel origin seen before the
cutover, all harmless:

- `vary`: Vercel replaced the configured `Vary: Origin` with Next's own
  `rsc, next-router-state-tree, …`; Cloudflare sends `Vary: Origin`.
- `cache-control` on `/email/<id>`: Vercel sent Next's
  `private, no-cache, no-store, max-age=0, must-revalidate`, Cloudflare the
  configured `private, no-store` — both `no-store`.
- `x-powered-by: Next.js`: Vercel leaked it on per-request routes; Cloudflare
  sends none.

Signing in does **not** work on `pages.dev`, by design: the API's CORS
allowlist is `CORS_ORIGINS` (`render.yaml`, `https://klorn.ai,https://www.klorn.ai,https://app.klorn.ai`)
plus `FIRST_PARTY_ORIGINS` (`packages/api/src/index.ts`). Do not add the
`pages.dev` origin there; it is CASA-assessed surface. Check signed-in flows
on `app.klorn.ai`.

### 4. DNS cutover (done 2026-11-13)

Kept as the record of what was done, and as the procedure for any future
move.

1. A day before: at Namecheap → klorn.ai → Advanced DNS, lower the TTL of the
   `app` CNAME to the minimum (1 min), so both the switch and a rollback take
   effect fast.
2. Cloudflare → the Pages project → **Custom domains → Set up a custom domain**
   → `app.klorn.ai`. Cloudflare says to add a CNAME at your DNS provider. Do
   this step first: Cloudflare warns that adding the CNAME without it "will
   result in your domain failing to resolve" (a 522).
3. Namecheap → Advanced DNS: change the `app` CNAME target from
   `cname.vercel-dns.com.` to `klorn-web.pages.dev.` (your project's
   subdomain). Leave every other record alone.
4. Wait for the custom domain to show **Active** in Cloudflare (certificate
   issued). Until then HTTPS on app.klorn.ai can fail — do it at a quiet hour.
5. Leave `app.klorn.ai` assigned in Vercel for now; it is the rollback (it
   still is: the paused Vercel project keeps the domain).

### 5. After the cutover (done 2026-11-13; all passed)

```bash
dig +short CNAME app.klorn.ai                      # klorn-web.pages.dev.
curl -sI https://app.klorn.ai/ | grep -iE '^(server|cf-ray)'   # server: cloudflare
curl -sI https://app.klorn.ai/ | grep -iE "content-security|strict-transport|x-frame|referrer|permissions"
```

The last command must print the same five lines as before the cutover. Then,
in a browser: sign in with Google; open a mail from a notification
(`/email/<id>`) and refresh it; open a meeting (`/calendar/<id>`); open
Settings from an OAuth return (`/settings?google=…`); open Billing and check
the Paddle checkout overlay renders (CSP); confirm push notifications still
arrive.

Repeat the step 3 checks against `https://app.klorn.ai`, plus
`curl -sI http://app.klorn.ai/` (must redirect to https).

### 6. Rollback

Both steps are needed: while a Vercel project is paused its production
deployment stops serving and visitors get Vercel's error page, so repointing
DNS alone takes production down.

1. **Unpause** the Vercel `klorn-web` project (Vercel dashboard, or the
   Vercel API's `POST /v1/projects/<projectId>/unpause`).
2. Namecheap → Advanced DNS: set the `app` CNAME back to
   `cname.vercel-dns.com.`. The paused project still holds `app.klorn.ai`
   (verified 2026-11-14), so production is back after the TTL. Not verified:
   whether Vercel keeps renewing its certificate while the CNAME points
   elsewhere — after a long time on Cloudflare, expect HTTPS errors until
   Vercel issues a new one.
3. Confirm with `dig +short CNAME app.klorn.ai` and
   `curl -sI https://app.klorn.ai/ | grep -i '^server'` (`Vercel`), and only
   then remove `app.klorn.ai` under the Pages project's custom domains.
   Cloudflare notes that pointing the record away makes the custom domain
   inactive, and pointing it back can show errors until it reactivates.

What Vercel serves after a rollback: its last production deployment, the
`main` build of #1735 (`b358f6dd`, 2026-11-13). Git deployments are off
(`git.deploymentEnabled: false`), so later web commits do not reach it. To
ship them there, revert the `vercel.json` change (restore the Ignored Build
Step and its CI step from the same commit's parent), or deploy from the
Vercel dashboard.

Retire Vercel completely (remove the domain, disconnect Git, delete the
`klorn-web` project, then delete `packages/web/vercel.json`) only once a
rollback to it is no longer wanted. The order rules below apply.

### Never leave a dangling CNAME

`app.klorn.ai` holds signed-in sessions, so whoever serves it can read users'
tokens. If the `app` CNAME points at a project that no longer exists, someone
else may be able to claim that project name or domain and serve their own
code there.

- Never delete or rename the Pages project, or close the Cloudflare account,
  while any DNS record points at `<project>.pages.dev`.
- Never delete the Vercel project while the CNAME points at Vercel, or while a
  rollback to it is still possible.
- Order is always: repoint the CNAME → confirm with `dig` → only then remove
  the domain from, or delete, the project it used to point at.

## OAuth, CORS and other origin checks

The web origin stayed `https://app.klorn.ai`, so nothing that names it
changed:

- **Google OAuth.** The redirect URI is the API's callback
  (`GOOGLE_REDIRECT_URI`, Render dashboard; default
  `…/api/auth/google/callback` in `packages/api/src/mail/gmail.ts`), on the API
  host, not the web host. The API then sends the browser to `WEB_URL`
  (`packages/api/src/auth/social-login.ts`). The authorized JavaScript origins
  and redirect URIs in Google Cloud Console need no change. Apple's callback
  is on the API host too (`APPLE_REDIRECT_URI`, `packages/api/src/auth/apple.ts`)
  and Microsoft's return goes to `WEB_URL`
  (`packages/api/src/routes/outlook-auth.ts`).
- **API CORS.** `CORS_ORIGINS` in `render.yaml` already lists
  `https://app.klorn.ai`; `packages/api/src/index.ts` builds the allowlist
  from it. No change.
- **Web push.** `PUSH_ALLOWED_ORIGINS` / `WEB_URL`
  (`packages/api/src/notify/push-origin-allowlist.ts`): same origin, and the
  service worker keeps its `/sw.js` scope, so existing subscriptions stay
  valid.
- **Paddle.** The approved checkout domain is `app.klorn.ai`; unchanged. The
  CSP still allows `*.paddle.com`.

## Verified vs not yet verified

In production (2026-11-13/14): Cloudflare Pages builds `klorn-web` from
`main` (the "Cloudflare Pages" check on `main` commits); after the cutover
the founder verified identical security headers, routes, Google sign-in and
mobile sign-in on `app.klorn.ai`; `https://app.klorn.ai/` answers `200` with
`server: cloudflare`, and every step 3 check passes there (2026-11-14: all
seven security headers on the six paths, the three `cache-control` values,
the `200`/`307`/`308`/`404` answers, `3 of 3` on the non-200 responses, and
`http://` → `301` to `https://`). The TLS difference above was found after
the cutover.

Verified locally before the cutover (2026-11-12): the static export builds; `wrangler pages dev`
(Cloudflare's own `_headers`/`_redirects` handling) serves every dynamic id
from its shell, keeps `/email/candidates` and `/email/subscriptions`, serves
the `.txt` RSC payloads as `text/plain`, answers the eight redirects with 307
and the query kept, 404s unknown paths, and sends the security headers on the
404, 307 and 308 responses too; deep link, refresh and in-app navigation load
the right id under the real CSP, and in-app navigation remounts the page;
security headers on six paths match live app.klorn.ai.

CI runs the parity test and the static build on every PR, but not the browser
spec (`e2e/static-export-routes.spec.ts`, which needs `wrangler pages dev`):
run it as in "How it works" after any change to the shells.
