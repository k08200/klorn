# Unified platform plan (mail · calendar · drive · agents · company edition)

Decided 2026-09-28. Goal: everything a person already uses — mail, calendar and
files across Google, Apple, Naver, Microsoft, company and personal accounts,
including the apps that live on their phone — visible, organised and summarised
in one place behind one Klorn login. Klorn-owned mail, calendar and drive exist
to fill gaps; they are not the product. This file is the sequenced plan. Each
step is one PR. Mail phases 0–4 stay defined in `multi-provider-plan.md`; the
company edition design stays in `../design/team-mode-v3.md`.

## Where the code actually is (audited 2026-09-28, f2d8e9fb)

| | Mail | Calendar | Drive |
|---|---|---|---|
| Google | complete | primary calendar synced to rows; linked accounts used for conflict checks only | none |
| Microsoft | merged, flag OFF, Azure registration pending; reply threading headers missing (`getReplyHeaders` returns `{}`) | none (Graph scopes are `Mail.*` only) | none |
| Naver | read-only IMAP; every action returns 501 | none | none |
| iCloud | read-only IMAP, flag OFF | none | none |
| Generic IMAP (company/personal hosts) | not built (Phase 4, gated on SSRF review) | none | none |
| On-device apps (Samsung, Apple) | n/a | probe only (`packages/web/src/lib/native/calendar-probe.ts`, no callers) | none |

- **Agents.** `POST /api/mcp` and `/api/keys` are live in production (#1281,
  #1283; unauthenticated probe returns 401). The toolset is eight tools, nine
  when `TEAM_MODE_ENABLED` is set, with `create_event` excluded. None of them
  changes mail; `generate_briefing` can create one notification. `ApiKey` has
  no permission column and `authenticateApiKey` returns `{userId, keyId}`.
- **Tool registry.** `mcpToolDefs` admits only tools that are in both
  `ALL_TOOLS` and `CHAT_TOOL_NAMES`. `ALL_TOOLS` also feeds the autonomous
  agent. Adding a tool to either list changes a surface other than MCP.
- **Tier learning.** `overrideAttentionTier` takes an `AttentionItem` id, sets
  `isManualOverride: true` and stamps an `OVERRIDE:` ledger outcome. That flag
  is the human ground-truth boundary. Manual overrides feed the judge's
  correction examples, and two identical overrides for a sender create a prior
  that can skip the model for PUSH and QUEUE for 60 days
  (`learning/sender-policy.ts`).
- **Write paths that exist.** `mark_read` has an executor case. Tier changes
  from every surface go through `overrideAttentionTier`
  (`judge/attention-override.ts`). `MailProviderActions.createDraft` exists but
  is reached only from `POST /api/email/:id/gmail-draft`, and its signature
  carries no reply headers. `archive_email` and `delete_email` are names in
  the risk table with no executor case.
- **Calendar.** `LinkedCalendarAccount` has no provider column.
  `CalendarEvent` is keyed on `googleId`. Sync pulls the primary Google
  calendar only (30 days, 100 events, every 15 minutes). `list_events` calls
  Google live. Rows with no `googleId` are local or sample events. No CalDAV
  library is installed.
- **Storage.** No object storage anywhere. `EmailAttachment` holds metadata and
  extracted text; bytes are refetched from Gmail. Outgoing attachments are held
  in memory. Production Postgres is Supabase (ap-northeast-2).
- **Team mode.** P1/P2 shipped (`Team`, `/api/teams`, `team_availability`).
  Visibility is borrowed from Google free/busy on the caller's token. No
  organisation model exists yet.
- **Klorn mailbox.** Nothing exists. `klorn.ai` has no MX record (DNS at
  Namecheap). Resend already signs for the apex (`resend._domainkey.klorn.ai`,
  return path `send.klorn.ai`). An email+password account with zero mail
  sources is already a supported state (`POST /api/auth/register`).
- **Published addresses.** The repo publishes `hello@klorn.ai`
  (CODE_OF_CONDUCT.md), `founders@klorn.ai` (docs/EDITIONS.md) and
  `sales@klorn.ai` (billing page). With no MX record they bounce today.
- **IMAP sync.** INBOX only. The dedup key is the INBOX UID. An IMAP MOVE
  assigns a new UID.

## External constraints (prior knowledge, NOT re-verified 2026-09-28)

Verify each line against the vendor's current documentation before the step
that depends on it starts. Record the verification date here.

| Constraint | Affects |
|---|---|
| Samsung Mail and Samsung Calendar are device apps, not server services. No server API. Samsung Cloud Drive was retired in favour of OneDrive. | C5, D7 |
| iCloud Drive has no third-party server API. iCloud Calendar speaks CalDAV with an app-specific password. | C3, D7 |
| Naver Calendar speaks CalDAV. Naver MYBOX has no public API. | C3, D7 |
| Google Drive full-read scopes are restricted scopes. Adding one reopens Google verification and CASA. `drive.file` with the Picker may avoid that. | D5 |
| Workspace and Microsoft 365 admins can block third-party apps or require admin consent. | F0 |
| The MCP specification revision 2026-07-28 changed Streamable HTTP. Whether `@modelcontextprotocol/sdk` 1.30.0 implements it is unknown. | A6 |
| grok.com connectors and ChatGPT developer mode need OAuth 2.1 with RFC 9728 metadata. A static key is not enough. | A7 |
| Resend Inbound exists (custom-domain MX, `email.received` webhook). Size limits, retention and spam filtering are undocumented. | E0 |
| Static bearer keys are accepted by Claude Code, Codex, Cursor, Gemini CLI and the xAI API. | A5 |

"One login" means one Klorn login after each source has been linked once.
The exception is the device path: accounts already registered with the OS are
readable after one permission grant.

## Decisions (founder, 2026-09-28 — every row is final)

**Sequencing and scope**

| # | Decision | Value |
|---|---|---|
| V1 | Service order | finish mail, then calendar, then drive |
| V2 | New Google Drive scope | only after the current Google verification passes |
| V3 | Device bridge | in scope, required |
| V4 | External drive connectors v1 | list, search, summarise. No upload or edit |
| V5 | Klorn mailbox | auxiliary path, not the product |
| L1 | Workstream order | agent work first; Klorn mailbox runs alongside once founder actions land |

**Klorn mailbox (workstream E)**

| # | Decision | Value |
|---|---|---|
| L2 | v1 shape | receive forwarded mail and reply. No IMAP/JMAP access, custom domains or aliases |
| L3 | Address domain | `@klorn.ai` |
| L4 | Inbound vendor | Resend Inbound, conditional on written confirmation (FA-1) |
| L5 | Handle policy | user-chosen, immutable, never reissued after account deletion, reserved-word list |
| L6 | Shipping during Google review | merge behind an OFF flag; a disabled route answers with the default 404 |
| L7 | Unsubscribed accounts | address issued after email verification; sending requires a subscription |
| L8 | Reply sender | the Klorn address |
| L9 | New compose | allowed |
| L10 | Send caps | PRO 200/day; 50/day for the first 7 days. Proposed numbers, no measurement behind them |
| L11 | Auto-reply on the Klorn mailbox | excluded from v1 |
| L12 | Footer | off by default, user toggle |
| L13 | Inbound spam | classified into SILENT; authentication failures are shown |
| L14 | Retention and size | kept while subscribed, deleted 30 days after cancellation, 25 MB per message. Proposed numbers |
| L15 | Attachment storage | Cloudflare R2 |
| L16 | Forwarding wizard | Gmail first |
| L17 | Mail to an unknown address | dropped |
| L18 | `postmaster@` / `abuse@` | forwarded internally to the existing support inbox; the public contact address does not change |
| L19 | Edition boundary | code ships in the core; the domain and MX are operational |
| L20 | Name and copy | "Klorn address". Never framed as a Gmail replacement |
| L21 | Default onboarding path | Klorn address first until the Letter of Assessment is issued |
| L22 | Platform order | web first |
| L23 | Flip order | founder account, then cohort, then everyone |

**Agent connectivity (workstream A)**

| # | Decision | Value |
|---|---|---|
| L24 | Target clients | CLI-class clients first |
| L25 | OAuth 2.1 authorisation server | deferred past v1 |
| L26 | Write tools v1 | `mark_read`, `set_tier`, `create_draft` |
| L27 | Agent sending | drafts only. `send_email` stays excluded |
| L28 | Key permission model | two levels: read, read-write |
| L29 | Plan gate | unchanged (subscribers only when the paywall is on) |
| L30 | Agent activity log | ships with the write tools |
| L31 | Public registry listing | after write tools and client docs |
| L32 | Agent-owned addresses | v2 |

**Follow-up decisions**

Raised by the 2026-09-28 audit and decided by the founder the same day.

| # | Decision | Value | Applies to |
|---|---|---|---|
| P1 | Company edition timing | unchanged: implementation stays after launch, and after C2 because it reads each member's own synced calendars | F |
| P2 | Admin onboarding for company accounts | added as PR-0 of team mode v3: admin guide plus detection of the admin-policy error with in-product guidance | F0, B5 |
| P3 | Klorn drive quota per plan | decided at flip time. The schema does not depend on it | D3 flip |
| P4 | On-device calendar events and files | uploaded to the server only behind explicit per-source opt-in. Summaries and the assistant run server-side | C5, C6, D7 |
| P5 | Google Drive scope path | `drive.file` with the Picker first; a restricted read scope only if that proves insufficient | D5 |
| P6 | Object storage vendor | L15 stands. Code targets the S3-compatible API, so Supabase Storage remains a drop-in alternative | D1 |

Notes on decided rows. They clarify; they do not change the decision.

- L10 and L14 carry proposed numbers. Revisit them with the founder once
  production data exists.
- L13: SILENT is "recorded, never rendered" (`../product-vocabulary.md`). The
  authentication result is recorded on the row. Where it is displayed needs a
  vocabulary row before E1 ships copy.
- L17: once the MX record exists, mail to a published address would be dropped
  silently instead of bouncing. E0 therefore inventories every published
  `@klorn.ai` address; each is removed from the repo or reserved and forwarded
  like L18.
- "Company edition" is a working title. `../EDITIONS.md` defines two editions
  and lists team workspaces as Cloud roadmap. F updates that file first.

## Steps

Every step follows the repo gate in `CLAUDE.md` and ends with the flag OFF.
Steps marked *outline* must be expanded into a full brief, in this file, by the
PR that starts them. A step that raises a new founder decision stops and
records the question in this file first.

### Workstream A — agent connectivity

**A1 — API key permission level (server only).** Depends on: nothing.
- Context: `ApiKey` has no permission column. `routes/api-keys.ts` accepts
  `{name}` only. `authenticateApiKey` returns `{userId, keyId}`. The contract
  package is type-only, so runtime constants cannot be imported from it.
- Tasks: add `mcpWriteToolsEnabled()` to `config.ts`, read at request time.
  The flag gates both minting and use. Add a two-value permission (read,
  read-write) defaulting to read, so existing keys stay read-only.
  `authenticateApiKey` returns the effective permission: read-write only when
  the stored value is read-write and the flag is on at that moment. List
  returns the stored value. `POST /api/keys` ignores the permission field
  while the flag is off, exactly as main ignores unknown body fields, and
  validates it while the flag is on. The create response echoes the granted
  permission, so a caller is never silently downgraded. Define the two values
  as runtime constants in api; web gets its own in A3. No UI in this step.
- Verify: extend `api-keys.test.ts` and `routes-api-keys.test.ts` first (RED),
  including flag off, on, off for an existing read-write key.
  `prisma migrate diff` shows only the additive column. Full gate.
- Exit: with the flag off, every request behaves as it does on main. The only
  response change is the additive `permission` field on list and create.
- Rollback: revert the PR; the column is additive and ignorable.

**A2 — MCP write gating, `mark_read`, `set_tier`, audit.** Depends on: A1.
- Context: see "Tool registry" and "Tier learning" above. Tool results carry
  untrusted mail content, so a hostile message can try to steer an agent.
  `buildMcpServer` and the CallTool guard see only `plan` today.
- Tasks:
  - One gate function takes (plan, permission, flag) and is the only source
    for both ListTools and CallTool. The write set is MCP-only. It is not
    added to `CHAT_TOOL_NAMES`, and new tools are not added to `ALL_TOOLS`.
  - `set_tier` takes `email_id`, resolves the open item server-side
    (`findOpenEmailAttentionItemId`) and accepts only PUSH, MEETING, QUEUE,
    INFO, SILENT. It records agent provenance. It never sets
    `isManualOverride`, uses a distinct ledger outcome, and is excluded from
    judge context, sender priors and accuracy metrics. A human override
    always wins over an agent's.
  - Read tools return the current lane so an agent can see what it changes.
  - One audit row per write call, including refused calls: key, user, tool,
    target id, argument hash, outcome, time. New table, so a migration.
    `purge-user-data.ts` covers it.
  - A write-specific rate cap per user, not per key. Five keys must not
    multiply the budget.
- Verify: tests first for flag × permission × plan, for rejected tier values,
  for the audit row, and for the learning exclusion (an agent tier change
  must not appear in correction examples or sender priors). Tests pin the
  chat and autonomous tool lists as unchanged. `prisma migrate diff`. Code
  review and security review, including the `attention-override.ts` change.
  Full gate.
- Exit: with the flag off, the tool list and every tool result are
  byte-identical to today.
- Rollback: flag off.

**A3 — activity log and key permission UI.** Depends on: A2. Web settings
lists write calls per key and offers the read-write choice, both shown only
when the server reports the flag on. WCAG 2.2 AA. `mcpWriteToolsEnabled` is
not flipped before this step merges (L30).

**A4 — `create_draft`, reply-only.** Depends on: A2, B0. `email_id` is
required. The recipient is pinned to the original sender. The account is
resolved from the row. It never sends. Providers without draft support return
an explicit unsupported result.

**A5 — client setup docs.** Read-only part depends on nothing; the write part
follows A2 and A4. One page with snippets for Claude Code, Codex, Cursor,
Gemini CLI and the xAI API. Each snippet is checked against the vendor's
current documentation on the day it is written, and the date is recorded.

**A6 — specification drift check.** Done 2026-09-29.
- The installed SDK speaks protocol revisions up to 2025-11-25. The latest
  1.x release (1.31.0) still does. Revision 2026-07-28 ships only in the v2
  split packages (`@modelcontextprotocol/server` 2.x).
- A client that speaks both eras falls back to `initialize` against our
  server, so today's CLI clients keep working. A client that speaks only
  2026-07-28 fails. Evidence: the spec's versioning and transport pages, and
  Claude Code issue 96183 (MED).
- Stateless mode with GET and DELETE answering 405 does not conflict with
  2026-07-28.
- Action taken: SDK 1.30.0 to 1.31.0. Release 1.30.1 bounds JSON-RPC batches
  at 100 messages. One POST counts once against the per-key rate limit, so
  an unbounded batch multiplied tool calls per request. A route test pins
  the cap. No GitHub advisory covers 1.30.0.

**A6b — v2 SDK and revision 2026-07-28** (*outline*). Depends on: A2a. Move
to `@modelcontextprotocol/server` and `@modelcontextprotocol/node` in
dual-era mode. Recommended, not urgent: start when a target client ships
without the legacy fallback, or before A8. Auth, paywall, rate limit and
`cache-control` handling in `routes/mcp.ts` stay.

**A7 — OAuth 2.1 authorisation server** (*outline*, deferred by L25).
**A8 — public registry listing** (*outline*). Depends on: A2, A4, A5. Needs
founder approval per listing; outward-facing.

### Workstream B — finish mail

**B0 — reply threading in the provider seam.** Depends on: nothing.
`createDraft` and send accept reply headers. The Gmail draft builder includes
them. Graph `getReplyHeaders` returns real headers instead of `{}`.

**B1 — IMAP flag actions for Naver and iCloud.** Depends on: nothing.
- Context: `providers/dispatch.ts` maps NAVER, ICLOUD and IMAP to
  `unsupportedMailActions`. `imapflow` is already a dependency.
- Tasks: read, unread and star over IMAP flags, behind a new OFF flag.
  Preserve the three-way result contract (`unsupported` / `error` /
  `success`).
- Verify: tests first against a mocked IMAP client, including the Phase 0b
  regression: an action reports success and the message reappears on the
  next poll.

**B2 — IMAP move actions.** Depends on: B1. Archive, trash and their
inverses. A MOVE assigns a new UID, so the row must store where the message
went; that is a schema change. Trash is a MOVE to the Trash folder. It is
never `\Deleted` plus EXPUNGE, which is `delete_permanent` and sits on the
floor.

**B3 — SMTP send for IMAP providers.** Depends on: B0. SMTP client, a
per-provider SMTP host pinned like `hostMatchesProvider`, draft support. The
send path stays behind the deterministic floor. Security review is mandatory.

**B4 — generic IMAP** (*outline*). Unchanged from Phase 4: the SSRF design
passes security review first.

**B5 — flips** (*outline*). After the Letter of Assessment. Microsoft also
needs FA-9 and the admin guidance from F0.

### Workstream C — calendar

**C1 — calendar schema becomes provider-aware.** Depends on: nothing.
- Tasks: expand/contract migration. `LinkedCalendarAccount` gains a provider
  and non-OAuth credential columns; `accessToken` becomes nullable and the
  unique key becomes (user, provider, email). `CalendarEvent` gains provider,
  external id and source account; `googleId` stays readable until the
  contract phase.
- Backfill: rows with a `googleId` become GOOGLE. Rows without one are local
  or sample events and get a local provider value, not GOOGLE.
- Verify: `prisma migrate diff`, the CI Migrations job, and a backfill test
  for both kinds of row.

**C2 — calendar provider seam and linked-account sync** (*outline*). Mirrors
`mail/providers/`. Linked Google calendars are synced into rows, not only
consulted for conflicts.

**C3 — CalDAV connector for iCloud and Naver** (*outline*). Read-only v1.
**C4 — Microsoft Graph calendar** (*outline*). Needs calendar permissions
added to the Azure app (FA-9); existing users re-consent.
**C5 — mobile device bridge** (*outline*). Blocked on FA-8. Upload policy per
P4.
**C6 — desktop device bridge** (*outline*). EventKit in KlornMac. Upload
policy per P4.
**C7 — unified calendar read path** (*outline*). Depends on: C2. `list_events`,
briefing and conflict checks read rows across providers. Each connector joins
as it lands; C7 does not wait for them.

### Workstream D — drive

**D1 — object storage foundation** (*outline*). Depends on: FA-7. S3-compatible
client, per-user key prefix, size caps, signed downloads. It may start early:
E4 needs it before workstream D's turn comes.
**D2 — drive model and provider seam** (*outline*). A metadata index of files
across sources.
**D3 — Klorn drive** (*outline*). Depends on: D1, D2. Upload, list, download,
delete. Upload is inherent here; V4 restricts external connectors, not
Klorn-owned storage.
**D4 — file summaries and search** (*outline*). Depends on: D1, D2. Reuses the
attachment analysis pipeline. Cost caps apply.
**D5 — Google Drive connector** (*outline*). Depends on: D2. Blocked by V2.
Scope path per P5.
**D6 — OneDrive connector** (*outline*). Depends on: D2, FA-9 with file
permissions.
**D7 — device import** (*outline*). Depends on: D3. Upload policy per P4. The desktop
and mobile apps import files from iCloud Drive, MYBOX and on-device storage
into the Klorn drive.

A Klorn drive shows what a person puts into it. Files that stay in a service
with no API remain invisible until D7 imports them. Product copy must not
claim otherwise.

### Workstream E — Klorn mailbox (auxiliary)

**E0 — founder actions and address inventory.** FA-1 to FA-4, plus the
inventory of published `@klorn.ai` addresses (note on L17).
**E1 — schema and inbound webhook** (*outline*). New provider value, handle
table with tombstones (L5) and reserved words, signed webhook, shared
persistence path.
**E2 — provider actions and send** (*outline*). Depends on: B0. The database
is the source of truth, so every action in `MailProviderActions` is
implementable.
**E3 — address claim and forwarding wizard** (*outline*).
**E4 — abuse controls and attachments** (*outline*). Depends on: D1.

E1 can be built against fixtures before E0 completes. Nothing is flipped
before E0.

### Workstream F — company edition

Canonical design: `../design/team-mode-v3.md` (PR-A, PR-B, PR-C). This plan
adds **F0 — admin onboarding** (P2). Timing per P1. PR-B depends on C2, because v3
availability reads each member's own synced calendars.

## Order and parallelism

```
A1 → A2 → A3            A2 + B0 → A4            A2 + A4 + A5 → A8
A5 (read-only part), A6 independent
B0 → B3                 B1 → B2                 B4 after security design
F0 → B5
C1 → C2 → C7            C2 → {C3 | C4 | C5 | C6}            C2 → F (PR-B)
D1 + D2 → D3 → D7       D1 + D2 → D4            D2 → {D5 | D6}
E0 (founder) ─ E1 → E2 → E3 → E4 (needs D1)
```

Workstreams start in the order A, B, C, D. E runs alongside once FA-1 to FA-4
land. F follows C2.

**Shared files.** Steps that touch the same file are never open at the same
time, whatever the graph says. The later step rebases, reruns
`prisma generate` and reruns the full gate.

| File | Steps |
|---|---|
| `packages/api/prisma/schema.prisma` | A1, A2, B2, C1, D2, E1, F |
| `mail/providers/types.ts`, `dispatch.ts` | A4, B0, B1, B2, B3, E2 |
| web locale files | every step with UI copy |

## Founder actions

| # | Action | Unblocks |
|---|---|---|
| FA-1 | Ask Resend in writing: inbound size limit, retention, spam filtering, and whether user-composed mail from per-user addresses is permitted (draft below) | L4, E1 |
| FA-2 | Confirm the current Resend plan. The free plan sends 100 messages a day | E2 |
| FA-3 | Confirm the production Render plan. `render.yaml` says free; a sleeping instance loses inbound webhooks | E1 |
| FA-4 | Add the MX record at Namecheap once L4 is confirmed and the address inventory (E0) is done | E1 |
| FA-5 | Approve privacy policy and terms changes. Klorn becomes a mail and file host | E3, D3 |
| FA-6 | Confirm whether hosting mail requires a value-added telecommunications filing in Korea. Unverified | E3 |
| FA-7 | Create the object storage account | D1 |
| FA-8 | Run the Samsung calendar probe on a Galaxy device and record the result here | C5 |
| FA-9 | Azure app registration (existing action B). That action lists `Mail.*` permissions only; calendar and file permissions must be added for C4 and D6 | B5, C4, D6 |

## Cross-cutting rules

- Every step ships OFF by default. A flag is read at request time. A disabled
  route answers exactly like an unregistered one.
- No new Google scope before the current verification passes (V2).
- Five lanes only: PUSH, MEETING, QUEUE, INFO, SILENT.
- Every mail action threads the linked inbox account id end to end.
- `send_email`, `delete_permanent` and `forward_external` always require a
  receipt. No agent surface bypasses the floor.
- Only a human action sets `isManualOverride`. Nothing an agent does feeds the
  judge's learning.
- A step that introduces a user-facing noun adds its row to
  `../product-vocabulary.md` in the same PR.
- No mail content crosses accounts. Cross-member data is free/busy only, under
  explicit per-member consent.
- A step that turns out larger than one PR is split here first, with the date
  and the reason, before code is written.

## Appendix — FA-1 draft

> Subject: Inbound and per-user sending on a verified domain
>
> We run Klorn on Resend for transactional mail (domain `klorn.ai`). We plan to
> give each user an address on that domain, receive mail through Resend
> Inbound and let users reply from their own address. Before we build, could
> you confirm in writing:
> 1. The maximum inbound message size, including attachments.
> 2. How long received messages and attachments are retained.
> 3. Whether inbound mail is spam-filtered before the webhook fires.
> 4. Whether user-composed one-to-one mail from per-user addresses on a
>    verified domain is permitted under the acceptable use policy.
> 5. The webhook retry behaviour when our endpoint is unavailable.
