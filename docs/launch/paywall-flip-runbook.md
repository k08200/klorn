# Paywall Flip Runbook

How to turn on monetization. Everything below is already built and merged;
nothing here ships code. The flip is **configuration only**, and every step is
independently reversible.

Current state (verified at HEAD): `PAYWALL_ENABLED` defaults to **off**, so
`isEntitled()` returns true for everyone, the entitlement guards are no-ops,
and all Stripe/RevenueCat surfaces render but cannot complete a purchase.
The only active billing mechanism today is the per-user daily LLM cost cap.

---

## 0. Decisions that must be made BEFORE the flip

| # | Decision | Where it lands |
|---|----------|----------------|
| D1 | **Final price — DECIDED 2026-07-06: founding `$7.99` web / `$9.99` native.** UI copy is consistent across `packages/web/src/app/billing/page.tsx`, `components/paywall-screen.tsx:30`, `components/subscription-section.tsx:30`. The payment provider price/offering must charge exactly these amounts. | Provider dashboard price/offering (UI already aligned) |
| D2 | **Free-tier daily AI budget.** `FREE_DAILY_COST_CAP_CENTS` (default 10¢/day) bounds free-user COGS once the paywall is on. | Render env |
| D3 | **Trial length.** `TRIAL_DAYS` (default 7) drives the Stripe path and the paywall copy; on Paddle the trial lives on the price itself — keep both at 7 days. | Render env + Paddle price |
| D4 | **Web payment provider — DECIDED 2026-07-06: Paddle** (merchant of record — Paddle is the legal seller, so no Korean business registration is needed; individual/sole-trader onboarding with identity verification only). The integration is fully coded and inert until `PADDLE_*` env is set. Stripe code remains as the dormant alternative for a future entity. | Paddle account (founder) + `PADDLE_*` env on Render |

## 1. Provider setup (no user impact — do any time before flip)

**Paddle (web subscriptions — the decided provider)**
1. Sign up at paddle.com as an individual/sole trader (identity + product/domain
   review; approval can take a few days — start early). A sandbox account is
   separate and instant; use it for the end-to-end test first.
2. Create the Pro product + recurring Price at the D1 amount (`$7.99`/mo) with
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
      fires → `user.plan` becomes `PRO` and `paddleCustomerId` is stored →
      portal ("Manage subscription") opens → cancel → plan reverts to `FREE`.
      Webhook idempotency: re-deliver the same event from the Paddle dashboard;
      the `WebhookEvent` table must dedupe it (no double grant).
- [ ] RevenueCat sandbox purchase on a real device → webhook grants plan →
      "Restore purchase" works after app reinstall.
- [ ] UI copy in the three D1 files matches the live Paddle/RevenueCat price.
- [ ] Confirm the admin comp path works as the escape hatch:
      `PATCH /api/admin/users/:id { plan: "PRO" }`.

## 3. The flip

On Render (API service), set — in one deploy:

```
PAYWALL_ENABLED=true
FREE_DAILY_COST_CAP_CENTS=10   # or D2 value
TRIAL_DAYS=7                   # or D3 value
```

What changes at that moment (all code paths already live):
- `isEntitled()` starts returning false for FREE users → `requireEntitled`
  routes (receipts, commitments, email replies, calendar writes) return 403
  `ENTITLEMENT_REQUIRED`; the web app surfaces upgrade UI for them.
- FREE shrinks from the historical feature set to the taster set
  (`FREE_TASTER` in `packages/api/src/stripe.ts`); `multi_account` and other
  `TOOL_FEATURE_MAP` tools gate per plan.
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
