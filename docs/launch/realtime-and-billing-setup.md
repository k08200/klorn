# Realtime mail push + Paddle billing — operator setup (2026-08-10)

Two founder-only setup jobs the code cannot do for itself. Both are
prerequisites for launch claims: "mail appears the second it arrives" and
"$29.99/mo".

## 1. Gmail realtime push (Pub/Sub)

**Current state, verified 2026-08-10:** `GMAIL_PUSH_TOKEN` is not set in
Render, so `POST /api/gmail/push` answers `503 { error: "Gmail push not
configured" }` to every delivery (`routes/gmail-push.ts` refuses when both
`GMAIL_PUSH_TOKEN` and `GMAIL_PUSH_OIDC_EMAIL` are absent). Watches are
registered and renewed, but nothing can be delivered — realtime has never
worked. Without it the floor is the poll cadence (~60 s), not one second.

Pick ONE auth mode — **whichever the subscription already uses**. Checked
2026-08-10: the live `gmail-push-sub` has "Enable authentication" ON with a
service account, i.e. it signs OIDC tokens. For that subscription the shared
secret can never match (Pub/Sub sends a Google-signed JWT, not your string) —
Mode B is the one to configure.

**Client-side audit 2026-08-18 (#1131):** the wake chain is now code-complete
on every surface — firewall board listens to `conversations-updated` (was the
one surface on a 45s poll), web WS has half-open heartbeat detection (ported
from the desktop client), on-read activity sync wakes other open clients, and
the desktop socket re-arms on token rotation instead of 4001-looping. The ONLY
remaining step for "mail in ~1s" on the mail list is this section's env setup
(`GMAIL_PUSH_OIDC_EMAIL` + `GMAIL_PUSH_OIDC_AUDIENCE`, Mode B). Two honest
caveats: the firewall/desktop QUEUE floor is judge LLM latency plus a ≤2s
wake coalesce — a few seconds, not one; and on the free dyno, sleep drops both
Pub/Sub deliveries and every WebSocket regardless (`KEEPALIVE_URL` or a paid
tier is load-bearing).

### Mode A — shared secret (fastest)

1. Generate a secret: `openssl rand -hex 32`.
2. Render → klorn-api → Environment → add `GMAIL_PUSH_TOKEN` = that value.
   (The key is already declared `sync: false` in `render.yaml`, so a
   blueprint sync cannot prune it.)
3. Google Cloud → Pub/Sub → the topic in `GMAIL_PUBSUB_TOPIC` → its push
   subscription → endpoint
   `https://klorn-api.onrender.com/api/gmail/push`, and add the header
   `Authorization: Bearer <the same secret>`.

### Mode B — Google OIDC (what the live subscription uses)

1. Pub/Sub → the push subscription → **Edit**. Note the **service account**
   under "Enable authentication", and set **Audience** explicitly to
   `https://klorn-api.onrender.com/api/gmail/push` (leaving it blank makes
   the audience implicit, and the server refuses to verify without a
   configured audience — it fails closed on purpose so any Google-signed
   token cannot be replayed).
2. Render → klorn-api → Environment:
   - `GMAIL_PUSH_OIDC_EMAIL` = that service account's full email
   - `GMAIL_PUSH_OIDC_AUDIENCE` = `https://klorn-api.onrender.com/api/gmail/push`
   Both are already declared `sync: false` in `render.yaml`.
3. Do NOT set `GMAIL_PUSH_TOKEN` alongside it — when the OIDC email is
   present the server takes the OIDC path exclusively.

### Verify

- Send yourself a mail; it should land in Klorn within a second or two.
- Render logs: a `[GMAIL-PUSH]` line per delivery, no 401/503.
- `GET /api/ops/readiness` (authed) → `google.detail.gmailPushEnabled: true`.

### Independent of push

`GET /api/inbox/firewall` now fires a debounced (60 s) mail sync on every
call, so opening any client always pulls — push turns "within a minute" into
"immediately", it is no longer the only path.

## 2. Paddle billing at $29.99/mo

Payment provider is **Paddle** (not Stripe) — `billing/paddle.ts`,
`routes/webhook.ts`. Paddle confirmed 2026-08-10 that a **sole trader /
individual** can sign up; no company registration required. Verification is
domain review → identity verification → final review.

Founder steps:

1. Sign up as sole trader; submit `klorn.ai` for domain review. Have the
   legal pages reachable from the landing (terms, privacy, refund) — domain
   review checks them.
2. Create the product + a **$29.99/mo** price. Copy the price id.
3. Render → klorn-api → `PADDLE_API_KEY`, `PADDLE_PRO_PRICE_ID`,
   `PADDLE_WEBHOOK_SECRET`, `PADDLE_ENV` (`sandbox` first, then
   `production`).
4. Paddle → Notifications → webhook to
   `https://klorn-api.onrender.com/api/webhook/paddle`, signed with the same
   secret.
5. Sandbox end-to-end: checkout → webhook → `User.plan` flips to PRO →
   entitlement-gated features open. Only then switch `PADDLE_ENV`.
6. Flip `PAYWALL_ENABLED=true` as a **separate, deliberate** decision
   (`docs/launch/paywall-flip-runbook.md`). Until it flips, the request gates
   (`requireEntitled`) are inert and multi-inbox stays free; plan-level
   features already follow `user.plan`, and since 2026-10-24 every signup
   starts on FREE.

The landing already says $29.99/mo with a 7-day trial (all 7 locales). Keep the
price string, the Paddle price, and `TRIAL_DAYS` in sync — three places,
one number.
