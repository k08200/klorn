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

### Explicit non-goals (v3)

Shared inboxes, delegated sending, org-wide dossiers, cross-member mail search, admin visibility into member mail. Any of these is a new founder decision, not scope creep into v3.
