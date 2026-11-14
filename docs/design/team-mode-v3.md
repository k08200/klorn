# Team Mode v3 — Organization Model (design, approved direction)

Status: **direction approved by founder (2026-08-20), implementation deferred until after launch.** P1 (saved teams + team availability) and P2 (team meeting drafts with invitations) shipped 2026-08-20; this document is the canonical design for the third phase so it can start without re-deriving scope.

## What P1/P2 already cover

- `Team` (per-user): name + member emails; CRUD at `/api/teams`, desktop Preferences → TEAMS.
- `team_availability` assistant tool: common free slots for the user + every VISIBLE member (Google free/busy). Members whose calendars are not visible are returned in `unknownMembers` — unknown is never treated as free.
- Meeting drafts carry `attendees`; the human approval (POST /api/calendar) is the only path that sends invitations (`sendUpdates: all`). The assistant/tool path never sends invites on its own.

P1/P2's structural limit: **visibility is borrowed from Google** (same Workspace or explicitly shared calendars). The team is a private label in one user's account; members are not Klorn users and know nothing about it.

## What v3 adds: teams as first-class multi-user objects

An **Organization** whose members are Klorn users, so availability, scheduling, and (selectively) triage signals come from consent inside Klorn rather than from Google calendar ACLs.

### Data model (additive)

```
Organization { id, name, createdAt }
OrgMember    { orgId, userId, role: OWNER|ADMIN|MEMBER, joinedAt, @@unique([orgId,userId]) }
OrgInvite    { orgId, email, token(hash), invitedBy, expiresAt, acceptedAt? }
OrgTeam      { orgId, name, @@unique([orgId,name]) }          // shared teams
OrgTeamMember{ teamId, memberId(OrgMember) }
AvailabilityGrant { memberId, scope: FREEBUSY|NONE, updatedAt } // per-member consent
```

`Team` (P1, per-user) stays; an org team is a separate, shared object. No mail content ever crosses accounts — v3 shares **free/busy availability only**, and only under an explicit per-member `AvailabilityGrant`.

### Consent and privacy invariants (non-negotiable)

1. A member's availability is visible to the org **only after that member grants FREEBUSY** — default NONE. Revocable any time; revocation takes effect on the next query (no cache longer than 10 minutes).
2. Free/busy only: never event titles, attendees, or locations across accounts.
3. Mail, dossiers, tiers, drafts: never shared. The org model is a scheduling primitive, not shared inbox access.
4. Every cross-member availability read is logged (memberId, requester, window) — auditable like action receipts.

### Flows

- **Invite**: owner invites by email → recipient signs in/up → accept screen states exactly what is shared (free/busy, revocable) → OrgMember + AvailabilityGrant choice.
- **Availability**: `team_availability` resolves an org team to member userIds → for granted members, availability comes from each member's own Klorn calendar sync (their primary + linked calendars — richer than Google ACL visibility); non-granted members appear in `unknownMembers` exactly like P1.
- **Scheduling**: same draft-approval path as P2. The organizer's Google account sends the invitations; Klorn never sends from someone else's account.

### Billing / gating

Org creation is a paid-tier capability (entitlement flag, OFF by default at launch — feature-flag doctrine). Member seats and pricing are founder decisions at flip time; the schema above does not depend on them.

### Delivery plan (when started)

0. PR-0 (added 2026-09-28): admin onboarding for company accounts. Defined as F0 in `../providers/unified-platform-plan.md`.
1. PR-A: schema + org/invite routes + accept flow (web), audit log. No UI surface beyond accept.
2. PR-B: AvailabilityGrant + availability resolver behind the existing `team_availability` tool (org teams appear next to personal teams).
3. PR-C: desktop/web org management UI + shared teams.
4. Security review gates every PR (invite token hashing, grant enforcement at the resolver — not the route, audit completeness).

### Company domains in a member's judge (Teams v1.1, 2026-11-14)

`Organization.companyDomains` (launch feature 6 in `pricing-tiers.md`) reaches each member's judge as **one relationship fact**, `orgCompanyDomain`, on the AE3 relationship snapshot (`packages/api/src/judge/v3/relationship.ts`): "the sender is a colleague at your company".

- **Read path:** `src/org/org-domains.ts` reads the member's own membership and their organization's `companyDomains`, and nothing else. It runs no query while `TEAMS_ENABLED` is closed to the user. It does not depend on a paid seat, because the domains are an organization setting and not a paid capability.
- **Shape:** the fact is present only when the organization has usable domains, and is then `true`, `false` or `null`. Without an organization the snapshot has no such key, so stored rows, replay and every judge input are byte-for-byte what they were before. The domain list, the organization and its members never reach the judge, only the boolean. The facts LLM prompt takes no relationship data at all (`facts-prompt.ts`).
- **Spoofing:** `true` only for a From that passed DMARC (the same rule as `sameOrgDomain`); unknown or failed DMARC is `null` (no evidence). Exact domain or a subdomain (`mail.acme.com` ⊂ `acme.com`); `notacme.com`, `acme.com.evil.io`, a display-name trick and a malformed domain are not. The sender's domain must be a well-formed hostname before the suffix match.
- **Unverified, owner-typed domains:** nothing proves an organization owns the domains its owner lists, and organization creation is self-service. So a listed domain only counts when it cannot stand for strangers (`judge/v3/org-domain-fact.ts`): never a public mailbox provider (either list in `mail/`), never a country-code second-level suffix (`co.uk`, `com.au`, `or.kr`, …), never a multi-tenant hosting parent (`github.io`, `onmicrosoft.com`, …). There is no full public-suffix list in the repo; that filter is the backstop.
- **Weight: none.** The fact is a raw feature with no hand weight. It does not set a lane, is not a pin, is not trust (`isTrustedSender`, `trustedSender` and the v3.2 first-contact bar ignore it) and does not feed the importance prior. Any lift above the `unknown` prior makes a held item rank first (`ranking.ts` heldFirst), so a weighted fact would let a stranger on an owner-listed domain take the top of every member's list (review finding, 2026-11-14). A generated-facts test proves every policy version decides exactly as without it, and the live decision keeps its lane, trust and importance. The relationship reason names it, so it is explainable, and stored snapshots carry it for P5's learned weights. Giving it a hand weight is a founder decision once domain verification (DNS TXT proof per domain) exists.
- **Disclosure gap:** the member transparency screen does not yet say that the organization's domains are shown in the member's triage reasons. Follow-up for the Settings → Team copy.

### Audit log retention (Teams v1.1, 2026-11-14)

`OrgAuditEvent` rows are kept for **400 days** and then deleted (`src/org/audit-retention.ts`).

- **Status:** 400 days is the proposed window, chosen on the founder's behalf while Teams is dark; the founder confirms or changes it before Teams opens to customers.
- **Why 400:** the log answers two kinds of question. The first is "who changed this setting, who read my free/busy" (members, owners). The second is what happened around a charge (billing disputes, chargebacks). A full annual billing cycle (365 days, since team seats bill yearly too) plus ~35 days covers a dispute raised after the renewal invoice and a year-on-year look back. Keeping rows longer holds member-adjacent data (who read whose free/busy, invited addresses) with no use for it.
- **How:** a daily sweep runs under the `org-audit-retention` scheduler lease, so one instance runs it during a zero-downtime deploy overlap. It pages oldest first in batches of 1,000, each page in its own short system-scope transaction (the table has only the RLS bypass policy), at most 50 batches a run, and reports any backlog it leaves. The delete re-checks the cutoff. Two refused leases in a row alert Sentry (the lease's own alert needs ~10 minutes of skips, which a daily job never reaches). A single-column `createdAt` index serves the range. The cutoff comes from the app clock; a clock far ahead would delete early, bounded at 50,000 rows a run.
- **Flag:** the sweep is not behind `TEAMS_ENABLED`. `ORG_AUDIT_RETENTION_DISABLED=true` pauses it (a legal hold or a dispute that needs older rows), and the scheduler then reports itself disabled-by-design. Retention is a promise about rows that exist, and rows written while Teams was open must still age out if the flag is turned off again. With no organizations the table is empty and a run costs one indexed query. Teams v1 shipped on 2026-11-14, so the first row can reach the window no earlier than 2027-12-19.
- **Disclosure:** the member transparency screen states that the organization sees the audit log. The privacy policy should state the 400-day window before Teams is opened to customers. That is a founder follow-up, because legal docs are not edited here.

### Explicit non-goals (v3)

Shared inboxes, delegated sending, org-wide dossiers, cross-member mail search, admin visibility into member mail. Any of these is a new founder decision, not scope creep into v3.
