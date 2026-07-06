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
| D1 | **Final price.** Three different numbers exist in the repo today: `$29/mo` on the billing page (`packages/web/src/app/billing/page.tsx:46`), founding `$7.99` web / `$9.99` native on the paywall (`packages/web/src/components/paywall-screen.tsx:30`, `subscription-section.tsx:30`), and the 2026-06-29 locked decision of $12 web / $14.99 app. Pick one set; the Stripe Price object and RevenueCat offering must charge exactly what the UI says. | Stripe Dashboard price + the three UI files above |
| D2 | **Free-tier daily AI budget.** `FREE_DAILY_COST_CAP_CENTS` (default 10¢/day) bounds free-user COGS once the paywall is on. | Render env |
| D3 | **Trial length.** `TRIAL_DAYS` (default 7). Stripe checkout and the paywall copy both derive from it. | Render env |

## 1. Provider setup (no user impact — do any time before flip)

**Stripe (web subscriptions)**
1. Create the Pro product + recurring Price in the Stripe Dashboard (live mode).
2. Add a webhook endpoint → `https://<api-host>/api/webhook/stripe`, events:
   `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_failed`.
3. Set on Render (API service):
   - `STRIPE_SECRET_KEY` (live `sk_...`)
   - `STRIPE_WEBHOOK_SECRET` (from the endpoint you just created)
   - `STRIPE_PRO_PRICE_ID` (the live Price id)
4. Recommended: enable Stripe Radar — the checkout reuses an existing customer
   by email to limit trial farming, but `you+1@` sub-addressing bypasses it
   (noted in `routes/billing.ts`).

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

- [ ] `curl -s https://<api-host>/api/billing/status` (authed) returns plan data.
- [ ] Stripe **test-mode** end-to-end once on a staging user: checkout → webhook
      fires → `user.plan` becomes `PRO` → portal cancel → plan reverts to `FREE`.
      Webhook idempotency: re-deliver the same event from the Stripe dashboard;
      the `WebhookEvent` table must dedupe it (no double grant).
- [ ] RevenueCat sandbox purchase on a real device → webhook grants plan →
      "Restore purchase" works after app reinstall.
- [ ] UI copy in the three D1 files matches the live Stripe/RevenueCat price.
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
- [ ] Stripe Dashboard: webhook delivery success rate 100%.

## 5. Rollback

Set `PAYWALL_ENABLED=false` and redeploy. Guards become no-ops again; nobody
loses data. Active Stripe subscriptions keep billing — pause or refund them
from the Stripe Dashboard if the rollback is more than momentary.

## Known limits (accepted, tracked)

- The global daily cost ceiling is in-memory and single-instance; it must move
  to a shared store before scaling out (`cost-guard.ts`).
- Trial farming via email sub-addressing is only mitigated, not blocked
  (Stripe Radar recommended above).
- There is no separate Subscription/Purchase table — `user.plan` synced by
  webhooks is the single source of truth (by design; the `WebhookEvent` table
  provides idempotency).
