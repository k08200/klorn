# Paywall Flip Runbook

How to turn on monetization. Everything below is already built and merged;
nothing here ships code. The flip is **configuration only**, and every step is
independently reversible.

Current state (verified live 2026-07-20): `PAYWALL_ENABLED` is **off**, so
`isEntitled()` returns true for everyone and the entitlement guards are no-ops.
Additionally `BETA_AUTO_PRO_ENABLED=true`, so the first `BETA_AUTO_PRO_LIMIT`
(default 50) signups are silently granted PRO (`betaProGrantedAt` set) — this
is why a brand-new account already shows plan `PRO` with no payment. The Paddle
web pipeline is fully wired and sandbox-verified (see §2a); the only reason no
one is paying yet is that everyone is auto-PRO. The other active billing
mechanism is the per-user daily LLM cost cap.

---

## 0. Decisions that must be made BEFORE the flip

| # | Decision | Where it lands |
|---|----------|----------------|
| D1 | **Final price — RAISED 2026-10-14: `$29.99` web / `$34.99` native** (was `$8.99`/`$9.99`, live-verified 2026-08-22). The web number's single source of truth is `packages/web/src/lib/pricing.ts` (`PRO_PRICE_WEB`); quote it from there, never inline. UI copy reads it from `pricing.ts`. The payment provider price/offering must charge exactly these amounts. | Provider dashboard price/offering (UI already aligned) |
| D2 | **Free-tier daily AI budget.** `FREE_DAILY_COST_CAP_CENTS` (default 10¢/day) bounds free-user COGS once the paywall is on. | Render env |
| D3 | **Trial length.** `TRIAL_DAYS` (default 7) drives the Stripe path and the paywall copy; on Paddle the trial lives on the price itself — keep both at 7 days. | Render env + Paddle price |
| D4 | **Web payment provider — DECIDED 2026-07-06: Paddle** (merchant of record — Paddle is the legal seller, so no Korean business registration is needed; individual/sole-trader onboarding with identity verification only). The integration is fully coded and inert until `PADDLE_*` env is set. Stripe code remains as the dormant alternative for a future entity. | Paddle account (founder) + `PADDLE_*` env on Render |

## 1. Provider setup (no user impact — do any time before flip)

**Paddle (web subscriptions — the decided provider)**
1. Sign up at paddle.com as an individual/sole trader (identity + product/domain
   review; approval can take a few days — start early). A sandbox account is
   separate and instant; use it for the end-to-end test first.
2. Create the Pro product + recurring Price at the D1 amount (`$29.99`/mo) with
   a **7-day trial configured on the price** (the code does not pass a trial —
   Paddle applies the price's own trial).
3. Checkout settings → set the **default payment link** domain (app.klorn.ai).
   Without it Paddle returns no checkout URL and `/api/billing/checkout` fails
   loud with a message saying exactly this.
4. Add a notification (webhook) endpoint → `https://<api-host>/api/webhook/paddle`
   subscribed to `subscription.*` and `transaction.payment_failed`, and copy
   its secret.
5. Set on Render (API service):
   - `PADDLE_API_KEY` (Developer tools → Authentication)
   - `PADDLE_WEBHOOK_SECRET` (from step 4)
   - `PADDLE_PRO_PRICE_ID` (the `pri_…` id from step 2)
   - `PADDLE_ENV=sandbox` while testing against sandbox; **remove it** for live.
6. The moment `PADDLE_API_KEY` + `PADDLE_PRO_PRICE_ID` are set, the web
   subscribe buttons come alive automatically (`webCheckoutAvailable` flips)
   and `/api/billing/checkout` returns Paddle checkout URLs. No web deploy needed.

**Payment methods at checkout (why KakaoPay / Pix / Alipay do not appear)**

Nothing in this repo selects payment methods. The checkout overlay is opened by
Paddle itself from the `_ptxn` default-payment-link URL, not by a
`Paddle.Checkout.open()` call, so `allowedPaymentMethods` is not passed and
cannot be — the list is 100% dashboard- and context-driven. Paddle decides what
to show from three things: **the transaction currency, the customer's country,
and their device.**

That is the whole explanation for "we enabled them and they never show up".
Ticking a method in `Paddle → Checkout → Checkout settings → General` only makes
it *eligible*; it still has to match the currency and country of the buyer:

| Method | Shows only when | Recurring? |
|---|---|---|
| Card, PayPal | almost everywhere | yes |
| Apple Pay / Google Pay | compatible device + browser (no India) | yes |
| KakaoPay, Naver Pay | price is in **KRW** and the customer address is in **South Korea** | yes |
| Pix | **BRL** / Brazil | yes |
| iDEAL | **EUR** / Netherlands | yes |
| Bancontact | **EUR** / Belgium | yes |
| BLIK | **PLN** / Poland | yes |
| MB WAY | **EUR** / Portugal | yes |
| Alipay, WeChat Pay | regional, and **Alipay needs separate Paddle approval** | yes |

The PRO price is configured in **USD only**. A Korean buyer is therefore quoted
USD, and because the item is not priced in KRW, KakaoPay and Naver Pay are
*never* eligible for them — no matter how the dashboard checkboxes are set. Same
for Pix (BRL), iDEAL/Bancontact/MB WAY (EUR), BLIK (PLN).

To actually surface them (founder action, dashboard only — no code change):

1. `Paddle → Checkout → Checkout settings → General` — confirm each wanted
   method is ticked, and request approval for Alipay if it is wanted.
2. Turn on **automatic currency conversion** (localized pricing) for the
   account, or add explicit local-currency unit prices (KRW, BRL, EUR, PLN) to
   the PRO price `pri_…`. This is the step that was missing: without a local
   currency there is no local payment method.
3. Re-test from the target country (or with a billing address in it) — the
   method list is computed per buyer, so a Korean address on a USD-only price
   will keep showing only card/PayPal/wallets.

Sanity check before blaming the code: `Paddle.PricePreview()` /
`POST /transactions/preview` return `available_payment_methods` for a given
country + currency. If a method is absent there, it is a Paddle configuration
issue and no app change will fix it.

**Stripe (dormant alternative — only with a future business entity)**
1. Create the Pro Price, webhook endpoint (`/api/webhook/stripe`, events:
   `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_failed`), then set
   `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PRO_PRICE_ID`.
   Note: Paddle takes precedence at checkout when both are configured.

**RevenueCat (iOS/Android IAP)**
1. Create the RevenueCat project, attach the App Store / Play apps, and create
   the offering matching D1 pricing (with the intro offer mirroring `TRIAL_DAYS`).
2. Add a webhook → `https://<api-host>/api/webhook/revenuecat` with a generated
   shared secret in the Authorization header.
3. Set `REVENUECAT_WEBHOOK_AUTH` (same secret) on Render.
4. Set `NEXT_PUBLIC_REVENUECAT_IOS_KEY` / `NEXT_PUBLIC_REVENUECAT_ANDROID_KEY`
   (public SDK keys) on Vercel. Until these exist, native shows
   "Subscription coming soon" — that is expected pre-flip behavior.

## 2. Pre-flip verification (still with paywall off)

- [ ] `curl -s https://<api-host>/api/billing/status` (authed) returns plan data
      with `webCheckoutAvailable: true` once `PADDLE_*` is set.
- [ ] Paddle **sandbox** end-to-end once on a staging user: checkout → webhook
      fires → `user.plan` becomes `PRO`, and `paddleCustomerId`,
      `paddleSubscriptionId`, `subscriptionStatus`, `subscriptionRenewsAt` are
      all stored → portal ("Manage subscription") opens.
      Webhook idempotency: re-deliver the same event from the Paddle dashboard;
      the `WebhookEvent` table must dedupe it (no double grant).
- [ ] In-app cancel round trip on that same user:
      `POST /api/billing/cancel` → Paddle shows a `scheduled_change: cancel`
      → `/billing` shows "Cancelled · Pro stays active until <date>" and the
      plan is **still PRO** → `POST /api/billing/cancel/undo` → the scheduled
      change is gone and the renewal date is back. Then let a cancel run to its
      effective date (or cancel immediately from the Paddle dashboard) and
      confirm the terminal `subscription.canceled` webhook drops the plan to
      `FREE` and clears `paddleSubscriptionId`.
- [ ] **Cancel while `trialing`** — this is the most common real cancellation
      and the one path Paddle's docs do not spell out. We always send
      `effective_from: next_billing_period`; for a trialing subscription that
      boundary is the trial end, so the expected result is a `scheduled_change`
      at the trial end date and **no charge**. Verify in sandbox that the call
      returns 2xx (not a 4xx rejecting `next_billing_period` for trials) and
      that no transaction is billed afterwards. If Paddle does reject it, the
      user sees "Could not cancel the subscription" — fix before the flip.
- [ ] RevenueCat sandbox purchase on a real device → webhook grants plan →
      "Restore purchase" works after app reinstall.
- [ ] UI copy in the three D1 files matches the live Paddle/RevenueCat price.
- [ ] Confirm the admin comp path works as the escape hatch:
      `PATCH /api/admin/users/:id { plan: "PRO" }`.

## 2a. Sandbox status — DONE & VERIFIED 2026-07-20

The Paddle **sandbox** pipeline is set up and end-to-end verified except the
final real-card round-trip (covered by 11 unit tests in
`routes-webhook-paddle.test.ts`):

- Paddle sandbox product **Klorn Pro** + monthly price with a 7-day trial created.
- Render (API) env set: `PADDLE_API_KEY`, `PADDLE_PRO_PRICE_ID` (`pri_…`),
  `PADDLE_WEBHOOK_SECRET`, `PADDLE_ENV=sandbox`.
- Vercel (web) env set: `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN` (`test_…`),
  `NEXT_PUBLIC_PADDLE_ENV=sandbox`, `NEXT_PUBLIC_NATIVE_OAUTH_SCHEME=ai.klorn.app`.
- Verified: `/api/billing/checkout` returns a `?_ptxn=` URL; the billing page's
  Paddle.js loader opens the hosted checkout overlay showing "7-day free trial";
  webhook signature gate rejects unsigned posts (401).
- Four web blockers found & fixed while dogfooding this: `safeRedirect` allowing
  paddle.com (#923), null-limit billing-page crash (#924), the missing Paddle.js
  loader + CSP (#925), and `/billing` being unreachable before Google connect (#926).

**To go LIVE, redo the provider setup (§1) against the *live* Paddle account**
(separate from sandbox): new live product/price, live API key, live webhook
secret, live client token. Then swap env: on Render **remove** `PADDLE_ENV`
(or set it non-sandbox) and replace the three `PADDLE_*` values with live ones;
on Vercel set `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN` to the `live_…` token and
`NEXT_PUBLIC_PADDLE_ENV=production`, then redeploy the web project (public env
is inlined at build time — an env change alone does nothing until a redeploy).

## 3. The flip

On Render (API service), set — in one deploy:

```
PAYWALL_ENABLED=true
FREE_DAILY_COST_CAP_CENTS=10   # or D2 value
TRIAL_DAYS=7                   # or D3 value
# Decide the beta-auto-PRO fate at the same time:
#   BETA_AUTO_PRO_ENABLED=false   → new signups must pay from day one, OR
#   leave it on with BETA_AUTO_PRO_LIMIT=50 → first 50 stay free, #51+ pays.
```

Note: the paywall (`isEntitled`) and beta-auto-PRO are independent switches.
If you flip `PAYWALL_ENABLED=true` but leave `BETA_AUTO_PRO_ENABLED=true` with
room under the limit, new users are still auto-granted PRO and won't see the
paywall — so to actually collect money from new signups, set
`BETA_AUTO_PRO_ENABLED=false` (or confirm the limit is already reached).

What changes at that moment (all code paths already live):
- `isEntitled()` starts returning false for FREE users → `requireEntitled`
  routes (receipts, commitments, email replies, calendar writes) return 403
  `ENTITLEMENT_REQUIRED`; the web app surfaces upgrade UI for them.
- FREE shrinks from the historical feature set to the taster set
  (`FREE_TASTER` in `packages/api/src/stripe.ts`); `multi_account` and other
  `TOOL_FEATURE_MAP` tools gate per plan.
- Mail accounts: a FREE user may connect ONE mail account of any provider
  (their first); a second one answers 403 `ENTITLEMENT_REQUIRED`
  (`billing/mail-account-entitlement.ts`, founder decision 2026-10-15).
- Free users' daily LLM cap drops from `DAILY_COST_CAP_CENTS` (100¢) to
  `FREE_DAILY_COST_CAP_CENTS`; on cap they now get the **upgrade nudge**
  message instead of the BYOK-only one.
- Existing beta users keep access only via `betaProGrantedAt` / admin-set
  plan — decide beforehand who gets comped.

## 4. Post-flip smoke (first hour)

- [ ] Fresh FREE account: core read surfaces (inbox, attention queue, briefing)
      still work; a gated action (e.g. calendar write) shows the upgrade path,
      not an error page.
- [ ] Live checkout with a real card (refund after): plan flips to PRO within
      seconds of the webhook; gated routes open without re-login
      (`/api/auth/me` returns `entitled: true`).
- [ ] Burn the free cap on a test account (or set `FREE_DAILY_COST_CAP_CENTS=1`
      on staging): chat surfaces the upgrade-nudge message.
- [ ] Watch Render logs for `ENTITLEMENT_REQUIRED` spikes from surfaces that
      should be free — that means a guard is mis-scoped; comp affected users
      and fix before wider announcement.
- [ ] Paddle Dashboard → Notifications: webhook delivery success rate 100%.

## 5. Rollback

Set `PAYWALL_ENABLED=false` and redeploy. Guards become no-ops again; nobody
loses data. Active Paddle subscriptions keep billing — pause or refund them
from the Paddle Dashboard if the rollback is more than momentary.

## Known limits (accepted, tracked)

- The global daily cost ceiling is in-memory and single-instance; it must move
  to a shared store before scaling out (`cost-guard.ts`).
- Trial farming via email sub-addressing is only mitigated, not blocked
  on the Stripe path (Radar), and on Paddle bounded by Paddle's own risk
  checks — monitor trial-abuse patterns after launch.
- There is no separate Subscription/Purchase table — `user.plan` synced by
  webhooks is the single source of truth (by design; the `WebhookEvent` table
  provides idempotency).
