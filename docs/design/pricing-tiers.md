# Pricing tiers and LLM budgets

Status: **decided** by the founder on 2026-11-08, 2026-11-10 and 2026-11-11.
This file is the canonical record. Code catches up through the PRs listed in
[Implementation order](#implementation-order); until a row says "shipped",
the product still behaves as described in the code, not here.

## Principle

- No user-facing walls. Each plan has an **internal daily LLM target**. The
  product stays inside it by optimization: choosing which work reaches the
  LLM, cheaper prompts, caching, and routing the rest to non-LLM paths.
- Over target, lower-value background work moves to non-LLM paths first, and
  chat steps its model down (Opus → Sonnet → Haiku) instead of refusing.
- An **anomaly brake** at 10× the target stops a runaway loop and alerts.
  It is a bug brake, not a plan limit.
- The global breaker scales with active users
  (3 × the sum of active users' targets + a system allowance). No fixed
  all-users ceiling.
- BYOK is unchanged: calls served on the user's own key cost Klorn nothing
  and are exempt from targets and brakes.

## Individual plans

| | Free | Pro | Higher tier (working name "Max") |
|---|---|---|---|
| Price | $0 | $29.99 / month | $99 / month |
| Internal LLM target | $0.10 / day | $1.00 / day | $3.00 / day |
| Monthly ceiling at target | $3 | $30 | $90 |
| Anomaly brake (10×) | $1 / day | $10 / day | $30 / day |
| Chat models | Haiku 5.5 | Haiku 5.5, Sonnet 5 | adds Opus |
| Autonomous agent | off | on the plan model, runs only on new mail | the chosen model |
| Manual OCR | images only, small daily count | included | included |

## Team (company) plan

The company version exists so a whole company can work together through the
assistant: ask who is free, have it arrange a meeting time, without opening
each teammate's calendar. A company that adopts Klorn also removes the
"admin blocked the app" problem for its people.

| | Standard seat | Premium seat |
|---|---|---|
| Price, monthly billing | $30 / seat / month | $125 / seat / month |
| Price, annual billing | $26 / seat / month ($312 / year) | $100 / seat / month |
| Internal LLM target | $0.80 / seat / day, **pooled** across the team | $3.00 / seat / day, pooled |
| Models | Haiku 5.5, Sonnet 5 | adds Opus |
| Ships | with the team plan | only after the allocator with model step-down works |

- Seats: minimum 2, self-serve maximum 150. Larger organizations go to
  Enterprise ("Contact us").
- Pooled means the team shares (number of seats × seat target); one person
  can use more on a day the others use less.

### Seat entitlement in code (Teams v1.1)

- `effectivePlan` (`packages/api/src/org/effective-tier.ts`) is the one
  resolver every plan gate reads: the user's own plan, raised to TEAM by a
  held paid seat. Its batch form `effectivePlans` serves the schedulers in two
  queries. While `TEAMS_ENABLED` is closed to a user it returns the own plan
  value untouched and runs no query, so every gate answers exactly as before
  seats. A static guard (`effective-tier-wiring-guard.test.ts`) catches the
  common bypasses (a raw `.plan` handed to a gate helper, a raw plan aliased
  outside a resolver call, a gate-calling file that never imports the
  resolver); it is pattern-based, not a type-level proof.
- Access gates use the strict resolver, which throws on a lookup failure
  (fail closed). Displayed plans, the device list and the schedulers use the
  `...OrOwn` variants, which report the failure and keep the own plan. A
  sign-in whose seat lookup fails proceeds but evicts no device that time.
- A seat holder carries `PLANS.TEAM`'s limits (device count, message and
  token allowances) wherever the code reads plan limits.
- Pooled LLM cap (`billing/team-cost-pool.ts`): a seat holder may spend
  purchased seats × `TEAM_SEAT_DAILY_COST_CAP_CENTS` (default 80¢) minus
  today's spend by the organization's other seated members, each counted as
  at least half a seat target (so one member cannot drain the others down to
  their own-plan caps), bounded per member at 10× the seat target (the
  anomaly brake), and never less than their own plan's cap. Unfilled paid
  seats feed the pool; a member removed mid-day drops out of the sum. The sum
  reads cost cents only, re-read at most every 30 s per user.
- Before large organizations: `GLOBAL_DAILY_COST_CAP_CENTS` (default 5000¢)
  is below one 150-seat pool (12000¢); raise it or add a per-organization
  share before enabling teams of that size.

### Personal Pro and a team seat

*Default chosen on the founder's behalf on 2026-11-14 (Teams v1.1). Not
LOCKED: pending founder confirmation, reversible — change it here and in
`seatCoversPersonalPlan`.*

- Entitlement is the higher of the two: TEAM. The LLM cap is the higher of
  the personal cap and the pool's remainder.
- Klorn never cancels the personal subscription by itself. A cancel is a
  money action, and the seat can lapse (the organization stops paying, or the
  member is removed), which would leave the user without the plan they paid
  for.
- Not silent: while a live personal Paddle Pro still renews (active or
  trialing, no cancel scheduled), `/me` and `/api/billing/status` carry
  `teamSeatCoversPersonalPlan: true`, and Settings → Billing says the seat
  already covers Pro next to the personal cancel. Only the Paddle path stores
  renewal state, so a Stripe or App Store / Play subscriber with a seat is
  not detected (no notice) — a known gap. That cancel is the existing one: Paddle in-app cancel at the end of
  the billing period (`POST /api/billing/cancel`, undo with
  `POST /api/billing/resume`); Stripe customers use the portal; App Store and
  Google Play subscriptions are managed in the store.
- No automatic refund or proration of the personal plan.

### Launch features

1. Organization, members, invites. No organization role is named `ADMIN`
   (that name already means a Klorn operator in `User.role`).
2. Seat entitlement is derived from membership at read time. It is never
   written to `User.plan`, which three billing providers already write.
3. Team scheduling assistant: "who is free when", and arranging a meeting
   time. Free/busy only, per-member grant, default off
   (`docs/design/team-mode-v3.md`).
4. Admin onboarding guide and detection of an admin policy that blocks the
   app (Google Workspace app allow-list, Microsoft 365 admin consent).
5. Admin ceilings: turn off auto-reply and cap agent mode for members.
6. Organization company domains, pushed to every member.
7. Audit log of admin actions and cross-member free/busy reads.
8. Member transparency screen: what the company can and cannot see.

### Seat changes, cancel and the billing portal

Owner only (`src/org/seat-management.ts`); members are refused. Paddle is the
source of truth: no route writes the stored seat count or status, the
subscription webhook does.

- **Seat changes** set the quantity to N (2–150, never below the current
  members). Billed `prorated_immediately` in both directions: an added seat is
  charged for the rest of the current period, a removed seat is credited to
  the customer's Paddle balance for the next renewal. The other modes charge
  for days a seat was not held, leave seats unbilled until the renewal, or
  never bill them. The change keeps the subscription's own price (never the
  newest configured one, which would move the team to it without notice), and
  a failed proration charge leaves the subscription unchanged
  (`on_payment_failure: prevent_change`). The request is compared with what
  Paddle bills now, not the stored count, so asking for the count Paddle
  already holds makes no change. Only while active or trialing with nothing
  scheduled: Paddle refuses updates to a past-due subscription.
- **The owner is the billing admin.** Any owner, including one who took over
  by transfer, can change seats or cancel on the payment method already on the
  subscription; Paddle emails the payer a receipt for every prorated charge.
- **Cancel** is at the period end only, like Pro: seats stay until Paddle's
  final event. A past-due subscription can be canceled this way and stays
  past due until the period ends; a paused one can only be ended immediately,
  which is left to the portal. A scheduled cancel can be taken back, past due
  included (removing a scheduled change is the one update Paddle allows
  there). An organization whose subscription still bills (active, trialing,
  past due, paused) is never closed or deleted.
- **Billing portal** opens only while the subscription bills, and only for an
  owner whose verified Klorn email is the Paddle customer's email. The portal
  is the payer's whole Paddle account (other subscriptions, invoices,
  address): a later owner, or an owner who paid from another address, is
  refused, and the payer still has the portal link in Paddle's receipt emails.

### Later

- Organization VIP domains, only as a relationship signal into the judge.
  Never a forced PUSH pin: pins skip the phishing and first-contact floors,
  so a spoofed VIP sender would alert every member at once.
- Spoofing warnings for the company domain, per member only.
- Shared reply tone and templates (needs a trust design: admin text must not
  flow into members' prompts unchecked).
- Model policy, retention period, verified-domain auto-join, SSO/SCIM,
  organization BYOK (members must be told the key owner can see provider
  logs).
- Admin metrics limited to seat activity and cost. No metrics derived from
  members' mail (Google API Limited Use).

### Not doing (privacy invariants, `team-mode-v3.md`)

No shared inbox, delegated sending, cross-member mail search, organization
dossiers, or admin access to members' mail. Changing this needs a new founder
decision and a privacy-policy review.

## Margins at the ceiling

Paddle fee taken as 5% + $0.50 per transaction (for monthly team seats the
$0.50 is counted per seat, which overstates it for multi-seat invoices);
ceiling = target × 30 days; LLM only (no hosting or support costs). Real usage is far below the ceiling,
so these rows are the worst case, not the expectation.

| Product | Net to Klorn / month | LLM ceiling / month | Worst-case margin |
|---|---|---|---|
| Pro, $29.99 monthly | $27.99 | $30 | −$2.01 |
| Max, $99 monthly | $93.55 | $90 | +$3.55 |
| Team standard, $30 monthly | ≈ $28.00 | $24 | +$4.00 |
| Team standard, $26 annual | ≈ $24.66 | $24 | +$0.66 |
| Team premium, $125 monthly | ≈ $118.25 | $90 | +$28.25 |
| Team premium, $100 annual | ≈ $94.96 | $90 | +$4.96 |

Annual billing is offered for team seats only. A pooled $0.80 seat target is
what makes the annual discount break even; Pro's $1 individual target would
not (break-even would be $31.62 / month, above the monthly price).

## Cost basis (estimates, Claude Haiku 5.5 at $0.10 / $0.50 per M tokens)

- Per incoming email: judge ≈ $0.0003, automatic summary ≈ $0.00035,
  attachment analysis ≈ $0.0004–0.0007 per readable attachment.
- Opening an email (thread brief, sender dossier, summary): ≈ $0.0004–0.001.
- Chat message: ≈ $0.0002 short, ≈ $0.0009 with a tool, ≈ $0.018 for a long
  three-round turn on Haiku; ≈ 40–50× that on Opus.
- The daily briefing is the largest fixed per-user cost and today runs even
  without new mail.
- Typical user (≈50 emails, 10 chat messages a day): ≈ $0.08 / day.

## Implementation order

| Step | Work | Status |
|---|---|---|
| PR2 | Per-user fair background queue (#1660) | open |
| PR3 | Low-risk cuts: summary lane filter, no re-judge on read, briefing cap, trait job, attachments, OCR re-run | not started |
| PR1 | Per-feature cost measurement (`LlmUsageLog.feature`, actual cost) | not started |
| Gating | Chat models and agent by plan (flag off by default) | not started |
| PR4 | Judge unit cost: bulk prefilter, template cache, cacheable prompt (judge gate required) | not started |
| PR5 | Allocator replacing walls, model step-down (flag off) | not started |
| PR6 | Scaling breaker, rate-limit handling, concurrent scheduler | not started |
| Team | Org/seat schema → seat billing → scheduling assistant → admin features | after launch and after C2 (unified plan P1) |

## Copy rules

- Do not claim "it stops rather than overspends" or a per-person cap; the
  public wording is "daily AI budget per plan — a runaway loop is stopped,
  not billed".
- Team prices go on the public site only after seat price constants and the
  price-consistency guard cover them (the Pro price drifted across pages
  before the guard existed).
