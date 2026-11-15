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
- Global ceiling (`billing/global-cost-ceiling.ts`): until the scaling
  breaker (PR6) is built, `GLOBAL_DAILY_COST_CAP_CENTS` (default 5000¢) stays
  the base for everyone else, and every purchased seat of an organization
  whose subscription bears seats (active, trialing) adds 3 × the seat target
  — the breaker formula above, applied to seats. A 150-seat team raises the
  ceiling by 36000¢, so its pool (12000¢) always fits under it. The seat sum is
  re-read at most once a minute; a failed read keeps the last value (or the
  base when there is none), and the share is never negative. With
  `TEAMS_ENABLED` off the ceiling is the base exactly and nothing is queried;
  in cohort mode only organizations with a cohort member count.

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
- **The payer.** The team checkout names its buyer (the owner who opened it)
  in Paddle's custom data as `payerUserId` — never `userId`, the key the Pro
  webhook maps to an account. The webhook stores it as
  `Organization.payerUserId` only from this organization's own checkout
  (`custom_data.orgId` matches) and only while that user is an owner: when a
  subscription first attaches, or when the attached one has no payer yet. A
  later event never moves it; a canceled subscription, subscription drift and
  the payer's account deletion clear it. For a seat increase or a resume
  (both billed to the subscription's own payment method) the payer check
  passes for the recorded payer while they are still an owner, and otherwise
  for the owner whose verified Klorn email is the Paddle customer's email —
  so a buyer who paid with a work address still passes, and an organization
  that subscribed before payers were recorded keeps working. The audit row
  says which (`payer: "recorded" | "email"`).
- **A recorded payer without the paying email is capped.** *Decided by
  recommendation on 2026-11-15 (founder: "follow my recommendations"); not
  LOCKED, reversible — change `RECORDED_PAYER_MAX_STEP` /
  `RECORDED_PAYER_MAX_MULTIPLE` in `src/org/seat-cap.ts` and this
  paragraph.* The recorded payer is the owner who opened the checkout, not
  necessarily the card holder: if that owner forwarded the checkout link and
  someone else paid, the owner could otherwise add seats on that person's
  card. So when the payer check passes on the recorded payer alone (their
  verified Klorn email is not the Paddle customer's), one request sets at most
  **the smaller of Paddle's live count + 10 and 2× the seat count the
  subscription attached with** (`Organization.seatsAtAttach`, the checkout's
  count, written by the webhook when the subscription attaches; never moved by
  a later event; cleared when it ends or drifts). Why these numbers: the card
  holder agreed to the attach count at checkout, so 2× bounds what the card
  can be charged without them to doubling that agreement, however many
  requests are made; +10 per request lets a normal hiring wave through without
  the payer while stopping a jump straight to 150 (at the $30 monthly seat
  price, at most $300/month more per request; on the annual plan the prorated
  charge for 10 seats can reach ~$3,100 at once, still within 2×). The cap is
  checked against the live count, never the stored one, and Paddle emails the
  card holder a receipt for every charge. When the recorded payer's verified
  email is also Paddle's (checked only for a request over the cap), there is
  no cap beyond 2–150 (`payer: "email"` in the audit row). A subscription
  attached before the count was recorded has none, and then a recorded payer
  without the paying email adds no seats (the paying email still can). Over
  the cap answers 403 `SEATS_INCREASE_CAPPED`, audited as
  `billing.seats_increase_refused` with reason `recorded_payer_cap` and the
  counts (`from`, `to`, `cap`) — never an email.
  Prefilling the checkout email is not done: Paddle takes it only as an
  existing customer on the transaction or through Paddle.js on the payment
  page.
- **Adding seats is the payer's.** It charges the card on file at once
  (prorated). Any other owner, including one who took over by transfer, gets
  `SEATS_INCREASE_PAYER_ONLY` and is told to ask the payer. Removing seats and
  the period-end cancel stay open to any owner: both lower or end the charge,
  and the member floor still holds. Paddle emails the payer a receipt for
  every prorated charge.
- **A portal cancel cannot race a seat change.** Paddle refuses any update
  while a scheduled change is pending (`subscription_locked_pending_changes`),
  so a cancel made in the portal after the live read is caught by the seat
  change call itself and answered `CANCEL_SCHEDULED`, with no audit row.
- **A stale live read is refused.** Whether a request is an increase is
  decided from the live quantity read before the org lock. Under the lock, a
  seat change committed since that read (its audit row commits with its
  Paddle call) answers `SEATS_CHANGED`, so two concurrent decreases by a
  non-payer cannot add up to an unchecked increase.
- **Audit.** Every allowed change is `billing.seats_change_requested`; a
  refused payer check is `billing.seats_increase_refused`,
  `billing.resume_refused` or `billing.portal_refused`, with the reason class
  only (`not_payer`,
  `email_not_verified`, `no_payer_email`, `no_payer_on_record`,
  `recorded_payer_cap`, `recorded_payer_portal_cancel`) — never an email or
  card detail.
- **Cancel** is at the period end only, like Pro: seats stay until Paddle's
  final event. A past-due subscription can be canceled this way and stays
  past due until the period ends; a paused one can only be ended immediately,
  which is left to the portal. A scheduled cancel can be taken back, past due
  included (removing a scheduled change is the one update Paddle allows
  there), by the payer (`RESUME_PAYER_ONLY` for anyone else): it restarts
  billing on the payer's card. An organization whose subscription still bills
  (active, trialing, past due, paused) is never closed or deleted.
- **A portal cancel takes the paying email to undo.** *Decided by
  recommendation on 2026-11-15 (security review of this change); not LOCKED,
  reversible — `resumeBasis` in `src/org/seat-management.ts`.* Only the paying
  email reaches Paddle's portal (or its receipt link), so a cancel made there
  is the Paddle customer's own decision, and the recorded payer may not be
  that person. The recorded payer alone may take back a cancel scheduled
  through Klorn (re-checked under the lock: that Klorn cancel must still be
  the pending one); a cancel with no Klorn actor needs the verified email to
  match Paddle's customer, recorded payer or not. Refused as
  `RESUME_PAYER_ONLY`, audited `billing.resume_refused` with reason
  `recorded_payer_portal_cancel`. Before this, the recorded payer could undo
  the card holder's portal cancel, uncapped, on every renewal.
- **The owner who scheduled a cancel in Klorn can take it back.** *Decided by
  recommendation on 2026-11-15; not LOCKED, reversible.* Taking back one's own
  decision restores what the payer already agreed to, so the owner who
  scheduled this pending cancel through Klorn may undo it even without being
  the payer, while still an owner. When Klorn sends the cancel it records who
  and when (`Organization.cancelRequestedByUserId`, `cancelRequestedAt`, taken
  before the Paddle call). The cancel route reads Paddle first: a cancel
  already pending there (made in the portal, its webhook on the way) is stored
  with no Klorn actor and not sent again, so a portal cancel always stays
  payer-only. The actor is cleared when the cancel is taken back, when it
  takes effect, when a newer subscription attaches, on drift, on that user's
  account deletion, and when the webhook reports no scheduled cancel as of a
  moment after the request (taken back in the portal) — checked even for an
  event too old to apply otherwise, so a portal resume-then-recancel whose
  events arrive out of order still ends the claim. Resume re-checks the actor
  under the org lock and audits `billing.cancel_removed` with
  `via: "canceler"`. Residual gaps, accepted: if Paddle never delivers the
  removal's event, or delivers it only after the re-cancel's, a portal
  re-cancel reads as the Klorn actor's until it does; `cancelRequestedAt` is
  Klorn's clock compared with Paddle's `occurred_at`, so skew can end a claim
  early (safe) or, within the skew, late; and the cancel route's live read
  happens before the org lock, so a portal cancel made in that window (up to
  the lock wait) could be recorded as Klorn's, and a portal cancel taken back
  in that window leaves a stored cancel date until the next event (it blocks
  seat changes with `CANCEL_SCHEDULED`; Keep subscription clears it). Paddle's
  answer to a cancel on a subscription that already has one scheduled is not
  verified. Since the cancel route now reads Paddle first, it answers
  `BILLING_PROVIDER_READ_FAILED` while Paddle reads fail.
- **Settings → Team explains before a click.** `GET /api/orgs/current` adds
  `me.billing` for an owner while the subscription bills
  (`src/org/billing-access.ts`): `isPayer`, `portal` (the paying email),
  `seatCap` (the recorded-payer cap, from the stored count; also shown while
  Paddle cannot confirm the email, since the server caps until it can) and
  `canResume` (the same rule as resume). Only the viewer's own standing —
  never who pays or an email; nothing for a member. null means Paddle could
  not be asked. The one Paddle read (customer email) is shared by concurrent
  loads and remembered per owner, verified email and customer for two
  minutes, a failed read for 30 seconds, so reloads cannot drain the Paddle
  API rate limit that checkout and every billing route share. A failing hint
  never fails the page: the view goes without `billing` and the page shows
  the general rules. A hint, not a gate: every route checks again, and the
  page reloads it after a seat change.
- **Billing portal** opens only while the subscription bills, and only for the
  owner whose verified Klorn email is the Paddle customer's email — never on
  the recorded payer alone. The portal is the Paddle customer's whole account
  (other subscriptions, invoices, address), and the customer is whoever's
  email was typed at checkout, which Klorn does not bind to the buyer: a
  checkout opened by one person and paid under another person's existing
  Paddle email must not open that person's account. Everyone else is
  refused; the payer still has the portal link in Paddle's receipt emails.
- A Paddle call that fails before anything changed (a read, or a portal link)
  answers `BILLING_PROVIDER_READ_FAILED` ("nothing was changed"); a failed
  change answers `BILLING_PROVIDER_ERROR` ("may not have gone through").

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
| PR6 | Scaling breaker, rate-limit handling, concurrent scheduler | not started (paid seat pools already raise the global ceiling: `billing/global-cost-ceiling.ts`) |
| Team | Org/seat schema → seat billing → scheduling assistant → admin features | after launch and after C2 (unified plan P1) |

## Copy rules

- Do not claim "it stops rather than overspends" or a per-person cap; the
  public wording is "daily AI budget per plan — a runaway loop is stopped,
  not billed".
- Team prices go on the public site only after seat price constants and the
  price-consistency guard cover them (the Pro price drifted across pages
  before the guard existed).
