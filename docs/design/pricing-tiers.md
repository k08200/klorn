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
