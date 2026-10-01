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
| Microsoft | merged, flag OFF, Azure registration pending; replies and reply drafts thread natively through Graph `createReply` (B0b, landed 2026-09-30, not yet run against a real tenant); `getReplyHeaders` still returns `{}` | none (Graph scopes are `Mail.*` only) | none |
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
  (`judge/attention-override.ts`). `MailProviderActions.createDraft(userId,
  {to, subject, body, threadId?, attachments?, linkedInboxAccountId?, reply?})`
  exists and is reached only from `POST /api/email/:id/gmail-draft`. That route
  does not pass `reply`. `archive_email` and `delete_email` are names in the
  risk table with no executor case.
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

**A2 — split on 2026-09-29 into A2a and A2b.** Reason: `set_tier` crosses the
judge trust boundary. It changes what the human-ground-truth flag and the
learning inputs are allowed to mean, so it needs its own code and security
review. The gate, permission plumbing, audit and rate cap are a self-contained
unit that `mark_read` alone can exercise end to end. Elsewhere in this file
"A2" reads as A2a (A3, A4). A5's write part waits for A2b, and A8 depends on
A2b, because L26 lists `set_tier` among the v1 write tools.

**A2a — MCP write gate, audit, rate cap, `mark_read`.** Depends on: A1.
- Context: see "Tool registry" above. Tool results carry untrusted mail
  content, so a hostile message can try to steer an agent. `buildMcpServer` and
  the CallTool guard saw only `plan` before this step.
- Tasks:
  - One gate function (`mcp/tool-gate.ts`, `mcpToolDefs(plan, permission)`) is
    the only source for both ListTools and CallTool. It reads
    `mcpWriteToolsEnabled()` itself, in addition to the permission
    `authenticateApiKey` already folds it into. The read set is exactly the old
    `mcpToolDefs(plan)`. The write set is a separate MCP-only constant,
    `mark_read` alone in this step, reusing its `ALL_TOOLS` definition and
    executor case. Nothing is added to `CHAT_TOOL_NAMES` or `ALL_TOOLS`.
  - `routes/mcp.ts` passes the key's id and permission into `buildMcpServer`.
  - One `McpWriteAudit` row per write call, refused calls included: user, key,
    tool, target id, SHA-256 of the canonical argument JSON, outcome, short
    reason, time. `apiKeyId` is not a foreign key, so the history outlives the
    key. Nothing is inserted while the flag is off, on any path. An allowed call
    is inserted as `attempted` before it runs, and a failed insert refuses the
    call. After the run it settles to `ok` only when the tool's own success
    predicate holds (`mark_read`: the parsed result has `success === true`), and
    to `error` for a throw or any other result. **`error` does not guarantee "no
    effect"** (for example the Gmail change succeeded and the local update
    failed), and `attempted` means the outcome is unknown (a crash, or the
    settle write failed). A refused call is audited best-effort and
    fire-and-forget, throttled to one row per (key, tool, reason) per minute
    (the rest are dropped and counted in memory), and its response stays exactly
    `Unknown tool: <name>`, so a read key cannot tell a write tool exists. The
    argument hash falls back to a fixed marker for input nested deeper than 32
    levels or larger than 4 KB of canonical JSON, and `targetId` is stored only
    when it is 1-256 characters of `[A-Za-z0-9_-]`. Canonical JSON is the shared
    `stable-json.ts`, also used by the action outbox (its keys are unchanged).
  - Retention and deletion: rows are swept after 90 days by the `log-retention`
    job (that job runs only where `LOG_RETENTION_ENABLED` is on), cascade with
    the user, and `purge-user-data.ts` deletes them. The same purge now revokes
    (never deletes) the user's API keys, so a purged account that re-links
    Google cannot be read through an old key.
  - A write cap per user, not per key: 30 per minute (proposed number, no
    measurement behind it), in-process sliding window, so per instance
    (in `mcp/write-call.ts`). Over the cap the call is refused, audited with
    reason `rate_limited`, and answers an explicit `RATE_LIMITED` error.
  - Known gap: a 401 (revoked or unknown key), a 403 (paywall) and a 429 (route
    rate limit) never reach the tool layer and are not audited. A3 may surface
    revoked-key use; nothing in A2a does.
  - Id contract checked 2026-09-29: `list_emails` returns the raw Gmail message
    id of the primary account and `read_email` echoes it. `mark_read` takes
    that id, resolves the caller's own row (`userId` in the lookup), routes a
    linked-inbox row through its own account, and with no row acts through the
    caller's primary client only.
- Verify: tests first (`mcp-tool-gate`, `mcp-write-audit`, `mcp-write-call`,
  `mcp-mark-read-contract`, `routes-mcp`, `log-retention`, `purge-user-data`):
  flag × permission × plan, with literal per-plan lists; flag off and read keys
  byte-identical to the old list and to every old result, with zero audit
  inserts even for a 100-call batch; chat, autonomous and `ALL_TOOLS` lists
  pinned; audit before execution; failed insert refuses; the success predicate;
  the refused-row throttle across a batch; the cap is shared by two keys of one
  user. `prisma migrate diff` shows only the new enum, table, indexes and
  foreign key. Full gate.
- Exit: with the flag off, the tool list and every tool result are
  byte-identical to before, and nothing is inserted into the audit table. With
  the flag on, a key that cannot write leaves at most one refused row per tool
  and reason per minute.
- Rollback: flag off. The table is additive and ignorable.

**A2b — `set_tier`, lane in the result, learning exclusion.**
Depends on: A2a. Needs its own code review and security review, including every
change to `attention-override.ts` and `attention-mirror.ts`.
**Scope change, 2026-09-30, for the founder to confirm.** The original scope
(L26 and this block) had the read tools return the current lane. What landed
returns the previous and the new lane from `set_tier` and leaves `list_emails`
and `read_email` untouched, so an agent sees a lane only when it writes. The
reasons are under "Read visibility" below. Say so if A8 or the founder wants the
read tools enriched instead.
- Context, audited 2026-09-29 (03de6426). These facts constrain the design:
  - `attention-mirror.ts` resets `isManualOverride: false` on every producer
    write for the non-email sources (`upsertAttentionFor*` for pending action,
    task, calendar event, notification and commitment; the pending-action write is
    at `:227` and `:249`). **Corrected 2026-09-30:** `upsertAttentionForEmailJudgement`
    does not leave it either. Its update branch also writes `isManualOverride:
    false` (pinned by `attention-mirror.test.ts`), so any re-judge through it
    replaces a human override as well as an agent change.
  - `fallback-rejudge.ts` rewrites only items with `isManualOverride: false`
    (`:159`). An agent change stored with `isManualOverride: false` can be
    silently overwritten by a re-judge. A2b must decide how an agent's lane
    survives one, without setting the flag, or state plainly that it does not.
  - `overrideAttentionTier` stamps `DecisionLabel.outcome` only where
    `outcome` is null (`attention-override.ts:67-75`), and the first stamp
    wins. An agent stamp, distinct outcome or not, would block a later human
    stamp. **A2b must not stamp `DecisionLabel`.** This replaces the earlier
    wording "uses a distinct ledger outcome".
  - Readers of `isManualOverride`, `MANUAL_OVERRIDE_PREFIX` or the
    `DecisionLabel` outcome: `judge/judge-context.ts`, `learning/sender-policy.ts`,
    `judge/calibration-snapshot.ts`, `learning/correction-eval.ts`,
    `judge/decision-metrics.ts`, `pim/weekly-report.ts`,
    `learning/ontology-proposals-store.ts`. Each needs a test that an agent
    change is not counted.
- Tasks:
  - `set_tier` takes `email_id`, resolves the open item server-side
    (`findOpenEmailAttentionItemId`) and accepts only PUSH, MEETING, QUEUE,
    INFO, SILENT. It joins the write set in `mcp/tool-gate.ts`, so the A2a
    gate, audit and cap apply unchanged. It records agent provenance somewhere
    other than `DecisionLabel`. It never sets `isManualOverride`. It is
    excluded from judge context, sender priors and accuracy metrics. A human
    override always wins over an agent's.
  - The agent sees the lane it changes: the `set_tier` result carries the
    previous and the new lane (chosen 2026-09-30, see "Landed").
- Verify: tests first for rejected tier values, the audit row, and the learning
  exclusion (an agent tier change must not appear in correction examples,
  sender priors, calibration, decision metrics, the weekly report or ontology
  proposals), and for a re-judge and a later human override against an agent
  change. Tests pin the chat and autonomous tool lists as unchanged.
  `prisma migrate diff` if a column is added. Full gate.
- Exit: with the flag off, the tool list and every tool result are
  byte-identical to today. `MCP_WRITE_TOOLS_ENABLED` does not flip before A2b
  and A3 have both merged.
- Rollback: flag off. The columns are additive and ignorable. The heal and
  re-judge fix (human overrides survive a stale-hash re-judge, guarded re-judge
  write) is its own commit: it is live with the flag off, so revert it alone if
  it misbehaves.
- **Landed 2026-09-30** (#1334):
  - **Provenance.** Two nullable `AttentionItem` columns, `agentTierSetAt` and
    `agentTierKeyId` (the API key id, not a foreign key). Non-null means the
    current tier is the agent's. `isManualOverride` is never set, `DecisionLabel`
    is never touched, and the `tierReason` is `Agent change — moved to <TIER> by
    a connected agent`, which cannot match `MANUAL_OVERRIDE_PREFIX`. Shared
    vocabulary in `judge/agent-tier.ts` (`NOT_AGENT_SET` for reads,
    `CLEAR_AGENT_TIER` for writes). A separate column rather than a tierReason
    marker because tierReason is free text that the judge also writes.
  - **`set_tier(email_id, tier)`** (`mcp/set-tier.ts`). Definition is MCP-only
    (not in `ALL_TOOLS`, `CHAT_TOOL_NAMES` or the risk table); plan-gated through
    `TOOL_FEATURE_MAP` exactly like `mark_read`. Resolves the id like `mark_read`
    (userId-scoped), then the OPEN email item. Results: `{success, email_id,
    previous_tier, tier, changed}` or `{error, code}` with `INVALID_ARGUMENT`,
    `NOT_FOUND`, `MANUAL_OVERRIDE`, `UNAVAILABLE`. AUTO and CALL are rejected.
    `previous_tier` is the stored lane (CALL reads as PUSH, null as QUEUE); a
    retired AUTO row is reported as `AUTO`, so a request for QUEUE is a real
    change and is written. The requested lane already held is a no-op (no write,
    no stamp). The write is
    guarded in its WHERE on `status: OPEN` and `isManualOverride: false`, so a
    human override that lands after the read still wins.
  - **Read visibility.** Previous and new lane in the `set_tier` result, not
    enrichment of `list_emails` / `read_email`. Smaller: no parse and re-serialise
    of capped tool output, no extra queries on the hot read path, and the
    byte-identity of every read result is structural instead of conditional. The
    cost is that an agent learns the current lane only when it writes. Revisit
    for A8 if it needs to filter by lane before acting.
  - **Learning readers.** `judge-context` (sender items: history prior, tier
    history, override count; corrections), `calibration-snapshot` and
    `correction-eval` skip agent-set rows via `NOT_AGENT_SET`. Without the
    sender-items filter an injected agent could build the unanimous-history prior
    (QUEUE, three emails) that skips the LLM for that sender. `decision-metrics`,
    `weekly-report` and `ontology-proposals-store` read only the ledger, which
    `set_tier` never writes. All proved against the real readers in
    `agent-tier-learning-exclusion.test.ts`, each with a human control.
  - **Who rewrites an EMAIL item's tier.** New-mail ingest judges only new rows
    (an existing row is never re-judged by `persistGmailEmail`) and the backfill
    sweep only emails with no item, so neither reaches an agent-set or
    human-overridden item; both keep the plain upsert.
    - **Stale-hash heal (`routes/firewall.ts`).** UNREAD is one of the four hashed
      fields, so a read-state flip (the agent's own `mark_read`, or the user
      reading the mail) makes the next board read re-judge the item. On main that
      reset `isManualOverride` and overwrote a human's lane, so this was a live
      bug for every user, flag off included. Of the hashed inputs only the labels
      change after delivery, so the heal now refreshes only `inputHash` for an
      item that is agent-set or human-overridden (one guarded `updateMany` on
      `status: OPEN` and the stamp or flag) and re-judges only when that matched
      zero rows. The refresh bumps `@updatedAt`, which extends a human
      override's recency in `judge-context` (override priors age out at 60 days
      by `updatedAt`); accepted. Landed as its own commit so it can be reverted
      alone.
    - **Re-judge write.** A re-judge of an existing item (heal, operator script)
      now writes through a guarded `updateMany` requiring `isManualOverride:
      false` and no agent stamp, mirroring `fallback-rejudge`, and creates
      nothing. Zero rows returns `preserved`; `judgeAndMirrorEmail` then skips
      the ledger refresh, the wake-up, the push and the Gmail label, so a human
      override or an agent lane that lands while the judge call runs is no
      longer overwritten. `scripts/rejudge-open-email-items.ts` uses the same
      path and counts the items it kept.
    - **`fallback-rejudge`** skips agent-set items in both its read and its
      guarded write.
    - **The plain upsert** (new items only) still replaces the tier, resets the
      flag and clears the stamp. Accepted residual: it is unguarded, so it can
      overwrite an agent lane only if two judges of the same brand-new email race
      each other and an agent acts in between. The heal's keep-lane choice is made
      from the board row read at request time; a flag or stamp set after that is
      caught by the guarded write, not by the choice.
  - **Human after agent.** `overrideAttentionTier` clears the stamp. A
    `confirmAttentionTier` on an agent-set item answers ok but does not stamp the
    ledger: a `CONFIRM:` of the agent's lane against the judge's shown tier is a
    contradictory label, and first-stamp-wins would block the user's real
    override.
  - **Side effects.** `set_tier` fires no push, banner, Telegram message, bell row
    or client wake-up (those fire only inside `judgeAndMirrorEmail`). The next
    generated briefing may list an item the agent moved to PUSH, as it lists any
    open PUSH item. `autoEligible` is untouched, so an agent cannot add an item to
    the auto-send sweep (it only ever selects judge-computed `autoEligible` on
    QUEUE or MEETING); it can only move one out.
  - **Gmail labels.** `set_tier` writes none. With `GMAIL_LABEL_MODE_ENABLED` the
    stale label would be read by `reconcileLabelCorrection` as a human drag, undo
    the change and mint a false human correction, so it now skips agent-set items.
    Known limits: a human who drags the Gmail label on an agent-set item is not
    recorded until they act in the app, and the Gmail label keeps the judge's
    lane. Separately, and not changed here: the in-app override route writes no
    label either, so with label mode on the same reconcile can read the stale
    label against a human's in-app move (source reading only, not reproduced; the
    flag is off by default).
  - **Other surfaces that read an agent lane.** The aging sweep exempts agent-set
    rows from SILENT and QUEUE age-out, so an injected agent cannot demote an old
    mail to SILENT and have it resolved (acted-elsewhere resolution still applies).
    Board items carry `agentSet: true` only when the stamp is set (the key is
    absent otherwise, so responses without agent lanes are byte-identical); the
    contract type is additive and optional, and no client renders it yet. A3 or a
    later UI step renders it and adds the vocabulary row for the noun. The daily
    receipt lists an agent-set PUSH as queued, not pushed, and does not count it
    as an interruption. `scripts/calibration.ts` applies the same exclusion as the
    daily snapshot.
  - **Audit trail.** `McpWriteAudit` gains nullable `tierFrom` and `tierTo`
    (separate migration `20260930020000`, the A2a migration is untouched),
    filled when a `set_tier` call actually changed a lane, so A3 can show the
    change and a later step can revert it. Recorded on settle, so a failed settle
    leaves the row `attempted` with no lanes.
  - **Verify result.** `prisma migrate diff` from origin/main: four nullable
    `ADD COLUMN` statements (two migrations), nothing else. The implementer
    (not CI) ran mutation checks on 2026-09-30: writing `isManualOverride` from
    `set_tier`; dropping the sender-items and calibration filters; dropping the
    corrections and correction-eval defence-in-depth filters; dropping the
    re-judge guard's `isManualOverride: false`; dropping the agent handling in
    `fallback-rejudge`, aging and the receipt. Each made the new tests fail and
    was restored.

**A3 — activity log and key permission UI.** Depends on: A2. Web settings
lists write calls per key and offers the read-write choice, both shown only
when the server reports the flag on. WCAG 2.2 AA. `mcpWriteToolsEnabled` is
not flipped before this step merges (L30).

Landed 2026-09-30, OFF by default (the flag is unchanged):
- `GET /api/keys/:id/activity` (session auth, own keys only): the 50 newest
  `McpWriteAudit` rows of one key, newest first, as `tool`, `outcome`,
  `reason`, `targetId`, `createdAt` and nothing else (the `select` and the
  mapping are both allow-lists, so `argsHash` cannot leave). A foreign id and an
  unknown id are the same 404 (`{ error: "API key not found" }`), and so is an
  id that is not `[A-Za-z0-9-]{1,64}`, checked before any query (`DELETE /:id`
  checks the same shape and keeps answering a malformed id like an unknown one:
  `{ revoked: true }`, no query). It is 30 a minute per client address. While the flag is off it is an unregistered route, byte
  for byte (`darkRouteGate`, in `onRequest`, before auth and any query). Query
  in `mcp/key-activity.ts`.
- `GET /api/keys` adds `writeToolsAvailable: true` only while the flag is on;
  while off the body is exactly `{ keys }` as before. Both shapes are in
  `@klorn/contract`.
- Web, `components/api-keys-section.tsx`: while `writeToolsAvailable` is
  true the create form offers Read only (default) or Read and write with one
  sentence on what read-write allows, each key shows its permission, and each
  read-write key (revoked ones too) expands Agent activity (time, action,
  outcome, reason). Without the field the section renders the pre-A3 markup and
  posts `{ name }` only. Copy is in all seven web locales. The two new nouns
  are in `../product-vocabulary.md`.
- Known gaps: the UI shows activity for read-write keys only, although a read
  key also collects `refused` rows when an agent tries a write tool. The
  Read and write sentence promises "change lanes", which is true only once A2b
  lands; the flag must not flip before then. A 401 from a revoked key is still
  not audited (A2a gap). The web app has no unit-test runner: its checks are
  the Playwright spec `packages/web/e2e/api-keys-permission.spec.ts` (run by
  hand, not in CI) and the i18n parity guard, which in CI also fails a new A3
  string that is a copy of the English text.

**A4 — `create_draft`, reply-only.** Depends on: A2, B0. `email_id` is
required. The recipient is pinned to the original sender. The account is
resolved from the row. It never sends. Providers without draft support return
an explicit unsupported result. Outlook returned unsupported until B0b, because a
draft made through Graph `POST /me/messages` does not thread. B0b landed, so Outlook
now drafts natively (see B0b).
- The tool never accepts header strings from the caller. It takes an email id,
  and the server resolves the reply headers through `getReplyHeaders`.
- Rule: if any send path ever carries agent-supplied reply context, the
  resolved in-reply-to email id and the thread id join the receipt payload
  hash, and `RECEIPT_SCHEMA_VERSION` (`judge/attention-floor.ts`) is bumped.
- **Landed 2026-09-30** (#1340):
  - **`create_draft(email_id, body, subject?)`** (`mcp/create-draft.ts`).
    MCP-only: not in `ALL_TOOLS`, `CHAT_TOOL_NAMES` or the risk table. It is the
    third member of the write set (`mark_read`, `set_tier`, `create_draft`), so
    the A2a gate, audit row and shared per-user cap apply unchanged; its success
    predicate is `success === true`, and the audit `targetId` is the email id.
    Result: `{success: true, draft_id, provider, to}`; a provider's own
    `{unsupported}` or `{error}` is returned unchanged; Klorn's refusals are
    `{error, code}` with `INVALID_ARGUMENT`, `NOT_FOUND`, `NO_REPLY_ADDRESS` or
    `UNAVAILABLE`. A hard failure is captured and answered generically, and does
    not claim that no draft exists.
  - **Plan gate: `email_write`** (`TOOL_FEATURE_MAP` in `billing/stripe.ts`), the
    same map entry `send_email` uses, and the map the chat's write tools follow.
    MCP follows the tool feature map, so **pre-launch FREE keys cannot draft
    while the human draft route (`POST /api/email/:id/gmail-draft`, behind
    `requireEntitled`) admits FREE with the paywall off.** That is within L29
    ("plan gate unchanged"): the gate is the existing one, applied to a new tool.
    FREE keys see `mark_read` and `set_tier` but not `create_draft`. Say so if
    FREE should draft.
  - **The arguments are closed.** Anything outside `email_id`, `body`, `subject`
    is refused with `INVALID_ARGUMENT` (no echo of the input): `to`, `cc`,
    `bcc`, `in_reply_to`, `references`, `thread_id`, `html`, `attachments`. The
    schema says `additionalProperties: false` for clients that read it.
  - **Resolution.** `email_id` (Klorn id or provider id) resolves the caller's
    own row through one shared helper (`mail/email-lookup.ts`, also used by
    `mark_read` and `set_tier`: same id parse for the two MCP tools, same
    `userId` + `OR:[{id},{gmailId}]` lookup for all three). The row's
    `linkedInboxAccountId` goes to `mailActionsFor`, `getReplyHeaders` and
    `createDraft` (`null` only for a primary-inbox row), and the provider comes
    from the dispatcher. (Until B0b, OUTLOOK answered `{unsupported: true}` before any
    provider call; B0b removed that refusal.) The reply headers are `getReplyHeaders` of the original: In-Reply-To is
    its Message-ID, References is its chain plus that id (the `/reply` route's
    shape), and with `{}` the draft carries no `reply` and threads by thread id
    alone.
  - **Recipient: the original `From`, always.** One bare address
    (`mail/single-address.ts`, in `mail/` beside `email-address.ts` and
    `reply-headers.ts`), parsed in one linear pass with no backtracking regex on
    the raw header. The display name is dropped, quoted names may hold commas, a
    parenthesised comment is allowed in the display name when exactly one angle
    group exists (`Jane Doe (Acme) <jane@acme.com>`), and a second address, a
    group, a comment anywhere else, a control character, a non-ASCII address or a
    header over 998 characters is refused. It is validated BEFORE any provider is
    touched, so a refusal makes no provider call. This is the human reply route's
    rule (`email-replies.ts` uses From only).
    **Reply-To is ignored on purpose.** It is sender-controlled, so honouring it
    could route an agent's draft to a third party, and a test pins that a Reply-To
    header is never used. Honouring it later is a **founder decision**, not a
    two-line enablement: it needs a product call on where a reply should go, then
    a seam change (`replyTo?` on `ReplyHeadersResult`, `"Reply-To"` in the Gmail
    `metadataHeaders`, the same for IMAP) after B3 has merged.
    `createEmailDraft` still refuses a no-reply sender, and that error passes
    through.
  - **Subject and body.** Limits count code points, the unit the schema's
    `maxLength` counts. Subject (`mail/reply-subject.ts`): the agent's, checked
    (1 to 300, no control character or line break, tested before trimming so a
    trailing newline is an error; bidi and zero-width controls U+200B,
    U+200E-200F, U+202A-202E and U+2066-2069 are stripped; the zero-width
    joiner and non-joiner are kept for Persian and Indic spelling and emoji), else `Re: <original>` flattened to one line, stripped
    the same way, capped, trimmed after the cut, with no second `Re:` in any
    case. Body: plain text, 1 to 20,000, no NUL, sent as `text/plain` and never
    interpreted (there is no html argument). Both limits are proposed values. A
    localised reply prefix in the original (for example `AW:`) is not recognised,
    so it gets a `Re:` in front.
  - **Audit identity.** `argsHash` only marks an argument object over 4 KB as
    oversize, so two different long drafts to one email left identical rows.
    `McpWriteAudit` gains three nullable columns (migration
    `20261001020000_mcp_write_audit_draft`, additive, no index): `bodyHash`
    (SHA-256 of the body, written with the `attempted` row, so a crashed call
    still identifies its content), `recipientHash` (SHA-256 of the lowercased
    recipient, recomputable from the original's From) and `draftId` (the
    provider's id, id-shaped values only), the last two written when the draft
    was created. Hashes, not plain text, because the table's rule is that no mail
    content is stored and a recipient address is that; A3's read path selects an
    allow-list of columns, so none of these reaches a response. Tested with a
    15,000-character body.
  - **Its own cap, and a retry guard.** `create_draft` is also held to 10 per
    user per minute (`MCP_CREATE_DRAFT_CAP_PER_WINDOW`, a proposed value) on top of
    the shared 30; a draft refused by its own cap spends none of the shared
    budget. An identical request (same user, same email, same body, same subject)
    within 10 minutes (`DRAFT_DEDUPE_WINDOW_MS`) returns the first draft's id with
    `deduplicated: true` and creates nothing (`mcp/draft-dedupe.ts`). The subject
    is part of the key, so a body kept and a subject changed is a new draft. It is
    in-process like the cap, so per instance: a retry that lands on another
    instance can still create a second draft. Bounded by a sweep on every insert
    and a ceiling of 2,000 entries. A draft the user deleted inside the window
    still answers a retry with its old id.
  - **Never sends.** No send call exists in the module or its helpers (a test
    reads the sources), and every test in the file asserts a `sendEmail` spy stayed
    uncalled. No local state is written: no reply chip, no `repliedAt`, no
    candidate-intake status, because nothing was sent.
  - **Verify result.** Flag x permission x plan for list and call; foreign id;
    Outlook; unsupported and soft-error passthrough; the row's account at every
    step; headers from the provider and never from input; From-only recipient with
    Reply-To ignored and no provider call on an unusable From; subject and body
    limits in code points; audit row identity, both caps and a failed insert; the
    retry guard; flag off byte-identical to `legacyMcpToolDefs`. The implementer
    (not CI) ran mutations on 2026-09-30, and each failed at least one test before
    it was restored. First round: `to` flowing from the validated input at the
    call site, `to` accepted from the arguments, From preferred over Reply-To,
    the row's account replaced by the primary, Outlook no longer refused, reply
    headers taken from the arguments, a send call added, the plan entry removed,
    the line-break check moved after trimming, the `userId` scope dropped from the
    lookup. Second round: Reply-To honoured again, From validated after a provider
    call, no body hash recorded, the recipient hashed without lowercasing, no
    per-tool cap, a capped draft spending the shared budget, the retry key without
    the user, a retry memory that never expires, nothing remembered, bidi controls
    not stripped, the body cap counted in UTF-16 units, the `userId` scope dropped
    from the shared lookup, no trim after the cut. (One more mutation, a comment
    accepted after the angle group, was survived: the later checks refuse the
    same inputs, so the guard was redundant and was removed.)
  - **Not covered.** No live Gmail call: the provider seam is a spy, so the MIME
    that `createEmailDraft` builds from `to`, `subject` and `reply` is checked
    only by its own existing tests. A5's write-tool page is still to do.
- **Before the flip (A4).** `MCP_WRITE_TOOLS_ENABLED` does not flip with
  `create_draft` live until both of these are settled:
  - **A visible marker on agent-created drafts.** Today an agent's draft is
    indistinguishable from the user's own in the Drafts folder, and the user may
    send it without reading it. A label or a one-line body prefix is needed. This
    is a **product decision**, not an engineering one: a prefix is visible in the
    sent mail if the user forgets to remove it, a label is invisible in some
    clients. Nothing in A4 adds one.
  - **A5's write-tool page must warn** that the draft goes to the original
    sender (never Reply-To, never an address the agent chooses) and that it must
    be read before it is sent.

**A5 — client setup docs.** Read-only part done 2026-10-01
(`docs/mcp/connect-clients.md`). Read-only part depends on nothing; the write part
follows A2 and A4. One page with snippets for Claude Code, Codex, Cursor,
Gemini CLI and the xAI API. Each snippet is checked against the vendor's
current documentation on the day it is written, and the date is recorded.
- 2026-10-01: all five vendor pages document a static `Authorization` header.
  Open point: xAI's remote MCP page does not say whether `authorization` gets a
  `Bearer ` prefix added. The snippet passes the full `Bearer klorn_sk_...`
  value, following xAI's Speech to Speech example. Not tested end to end.

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

**B0 — reply headers on provider drafts (seam and Gmail builder).** Depends on:
nothing.
- Context: Gmail threads a draft or message only when it carries the
  `threadId`, matching References and In-Reply-To headers, and a matching
  Subject (https://developers.google.com/workspace/gmail/api/guides/threads).
  `sendEmail` takes In-Reply-To and References through `SendMailOptions`. One
  MIME builder in `mail/gmail.ts` produces the headers for send and draft.
- Tasks: `createDraft(userId, draft)` takes an options object,
  `{to, subject, body, threadId?, attachments?, linkedInboxAccountId?, reply?}`,
  where `reply` is `{inReplyTo?, references?}`. `SendMailOptions` shares the
  two reply fields. `mail/reply-headers.ts` parses message ids out of
  untrusted values and discards all other text. A message id is `<` plus 1 to
  255 printable ASCII characters other than `<` and `>`, plus `>`.
  In-Reply-To carries the last valid id. References carries the first id plus
  the last 20, deduplicated, folded at 78 characters. A header with no valid
  id is omitted, and a non-string value counts as absent. The builder uses it
  on both paths. The Google provider passes the draft to `createEmailDraft`.
  The Outlook provider accepts the object and ignores `threadId` and `reply`.
  `unsupportedMailActions` needs no change, because its `createDraft` ignores
  its arguments. The reply route sets `threaded` from whether an In-Reply-To id
  was emitted, using the same parser.
- Verify: parser tests first, then MIME tests for draft and send: headers
  present when given, header order fixed, the no-reply MIME byte-identical for
  the plain and the multipart branch, injection input never reaching a header,
  identical headers on both paths, linked account id still selecting the
  account. Provider tests pin Google forwarding, the unsupported result and
  unchanged Outlook payloads. A route test pins that `gmail-draft` passes the
  same values as before and no `reply`. Full gate.
- Exit: `gmail-draft` passes the same values as before. The send path does
  change. Reply headers are now parsed into message ids, so free text in a
  header value is dropped and a header with no valid id is omitted. A reply
  whose Message-ID cannot be parsed goes by `threadId` only and reports
  `threaded: false`.
- Rollback: revert the PR. No schema, no flag.
- Follow-up: wiring the existing `gmail-draft` route to pass reply headers is
  a separate fix, verified against a real Gmail account.

**B0b — Microsoft native reply.** Depends on: B0. Landed 2026-09-30, flag OFF:
Outlook is behind
`OUTLOOK_INBOX_ENABLED` and Azure is not registered, so nothing here is reachable in
production.
- Context: Graph `sendMail` cannot set In-Reply-To, so Outlook replies and reply
  drafts are made from the original message and Graph threads them itself.
- Landed:
  - **Graph calls** (all four scopes were already requested: `Mail.Read`,
    `Mail.ReadWrite`, `Mail.Send`). Reply or reply draft: `POST
    /me/messages/{id}/createReply` (`Mail.ReadWrite`, 201 plus the draft:
    <https://learn.microsoft.com/en-us/graph/api/message-createreply?view=graph-rest-1.0>),
    then `PATCH /me/messages/{draft}` for subject, body and recipients (updatable
    only while `isDraft` is true:
    <https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0>),
    then `GET /me/messages/{draft}/attachments?$select=id` and a `DELETE` per entry
    (<https://learn.microsoft.com/en-us/graph/api/message-list-attachments?view=graph-rest-1.0>,
    <https://learn.microsoft.com/en-us/graph/api/attachment-delete?view=graph-rest-1.0>),
    then `POST /me/messages/{draft}/attachments` per file, under 3 MB each
    (<https://learn.microsoft.com/en-us/graph/api/message-post-attachments?view=graph-rest-1.0>).
    A reply also does `POST /me/messages/{draft}/send` (`Mail.Send`, 202:
    <https://learn.microsoft.com/en-us/graph/api/message-send?view=graph-rest-1.0>).
    A draft stops after the PATCH and never sends. Every call carries the existing
    `Prefer: IdType="ImmutableId"`.
  - **Why not `POST /me/messages/{id}/reply`**
    (<https://learn.microsoft.com/en-us/graph/api/message-reply?view=graph-rest-1.0>).
    Its JSON form takes `comment` or `message.body`, and the service wraps it in an
    HTML reply with the quoted original, so the bytes sent are not the approved
    bytes. The page says the reply goes to the original's `replyTo` instead of its
    `from`, and calls `message.toRecipients` an update to the reply without saying
    whether it replaces that default. createReply plus PATCH sets body and
    recipients exactly, at the price of three calls instead of one. A reply sent
    this way has no quoted original, as Gmail's does not.
  - **Seam** (additive; Gmail and IMAP receive exactly what they did). The type
    `ReplyTarget` (`replyToProviderMessageId?: string`) is added to `SendMailOptions`
    and `CreateDraftInput`; `MailProviderActions` gains the optional capability
    `nativeReply` (only OUTLOOK sets it); `SendMailResult` success gains optional
    `threaded`, set true only by the native path. One helper,
    `replyTargetFor(actions, providerMessageId)` (`mail/providers/reply-target.ts`),
    returns `{}` for a provider without the capability, so no caller adds a key for
    Google or IMAP. The id is the original's `EmailMessage.gmailId`
    (`outlook:<email>:<graphId>`) from the row the route or tool resolved by `userId`
    and linked account, never the URL id, a request body or an agent argument; an id
    of another mailbox throws before any Graph call. Three callers use it: the reply
    route, the `gmail-draft` route and `create_draft`.
  - **Recipient pinning: explicit, and verified before anything is sent.** The
    recipient is the `to` the caller passed (the reply route's parsed From; the
    pinned From for `create_draft`). The PATCH sets `toRecipients`, `ccRecipients`
    and `bccRecipients` explicitly, which replaces the Reply-To default createReply
    chose. The PATCH answer is then checked: unless the draft is addressed to that
    one address and no Cc or Bcc, the draft is deleted and the call throws, with
    nothing sent. A missing To list counts as a mismatch (fail closed); a missing Cc
    or Bcc list counts as empty. A refusal was not chosen, because the human
    `gmail-draft` route lets the user pick the recipient; naming it explicitly keeps
    that and stays a single rule for every caller. The address comparison folds
    ASCII case only; To, Cc and Bcc must each be present in the answer.
  - **What is sent is checked too (second review round).** The same PATCH answer
    must show the approved subject, `body.contentType` `text`, and the approved body
    after CRLF to LF, or the draft is discarded and nothing is sent. createReply may
    copy the original's inline images onto the draft, outside what was approved, and
    `hasAttachments` leaves inline attachments out, so the draft's attachment list
    is always read and every entry deleted before ours are added; a list that cannot
    be read in full, or a delete that fails, fails the reply. This matters once the
    agent path threads, because the receipt hashes `{to, subject, body}` only.
  - **Failure handling.** A failure before the send discards the half-made draft,
    best effort: a delete that fails or is refused is logged (ids only, no mail
    text), does not flag the inbox for reconnect a second time, and has its own
    5 s budget. A draft can still be left behind when a discard fails, or when
    createReply's answer is lost or cannot be read (logged; there is no id to
    delete by). A rejected send (4xx) discards the draft. A send whose outcome is
    unknown (5xx, timeout, aborted request, network error) throws
    `SendOutcomeUnknownError` and leaves the draft, which may be the sent copy; the
    reply route answers it with 502 and "The reply may already have been sent. Check
    Sent Items before retrying." and records nothing as answered. **Gmail has the same
    gap** (a lost answer to its send is a plain failure); that is a follow-up, not
    part of B0b. A 401 or 403 is the existing soft `{error}` and flags reconnect. A
    gone original (404) throws and is never resent unthreaded, which could double-send.
    The whole reply has a 45 s budget (`REPLY_SEQUENCE_BUDGET_MS`): preparation stops
    when 30 s are spent and the send keeps a full 15 s call timeout of its own. The
    Graph status is kept out of the thrown error's `status` field, so Fastify does
    not turn a Graph 404 or 429 into the route's own status.
  - **Waiting on.** `sendEmail` still returns `messageId: null`, so the reply route
    records no `SentMessage` for an Outlook reply, and `syncSentMessages` reads the
    Gmail Sent folder only (`listGmailMailbox`), so an Outlook reply never joins
    "waiting on". Follow-up: if the draft id survives the send (see "Before the
    flip"), record a `SentMessage` with the thread id and that id.
  - **Reply route.** `threaded` is true for Outlook only when the provider reports
    it threaded natively; `getReplyHeaders` stays `{}` and the header path is
    Gmail and SMTP only.
  - **A4.** `create_draft` no longer refuses Outlook unconditionally: it answers
    unsupported, byte for byte as before B0b, while `OUTLOOK_INBOX_ENABLED` is off
    (read on each call; dispatch itself is not flag-gated, so an existing OUTLOOK row
    would otherwise draft), and drafts natively with it on. Its tool description no
    longer mentions Outlook. The recipient is still the original From (never Reply-To); the
    agent still supplies no header, thread, account or reply-target argument, and
    every such argument is refused. The reply target is the row's `gmailId`.
  - **Floor unchanged.** The agent `send_email` path is deliberately NOT threaded:
    `in_reply_to_email_id` still only picks the account and an Outlook send from the
    agent is a plain `sendMail`. The receipt hash still covers `{to, subject, body}`
    under `RECEIPT_SCHEMA_VERSION` "v1", and it does not cover the thread. Threading
    that path is agent-supplied reply context, which the A4 rule above answers with
    the resolved ids in the hash and a version bump. That is a separate decision.
    `outlook-reply-floor.test.ts` pins this.
- Verify result. Tests were written first and run red; a review round (code and
  security, same day) added the checks above, also test-first. `outlook-native-reply.test.ts`
  fakes Graph with a stateful draft and asserts every request (URL, verb, body,
  headers, order). Route tests run the real dispatch and Outlook provider over a
  fetch double. The implementer (not CI) ran mutations on 2026-09-30 and each failed
  at least one test before it was restored: the reply path falling back to `sendMail`;
  the original id taken from the URL (reply route), from the URL (draft route) and
  from the agent's `email_id` (`create_draft`); the PATCH without `toRecipients`;
  the recipient check removed; the capability check removed so every provider gets a
  target; no cleanup of a half-made draft; an unknown-outcome send also deleting the
  draft; `threaded` reported without the header rule; the agent path threading from
  `in_reply_to_email_id`.
- Not verified: no Microsoft 365 tenant was reached; Graph is a test double built
  from the documentation. In particular unconfirmed: that the PATCH answer includes
  `toRecipients`, `ccRecipients`, `bccRecipients`, `subject` and a `body` with
  `contentType` `text` (the checks refuse a send otherwise, so a Graph that answers
  `html` would refuse every reply); that a body PATCHed to plain text replaces the
  quoted original; that the attachment list of a new reply draft shows its inline
  images; and that the draft id survives the send.
- Before the flip (OUTLOOK_INBOX_ENABLED, after Azure registration), on one personal
  and one work or school mailbox: a reply through `POST /api/email/:id/reply`; a
  reply draft through `gmail-draft` and through MCP `create_draft`; then open both
  in Outlook on the web and check that each sits in the original's conversation,
  that the quoted text is absent, that the recipient is the original sender even
  when the original carries a Reply-To, and that the attachment path works under
  and over 3 MB. Also check
  that no draft is left behind after a forced PATCH failure. Check that the PATCH
  answer carries the fields the verification needs, and that an original with inline
  images yields a reply with none. **Does the draft id survive the send?** Call
  `GET /me/messages/{draftId}` after a send: if it resolves, record a `SentMessage`
  with the thread id and that id so "waiting on" works for Outlook; if not, the
  follow-up needs another way to find the sent copy.
- Rollback: revert the PR. No schema, no flag.

**B1 — IMAP flag actions for Naver and iCloud.** Depends on: nothing. Landed
2026-09-30, flag OFF.
- Context: `providers/dispatch.ts` maps NAVER, ICLOUD and IMAP to
  `unsupportedMailActions`. `imapflow` is already a dependency.
- Tasks: read, unread and star over IMAP flags, behind a new OFF flag.
  Preserve the three-way result contract (`unsupported` / `error` /
  `success`).
- Verify: tests first against a mocked IMAP client, including the Phase 0b
  regression: an action reports success and the message reappears on the
  next poll.
- Landed:
  - `IMAP_ACTIONS_ENABLED` (`imapActionsEnabled()` in `config.ts`, lenient
    parse, read at request time). `dispatch.ts` routes NAVER and ICLOUD to
    `mail/providers/imap.ts` only while it is on. ICLOUD additionally needs
    `ICLOUD_INBOX_ENABLED` (`enabledImapProviderKeys()`), so the iCloud freeze
    holds whatever this flag says. Off, `mailActionsForProvider` returns the
    same unsupported object as before; generic IMAP is unsupported either way.
  - `markAsRead` and `toggleRead` set or clear `\Seen`, `toggleStar` sets or
    clears `\Flagged`. INBOX only, by UID, through `messageFlagsAdd` or
    `messageFlagsRemove` with `{uid: true}`. Every other action is spread from
    `unsupportedMailActions` and still answers 501. Archive and trash are B2.
  - Message id: `mail/imap-message-id.ts` accepts exactly
    `<idPrefix>:<email>:<uid>`. The email comes from the account row, never
    from the id. The uid is canonical decimal, 1 to 4294967295. Anything else
    (other prefix, other mailbox, ranges, signs, padding) is refused before a
    connection opens. `imap-sync.ts` writes ids through the same module.
  - Account and connection: the row is found by (id, userId, provider).
    `mail/imap-connection.ts` holds what the poller, the verify handshake and
    the actions share: `checkImapRow` (credentials, SSRF allowlist, host pin,
    returning narrowed values), `createImapClient` and `endImapSession`.
    `createImapClient` enforces the allowlist and host pin itself (the sink),
    so no caller can build a client for another host. Timeouts are named
    constants (connect 10 s, greeting 10 s, socket 15 s).
  - Sessions (`providers/imap-session.ts`): a call never opens its own login.
    Operations are queued per linked account; one worker opens one session,
    drains everything queued (including what arrives while it logs in), and
    logs out, at most 200 operations per session. Consecutive operations that
    want the same change become one STORE and one read-back, in queue order.
    If the server refuses a coalesced STORE, the set is split in halves and
    retried down to single UIDs (at most 40 STOREs per run), so one vanished or
    rejected UID does not fail the others. Every caller gets its own result. At most 3 action sessions run at once
    across all accounts; the poller is unaffected. After a rejected login,
    actions for that credential answer `{error}` without connecting for 15
    minutes (a reconnect stores a new cipher and ends it early), logged once
    per cooldown. Transport failures reach Sentry at most once per account per
    10 minutes. This bounds the callers that burst: bulk read/unread (up to 100
    ids in `Promise.all`), promo auto-read, MCP batches, plain PATCH. State is
    in-process.
  - Success means the server holds the flag. imapflow resolves `true` for a
    STORE on a UID that no longer exists, so every run is read back with a UID
    FETCH of FLAGS. Message gone, flag not applied, STORE refused, and a FETCH
    answer with no FLAGS item all answer `{error}`; none confirms.
  - Result contract: `{error}` for id, account, auth, transport and database
    failures and for an unconfirmed change. These actions never throw and never
    answer `unsupported`. That is safe for read and star because every caller
    writes the local row regardless of the result. It is not safe for trash and
    archive, whose callers delete locally on `{error}`: B2 must revisit it
    (see `providers/outlook.ts`).
  - Local state: after a confirmed change the row is updated with
    `updateMany({userId, gmailId})`, as the Gmail path does. If that update
    fails, the caller gets `{error}` saying the server changed and the next
    sync will catch up.
  - Accepted divergence: the read, star and bulk-read routes write the local
    row whether or not the provider applied the change, so a provider `{error}`
    leaves the local row ahead of the mailbox until the next poll rewrites it
    from server flags. Responses are unchanged; the provider error is now
    logged (`providers/log-soft-failure.ts`) with the local row id. `unsupported`
    stays a silent local-only update.
  - Poll interaction: the poll rewrites `isRead`, `isStarred` and `labels` from
    server flags for the last 50 messages every cycle, so a confirmed change and
    the next poll agree and no row is re-created. One window remains: a poll
    that read flags before the action landed persists the old value, and the
    next poll converges. `imap-actions-poll-regression.test.ts` runs the real
    poll and persist path against a stateful fake server, for NAVER and ICLOUD.
  - Poller fixes found on the way (pre-existing): the poller and verify clients
    had no `error` listener (imapflow emits `error` when no command is pending;
    unhandled, Node throws it, and `src` has no uncaughtException handler) and
    no close on failure paths. `createImapClient` now attaches a logging
    listener for every caller, and the poll and verify sessions always end with
    LOGOUT and a hard close.
  - Auth failure is logged and returned as `{error}`. It does not set
    `needsReconnect`, because the poller does not either: Phase 0b deferred
    that flagging and the Naver and iCloud reconnect copy as one change.
- Not verified: no real Naver or iCloud server has been reached; behaviour
  rests on a mocked imapflow.
- Before the flip: run read and star against one real Naver account and one
  real iCloud account (iCloud also needs `ICLOUD_INBOX_ENABLED`), including a
  bulk mark-read of several messages and a promo auto-read, and confirm one
  login per burst in the provider's logs or the API log. Also test a 200-UID
  coalesced STORE against real Naver and iCloud and confirm how each server
  answers a UID set containing a missing UID: a tagged OK, which the read-back
  then reports as missing, or a NO, which the split retry handles. The promo path
  (`markPromotionalEmailRead` in `judge/email-firewall.ts`) reaches IMAP
  mailboxes while the flag is on; the queue bounds it, but only a real
  mailbox shows how Naver and iCloud react.
- Blocker for B2, not for B1: UIDVALIDITY is not stored. A mailbox whose
  UIDVALIDITY changed makes a stored UID address a different message. For read
  and star that marks the wrong message, which is recoverable and self-heals on
  the next poll; archive and trash would move or delete the wrong one. B2 must
  store the validity with the row. Cheap mitigation to consider first: before
  the STORE, fetch the envelope of the UID and compare subject and date with
  the local row, and refuse on mismatch.
  Resolved by B2: the validity is stored per account and compared by every
  IMAP action, read and star included (see B2).

**B2 — IMAP move actions.** Depends on: B1. Landed 2026-09-30, flag OFF.
- Context: NAVER and ICLOUD `trash`, `untrash`, `archive` and `unarchive` were the
  unsupported stubs. An IMAP MOVE gives the message a NEW UID in the destination
  folder, and trash and archive remove the local row (as Gmail's do), so where the
  message went has to be recorded somewhere that outlives the row. Trash is a MOVE
  to the Trash folder. It is never `\Deleted` plus EXPUNGE, which is
  `delete_permanent` and sits on the floor.
- Landed:
  - Flag: `IMAP_MOVE_ACTIONS_ENABLED` (`imapMoveActionsEnabled()` in `config.ts`,
    lenient parse, read at request time), independent of `IMAP_ACTIONS_ENABLED` and
    `IMAP_SEND_ENABLED`. `dispatch.ts` builds each combination of the three flags
    once, on first use (`composeImapActions`); every part overrides only its own
    actions. All three off returns the same unsupported object as before. ICLOUD
    additionally needs `ICLOUD_INBOX_ENABLED`; generic IMAP is unsupported whatever
    the flags say. `imap-move-dispatch.test.ts` pins the matrix and that the
    flag-off answers equal the stubs' and build no IMAP client.
  - UIDVALIDITY, per account, fail closed. `LinkedInboxAccount.inboxUidValidity`
    (nullable TEXT, canonical decimal: the value is an unsigned 32-bit integer, over
    a signed INTEGER, is only compared for equality, and a BigInt column would make
    any code that serializes a whole row throw). The poller (`imap-poll-guards.ts`)
    compares the INBOX value the server reports with the stored one each cycle:
    none stored, it stores it (the baseline); unchanged, nothing; the server reports
    no usable value, nothing; a different value is a reset (holding pattern, below).
    Actions (`imap-session.ts`,
    `imap-move-run.ts`) compare the live value after selecting a mailbox: INBOX against the
    account's value, for the flag runs of B1 (read and star) and for moves out of
    INBOX; a parked folder against the value recorded with the move; and an undo
    also checks INBOX, where the message lands, with STATUS. A mismatch answers
    `{error}` with no command sent and is logged once per row and change. A row with
    no stored value (no poll since deploy) is refused too, so read and star answer
    `{error}` until the first poll after this lands has baselined the account.
  - Reset handling: a holding pattern (decision, revised 2026-09-30 after the security
    and database reviews; the first version deleted the mailbox's rows on a reset).
    On a reset (stored differs from live) the poller changes NOTHING: it does not
    delete, resolve attention items or store the new value, and it does not stop. It
    logs a warning and reports one Sentry event per account and live value (in-process
    dedupe, row id and the two numbers only), then ingests exactly as before B2.
    Because the stored value stays the old one, every action keeps refusing that
    mailbox, read and star included. The poll's race cleanup for moved messages is
    skipped while the mailbox is held. The collision that a repair would fix (a NEW
    message that reuses an old UID is deduped against the stale row, so it is not
    ingested) exists on main and is unchanged; `imap-moves-poll-regression.test.ts`
    pins it as a characterisation. Why not repair on the spot: one observation of one
    value, from a poller that may overlap itself, against a server that could be
    flapping, would delete rows with user work attached (attachments, candidate
    intakes, summaries, stars, replied state). The repair is B2b below. Until B2b
    lands, a held mailbox stays refusing IMAP actions until an operator resolves it.
  - Envelope guard. Before any MOVE, `UID FETCH (ENVELOPE)` of the UIDs, compared with
    what Klorn knows (`imap-envelope.ts`): Message-ID when both sides have one,
    otherwise the subject as the poller stores it and the date (skipped when the
    message has no Date header). Moving out, what Klorn knows is the local row
    (subject and `receivedAt`; the row has no Message-ID column); moving back, the
    record. A mismatch answers `{error}`, and an undo then drops the dead record.
    B1's flag runs do not get this guard (one more FETCH per run; a wrong flag is
    recoverable).
  - Folders (`providers/imap-folders.ts`), same trust model as B3: a SPECIAL-USE flag
    the server reported (`specialUseSource` "extension", or the caller's "user"
    hint) is trusted; imapflow 1.7.0 also reports looser name guesses as "name",
    which proves nothing, and the exact-name lists for `\Trash` and `\Archive` are
    EMPTY. The Apple and Naver help pages B3 cites, fetched on 2026-09-30 without running
    their scripts, contained no IMAP folder name for either role, so none is invented;
    adding one is a one-line change once a real LIST documents it. One trusted folder per role,
    never INBOX, nothing when two claim the role. No trustworthy folder: that action
    is `unsupported` on that account. Naver is not known to have an archive folder (not
    verified), so archive may be unsupported there. The folder list is asked for once per
    session. B3's copy of these rules in `imap-send.ts` is not touched (another
    change edits that file); folding the two together is a follow-up.
  - MOVE only. The session requires the MOVE capability. imapflow 1.7.0's
    `messageMove` without it falls back to COPY, `\Deleted` and EXPUNGE, which is a
    permanent delete by another name, so without MOVE nothing is sent and the answer
    is `unsupported`. The fake server models that fallback, and a test fails if any
    path reaches it (`destructiveCommands` is asserted empty after every test).
  - Where moved messages are tracked: table `ImapMovedMessage` (migration
    `20261003010000_imap_move_tracking`), not columns on the row, because trash and
    archive delete the row. One row per parked message, unique on
    (`linkedInboxAccountId`, `sourceId`) where `sourceId` is the INBOX id it had:
    `role` (TRASH or ARCHIVE, so an undo of one never restores the other),
    `folderPath`, `folderUid` (BIGINT), the folder's own `folderUidValidity`, and
    `messageIdHeader`, `subject`, `sentAt` for the envelope guard. It is written
    after the server confirmed the move and before the row is deleted; if writing it
    fails the move still succeeds (the message IS parked) and only undo is lost. Undo
    consumes it; a record older than 30 days is swept by the next move for the same
    account and by the log-retention job (`imapMovedMessage`, on `createdAt`, which is
    indexed for that range scan; that job is off until `LOG_RETENTION_ENABLED` is set).
    Both foreign keys cascade and `purgeUserData` deletes it.
  - Undo and the poller's dedup key. The MOVE back gives the message a new INBOX UID,
    so `untrash` and `unarchive` answer `restoredMessageId` (the new id). The route
    (`routes/email-undo.ts`) re-syncs that one message through the same persist path
    as the poll (`syncImapMessageForUser`, one UID fetch) and answers
    `{gmailId: new id, emailId}`; the next poll finds the key already there and
    creates nothing. If that re-sync fails after a confirmed restore the answer is 502
    "Restored on <provider>, but Klorn could not refresh its copy. It will reappear
    after the next sync." Web clients send no account id on undo, so for an
    IMAP-looking id the account comes from the record, and only while the flag is on.
    A poll that read its window before a trash landed would write the row back;
    after persisting its window the poll removes rows for INBOX ids moved out within
    the last 10 minutes (`removeRecentlyMovedRows`), so that race heals in the same
    cycle. `imap-moves-poll-regression.test.ts` runs the real poll, the real
    persist path and the real provider against the stateful fake server: action, then
    poll, then poll again, with no duplicate, no resurrection and no loss, for trash,
    archive and both undos, plus a reset (held, not repaired).
  - Result honesty. `{success: true}` only when the server confirmed where the message
    went: the COPYUID of the MOVE answer, or, when the server sends none, a search of
    the destination for the message's own Message-ID. The destination's UIDNEXT and
    UIDVALIDITY are read before the MOVE, and only a hit at or above that UIDNEXT counts
    (a copy of the same Message-ID that was already in Trash is never taken for the
    moved message, which would make an undo restore the old copy); more than one new
    hit, or a destination renumbered in between, claims nothing. Anything
    else is `{error}`; no folder or no MOVE is `unsupported`. The trash and archive
    routes used to delete or hide the row on any `{error}`, which is right for
    Gmail and Outlook (`{error}` means "not connected") and wrong here, where it
    means the message is still in the mailbox. `isImapFamily` (`error-semantics.ts`)
    makes both routes answer 502 and keep the row for NAVER, ICLOUD and IMAP;
    Gmail and Outlook behave as before. A retry after a confirmed move whose local
    delete failed completes from the record instead of failing on a message that is
    no longer in INBOX.
  - Concurrency. Moves run through the same per-account queue and session slots as
    B1 and B3. Consecutive moves to the same destination become one `UID MOVE`; a
    refused set is halved and retried down to single UIDs within 40 commands
    (`MAX_MOVE_COMMANDS_PER_RUN`). A session selects one mailbox at a time
    (`imap-mailbox-switch.ts`): a second `getMailboxLock` while one is held waits
    forever in imapflow, and the fake throws on it. A session that only touches INBOX
    still takes one lock. The bulk archive route used to await each message in turn,
    which would have cost one login per message; it now starts the IMAP moves together
    (Gmail keeps its order), so they coalesce into one login and one MOVE.
  - Tests: `imap-move-actions.test.ts` (provider, fake server and strict database),
    `imap-moves-poll-regression.test.ts`, `routes-email-moves.test.ts`,
    `imap-move-dispatch.test.ts`, `imap-uidvalidity.test.ts`, `imap-folders.test.ts`,
    and the UIDVALIDITY cases added to `imap-provider-actions.test.ts`. Mutation
    checks, each caught: the validity check removed (before a move, for flag runs,
    for the parked folder, for the INBOX an undo lands in, and the poller's reset
    detection);
    the MOVE-capability guard removed, and trash written as COPY plus delete (the
    EXPUNGE path); the destination UID or its validity not stored, or stored wrong; the
    envelope guard removed; the read-back replaced by a claimed success; the routes'
    `{error}` rule removed; the poll's cleanup removed, and the holding pattern made to
    delete, resolve or store; the read-back's UIDNEXT filter removed; role
    confusion; coalescing and split-retry removed; the strict id parse replaced; the
    iCloud gate removed.
- Not verified: no real Naver or iCloud server has been reached. Behaviour rests on
  a stateful fake imapflow server and the strict in-memory database. Whether each
  server advertises MOVE and UIDPLUS, flags its Trash and Archive folders with
  SPECIAL-USE, sends COPYUID in the MOVE answer, and how it answers a MOVE whose set
  contains a missing UID are all unknown.
- Known limits: a connection lost after the MOVE but before it is confirmed answers
  `{error}` for a message that may have moved (the row stays, a retry says it is no
  longer in INBOX, and no record exists to restore it); B3's `getReplyHeaders`, Sent
  copy and Drafts do not compare the stored UIDVALIDITY yet (`imap-send.ts` was not
  touched); a poll and the undo re-sync can race to create the same new row, and the
  loser's unique violation is reported as a late re-sync, the row existing; undo
  works for 30 days after the move, then answers that nothing was recorded; a held
  mailbox (reset observed) refuses every IMAP action until it is repaired, and its new
  mail that reuses an old UID is not ingested (as on main); a read-back that finds
  the moved message neither by COPYUID nor as the single new hit above the prior
  UIDNEXT answers `{error}` for a message that did move. Relinking a held account
  (unlink, link again) creates a new row whose stored value is NULL, so the next poll
  baselines it from the live value and the pre-reset EmailMessage rows, which survive
  an unlink, become actionable again, guarded only by the envelope check. Until B2b,
  treat a relink of a held mailbox as a repair that needs its old rows retired first.
- Before the flip: first let one poll cycle pass after the deploy so that
  `inboxUidValidity` is set on every NAVER and ICLOUD row (count the NULLs); until then
  every IMAP action, read and star included, refuses. Then, on one real Naver and one
  real iCloud account (iCloud also needs `ICLOUD_INBOX_ENABLED`): record CAPABILITY
  (MOVE, UIDPLUS), the LIST with every folder name and SPECIAL-USE flag (Trash,
  Archive, Junk), and whether a MOVE answer carries COPYUID. Trash a message and see it
  in the provider's webmail Trash, its row gone, and two polls leave it gone. Untrash
  it: it is back in INBOX once, under a new id, after two polls. Repeat with archive and
  unarchive on iCloud; on Naver record whether archive works or answers the 501 copy. Bulk-archive five
  messages and confirm one login and one `UID MOVE` in the logs. Try the holding
  pattern on a test account: set `inboxUidValidity` to another value in the database and
  confirm that every action (read, star, trash, archive, undo) refuses, that polling goes
  on, that one warning and one Sentry event appear however many polls run, and that no
  row, attention item or move record changes; then set the value back. Do not rely on
  a real reset being repaired until B2b has landed. Check what a MOVE with a missing UID
  in the set returns (NO, which the split retry handles, or OK). Smoke-test Gmail
  archive, trash and both undos, which share the routes.

**B2b — non-destructive UIDVALIDITY reset** (*outline*). Depends on: B2. Required
before anything relies on a server reset being repaired; B2 only holds (refuses
actions, reports once). Deleting the mailbox's rows on a reset was rejected in review:
it takes user work with it and acts on one observation. The repair keeps every row:
- Stale rows are tombstoned by re-keying, in ONE transaction that is guarded by a
  conditional `updateMany({where: {id, inboxUidValidity: stored}, data: {inboxUidValidity: live}})`
  whose count must be 1, so two overlapping polls cannot both apply it.
- The stale rows' `gmailId` gets the suffix `#uv<old>`. The strict id parse (B1) then
  refuses them, and a NEW message that reuses an old UID gets its own row. Row ids are
  kept, so commitments and other things keyed by the row id are unaffected.
- Tombstoned rows are hidden explicitly from every list and count (an explicit
  filter, not a side effect of the id), and their attention items are resolved. Nothing
  is deleted.
- The new value must be seen on two consecutive polls before anything changes, and at
  most one reset is applied per account per day, so a flapping server cannot churn.
- The PUSH dedupe marker is text of the form `[gmailId]`; a new message that reuses an
  old UID would be suppressed by the old marker, so the marker is keyed by row id.
- Relink: an unlink keeps the EmailMessage rows and a relink baselines from the live
  value, so the relink path must tombstone rows of the old numbering too (or refuse to
  baseline while rows exist under an unknown value).
- Verify: the same fake server, a reset with a reused UID, overlapping polls, a
  flapping value, a relink.

**B3 — SMTP send for IMAP providers.** Depends on: B0, B1. Landed 2026-09-30,
flag OFF.
- Context: NAVER and ICLOUD `sendEmail`, `createDraft` and `getReplyHeaders` were
  the unsupported stubs. The send path stays behind the deterministic floor.
- Tasks: SMTP send, drafts and reply headers for both providers behind a new OFF
  flag, each provider's SMTP host fixed in the registry, security review
  mandatory.
- Landed:
  - `IMAP_SEND_ENABLED` (`imapSendEnabled()` in `config.ts`, lenient parse, read
    at request time), independent of `IMAP_ACTIONS_ENABLED`. `dispatch.ts` builds
    each combination once: neither flag returns the same unsupported object as
    before; actions only is B1; send only is the three B3 actions over the
    unsupported stubs; both is the union. ICLOUD additionally needs
    `ICLOUD_INBOX_ENABLED` for either flag. Generic IMAP is unsupported whatever
    the flags say. `imap-send-dispatch.test.ts` pins every combination and that
    the flag-off surface is byte-identical (no transport, no IMAP client built).
  - SMTP endpoints live in the provider registry (`imap-providers.ts`, field
    `smtp`) with their source in a comment. Naver: `smtp.naver.com`, port 587,
    STARTTLS (https://help.naver.com/service/30029/bookmark/21344, read
    2026-09-30: "SMTP 포트 : 587, 보안 연결(TLS) 필요 (TLS가 없는 경우 SSL로
    연결)"). The page names SSL (implicit TLS, port 465 by convention) only as
    the fallback, so 587 is the default here; switching is one registry line. iCloud:
    `smtp.mail.me.com`, port 587, STARTTLS, full address as user name and an
    app-specific password (https://support.apple.com/en-us/102525, published
    2026-02-03, read 2026-09-30). The host is never taken from the row, from
    input or from the environment. A row whose stored IMAP host fails the
    allowlist or the host pin is refused before any connection or decryption
    (`findCheckedAccount`), so a tampered row neither sends nor leaks its
    credential; the SMTP host would have been the registry's in any case.
  - `nodemailer` ^10.0.13 is a new dependency of `@klorn/api`, and the root
    override floor rises from `>=9.0.1` to `>=10.0.13`: `requireTLS` is honoured
    from 10.0.12, and 10.0.13 (released 2026-09-30) contains the fix for
    GHSA-g73g-hqqh-jr95, a comment inside an angle-addr reaching the SMTP
    envelope, which is the path this step feeds. The package is imported when the
    first transport is built (one shared import), so while the flag is off it
    never loads. The package has
    no dependencies and no install script, ships its own types and an ESM entry,
    and is MIT-0. It adds no advisory: `pnpm audit --prod` on the rebased
    branch reports no known vulnerabilities (the axios and `@grpc/grpc-js`
    advisories seen on 2026-09-30 were cleared on main by #1337).
  - Transport (`mail/smtp-transport.ts`): `rejectUnauthorized` on, TLS 1.2 or
    newer, SNI pinned to the registry host, `requireTLS` for STARTTLS (a server
    that does not offer the upgrade fails the send, no AUTH is sent), connection
    10 s, greeting 10 s, socket 30 s, DNS 10 s as named constants, no logging of
    SMTP traffic, no file or URL access, no proxy, sendmail or pool, and a fixed
    EHLO name (`klorn.ai`) instead of the machine's hostname. `smtp-wire.test.ts`
    runs the REAL nodemailer against a local TCP socket: a refused STARTTLS fails
    with ETLS, a peer that hangs up or answers the handshake in plaintext fails
    too, and in every case only EHLO and STARTTLS were sent (no AUTH, no MAIL
    FROM, no message); the exact `raw` bytes and the explicit envelope reach the
    server dot-stuffed, with no header added, after EHLO `klorn.ai`.
  - One MIME builder: `buildPlainTextRawEmail` moved from `gmail.ts` to
    `mail/outbound-message.ts` (with the recipient helpers), `gmail.ts` imports it
    and re-exports `isNoReplyAddress` and `safeMimeType`. Without the new
    `standalone` argument the output is byte-identical: `outbound-message.test.ts`
    replays 1440 combinations (recipient, subject, body, attachments, reply
    headers) against `fixtures/gmail-mime-main.json`, the sha256 of what main's
    own builder returned for each (captured from commit 1c7c767c). SMTP and APPEND
    pass `standalone`, which adds From (the linked account), Date and Message-ID,
    in that order after To and Subject, encodes the text part as base64 so the
    bytes are 7-bit clean whether or not the server offers 8BITMIME, folds Subject
    into encoded-words of at most 75 characters cut on code-point boundaries, and
    folds a long attachment name into RFC 2231 continuations (ASCII fallback capped
    at 40 characters), so no header line exceeds 998 octets and the ones it
    controls stay within 78. Reply headers
    go through `reply-headers.ts` exactly as on Gmail. The Message-ID is
    generated here (`<uuid@sender-domain>`) and returned as `messageId`,
    because nodemailer's `info.messageId` for a `raw` message is not the header's.
  - Recipient: the Gmail `sendEmail` guard (one address, valid, not a no-reply
    sender) is now one function, `checkSendRecipient`, used by both. Then
    `toSmtpAddress` admits only a bounded ASCII dot-atom addr-spec, with no
    control character anywhere in the input; quoted, bracketed, commented,
    IP-literal and internationalized addresses are refused. The header carries
    that bare address, so a display name is dropped and a non-ASCII one cannot
    reach a header. The envelope sender is the account's own address, which must
    pass the same check.
  - Sent copy. Neither Apple's nor Naver's documentation says whether SMTP files
    a copy in Sent, and mail clients that submit to iCloud store their own with an
    APPEND. So the sender asks: after a successful SMTP send it opens IMAP, finds
    the Sent folder by role (`list()`), searches it for the message's own
    Message-ID, and APPENDs with `\Seen` only if it is absent. A server that
    saves its own copy gets none from us; one that does not gets exactly one. The
    copy starts once the caller HAS its success (the 250), still holding the
    account's turn and a session slot, and has its own hard deadline of 5 s
    (`SENT_COPY_DEADLINE_MS`: the IMAP client is closed, a warning logged). It is
    outside the task's total timeout, so it can neither delay the result nor turn
    a delivered send into "unconfirmed", and a failure in it never changes the
    result.
    Folder trust: imapflow 1.7.0 folds its looser name-guess tier into
    `specialUseSource: "name"`, so that source alone proves nothing. A role from a
    server SPECIAL-USE flag (`extension`) is trusted; one from the name only when
    the leaf is exactly `Sent`, `Sent Messages` or `Drafts`, case-insensitive.
    Anything else ("Sent Items", "Sent Mail", a localized name), a role with no
    source, and any `\Noselect` or `\NonExistent` folder is not written to (no
    copy, or a draft `{error}`). Korean names are deliberately not in the set:
    Naver's help documents its web folders (for example "임시보관함",
    https://help.naver.com/service/30029/contents/21155) but not what IMAP LIST
    reports.
  - Drafts: APPEND to the `\Drafts` folder, found the same way, with `\Draft`
    and `\Seen`; the reply context is honoured. `draftId` and `messageId` are the
    Message-ID. They are deliberately not a `<idPrefix>:<email>:<uid>` id: a UID
    in Drafts used as an INBOX id would make the B1 flag actions hit an unrelated
    INBOX message. `url` is the provider's webmail root (registry `webmailUrl`).
    `/gmail-draft` still passes no `reply`, so route drafts are unthreaded until
    that B0 follow-up.
  - `getReplyHeaders`: the row's UID (strict id parse from B1, the email from the
    row), one `UID FETCH` of Message-ID and References, the result parsed through
    `reply-headers.ts` so only message ids cross the seam. `{}` for any failure.
  - Concurrency and safety (`providers/imap-session.ts`): ONE per-account queue
    carries both the B1 flag work and the B3 tasks (send, draft, header read)
    of a linked account, one at a time in either order; the poller stays
    separate. Each task holds one of the same three session slots as the flag
    actions for its whole duration; the auth cooldown is B1's (row id plus
    cipher), so a rejected SMTP login (reply 530, 534 or 535 on `EAUTH`) stops
    read and star, and a rejected IMAP login stops sends, drafts and header reads,
    until the user reconnects. Every wait is bounded, in this order: a task that
    has not started within 20 s (`TASK_QUEUE_WAIT_MS`) answers `{error}` saying
    the mailbox was busy and nothing was sent or saved, and is never started
    afterwards, so "busy" can never become a late send; a user may have at most 10
    tasks queued or running (`MAX_OUTSTANDING_TASKS_PER_USER`); a running task is
    bounded at 60 s (`TASK_TOTAL_TIMEOUT_MS`), at which point its SMTP socket is
    destroyed and the caller is told delivery is not confirmed (see the next
    bullet for why destroying matters). Worst case for a caller is about 80 s. `withImapClient` (one session helper, also under the B1
    `withInbox`) ends every session, LOGOUT then a hard close, and the tests pin
    that the session ends and every mailbox lock is released on every path. Transport failures reach Sentry at
    most once per account per 10 minutes. Logs and Sentry get only the error's
    class, code, reply code and failing command, never its text (a server reply
    can quote the recipient). Results follow B1: `{error}` for every failure,
    never `unsupported`, never a throw.
  - Abort and delivery wording (follow-up to the focused re-review). nodemailer's
    `transport.close()` does not close an in-flight connection (for the non-pooled
    transport it only emits an event), and the connection's own `close()` only
    half-closes the socket, which a stalled server never answers. So the sender
    creates the socket itself, hands it to nodemailer (its documented `socket`
    option) and destroys it on abort and when the send returns: a message not
    acknowledged before the deadline cannot be acknowledged, or delivered, after
    it, and an orphaned send that wakes up late (even one still importing
    nodemailer) checks the abort signal, sends nothing, logs into IMAP for no
    copy and releases nothing it does not own. An abort before nodemailer has
    connected is not undone either: nodemailer resolves the hostname first (up to
    the task deadline on a DNS stall) and then calls `socket.connect()`, which on a
    destroyed Node socket reconnects it, so an aborted session makes its socket's
    `connect()` throw (nodemailer reports that as a connection error) and destroys
    a connect that was already in flight. Cost of the caller-provided socket: the
    connect is to the hostname, so Node does its own `dns.lookup` and nodemailer's
    fallback to the provider's other A records is not used. Neither that path nor
    nodemailer's own resolution filters private addresses; what keeps a connection
    on the provider is that the host comes only from the registry, and what stops a
    wrong server from receiving the credential or the message is TLS: certificate
    verification on, the server name pinned to the registry host, and STARTTLS
    required. SMTP cannot tell a connection that died before the message was handed
    over from one that died after, and nodemailer reports a stall after DATA as
    `ETIMEDOUT command=CONN`, exactly like a connect timeout, so the error's
    `command` proves nothing. What the sender knows is whether the TCP connection
    was ever established. Failures are answered by `classifySmtpFailure`: a
    rejected login keeps the reconnect wording and cooldown; a server's own
    refusal (sender, recipient, message) keeps its specific wording; a failure
    that provably came before any MAIL FROM (connection never established, DNS,
    TLS or STARTTLS, any other login failure, and a certificate, hostname or
    handshake failure after STARTTLS, which nodemailer reports as ESOCKET on CONN
    and which is recognised by Node's own message; an ESOCKET with any other
    message stays "unconfirmed") says "Could not reach X. The message
    was not sent; try again shortly."; ANY other error on an established
    connection, and the 60 s deadline, says "X did not confirm delivery. The
    message may or may not have been sent; check your Sent folder before trying
    again." and never "try again shortly". A nodemailer that cannot be imported
    says sending is unavailable and nothing was sent, not that the mailbox could
    not be reached. `imap-send-wire.test.ts` runs all of this with the real
    nodemailer over real TLS (a throwaway certificate made with openssl at test
    time, trusted through `tls.connect`'s `ca`; verification stays on): a server
    that stalls after DATA sees its socket closed when the deadline fires, the
    caller gets the unconfirmed wording and no Sent copy is filed. It runs over
    implicit TLS and over STARTTLS (production uses STARTTLS on 587, where
    nodemailer wraps the caller's socket in a TLS socket), and covers an abort that
    lands during a DNS stall.
  - Floor: unchanged. `imap-send-floor.test.ts` drives `executeToolCall` for a
    message on a Naver inbox: no receipt, a null receipt and a receipt for other
    bytes are refused before any SMTP or IMAP object is built, exactly as for
    Gmail; a matching receipt reaches SMTP with the flag on and the unsupported
    answer with it off.
  - Reachable callers once the flag is on: the reply route, `/:id/unsubscribe`
    (its mailto branch sends from the user's own account; the sender-controlled
    subject and body are now capped at 250 and 1000 characters for every provider,
    Gmail included, and a mailto over a cap falls back to the link like any other
    unusable target), the agent `send_email`
    tool (receipt required) and, later, A4 `create_draft`. The reply route records
    the Message-ID as the `SentMessage` key; "waiting on" joins by thread id, so
    it still works.
- Not verified: no real Naver or iCloud server has been reached. Behaviour rests
  on a mocked nodemailer transport and imapflow client, plus the real nodemailer
  against a local fake SMTP socket (`smtp-wire.test.ts`) and, over real TLS with
  verification on, against a local server that stalls, drops or acknowledges
  (`imap-send-wire.test.ts`).
- Known limits: a connection lost after the body was sent is reported as "delivery
  not confirmed" (it may have been delivered; SMTP cannot say); B2 stores the INBOX UIDVALIDITY but
  `getReplyHeaders` does not compare it yet, so it reads whichever message now holds the UID; mail
  is always From the account's own address (aliases such as iCloud Hide My Email
  are not supported); SMTP 535 because the provider's own IMAP/SMTP toggle is off
  looks like a rejected password and pauses read and star for that mailbox too.
- Flip blockers from the focused re-review, both done: (1) the 60 s abort now
  destroys the SMTP socket, so a send that was not acknowledged by the deadline
  cannot be delivered afterwards, and nothing acts on an orphaned send (no Sent
  copy, no IMAP login); (2) every SMTP error on an established connection, a stall
  after DATA included, is reported as "delivery not confirmed, check your Sent
  folder", and only failures provably before MAIL FROM say "not sent". Also done:
  the success is returned as soon as the 250 arrives, the Sent copy cannot turn it
  into "unconfirmed", and a nodemailer import failure no longer reads "could not
  reach".
- Before the flip: on one real Naver and one real iCloud account (iCloud also
  needs `ICLOUD_INBOX_ENABLED`) run a plain send, a reply through
  `POST /api/email/:id/reply` and a draft through `gmail-draft`. Check that the
  reply threads in the recipient's client, that `From`, `Date` and `Message-ID`
  look right, that an attachment and a non-Latin subject and body arrive intact,
  and that the Sent folder holds exactly one copy of each send (no duplicate, and
  not zero). A server that files its Sent copy asynchronously (after the 250) or
  rewrites the Message-ID can still end up with two copies, because the sender
  searches once, right after the send: verify on real Naver and iCloud. Record
  whether each server files its own Sent copy, since the search-then-append design
  assumes nothing, and which folder names and SPECIAL-USE flags each one reports
  (a folder whose role comes only from a name outside Sent, Sent Messages and
  Drafts gets no copy and no draft). Confirm that Naver accepts 587 with
  STARTTLS from the Render egress IP (if not, switch the registry to 465 implicit
  TLS), that the iCloud Drafts folder is found (a listing reported in the wild
  shows `Drafts` without a SPECIAL-USE flag, which relies on imapflow's
  name fallback), that a draft appears in the provider's webmail, and that a
  `mailto:` unsubscribe from an IMAP inbox sends once. Deliberately revoke an app
  password and confirm one rejected login pauses both send and read/star, and
  that reconnecting clears it. Check rate behaviour with a burst of replies from
  one account.
- Unattended auto-mode replies from IMAP accounts (NAVER, ICLOUD, IMAP) stay
  excluded even once SMTP send works, until a founder decision enables them. The
  exclusion is `canAutoSendFromMailbox` in `agentcore/auto-mode-candidates.ts`;
  widening it is that decision's change.

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
- Landed 2026-09-30 (expand phase only; branch `feat/calendar-provider-schema`,
  PR not yet opened). Migration `20261001010000_calendar_provider`:
  - New enum `CalendarProvider`: GOOGLE, OUTLOOK, ICLOUD, NAVER, DEVICE, LOCAL,
    only the sources C2-C6 name. LOCAL appears only on `CalendarEvent`.
  - `LinkedCalendarAccount`: `provider` (default GOOGLE), nullable `caldavUrl`
    and `caldavPasswordCipher`, nullable `accessToken`, and a new unique key
    (userId, provider, email) added alongside the old (userId, email), which
    stays (see the deploy-overlap bullet). `CalendarEvent`: `provider`,
    `externalId`, `sourceAccountId` (plain tag with no foreign key, like
    `EmailMessage.linkedInboxAccountId`), unique (userId, provider,
    externalId). `googleId` and its unique are untouched.
  - Backfill is one idempotent UPDATE: a `googleId` makes the row GOOGLE with
    `externalId = googleId`; none makes it LOCAL. Sample and demo rows have no
    `googleId`, so they are LOCAL. That UPDATE is correct only now, while every
    row is a Google or a local event; once OUTLOOK, ICLOUD, NAVER or DEVICE rows
    exist it would flip them to LOCAL, so it is never re-run verbatim. Applied
    to a scratch Postgres 16 holding both kinds of row (2026-09-30); the CI
    drift check reports no difference.
  - Both `provider` columns keep `DEFAULT 'GOOGLE'` so the previous release,
    which inserts without it, keeps working during the deploy overlap. A row it
    writes in that window is GOOGLE with a NULL `externalId`. The Google sync
    upsert re-stamps both on update. The contract migration repairs the rest
    with scoped statements (below) before it drops the default.
  - Dual-write goes through `pim/calendar-rows.ts`, the single place that
    decides provider, `externalId` and `sourceAccountId`. The three Google sync
    sites (`POST /api/calendar/sync`, the scheduler tick, login init-sync)
    upsert through it. Manual create and the agent `create_event` write GOOGLE
    when Google returned an id and LOCAL when it did not. The demo seed writes
    LOCAL. The link-calendar callback keys on (userId, provider, email) and
    writes GOOGLE. `sourceAccountId` is NULL in every writer today: linked
    calendars are not synced into rows until C2. A client cannot set any of the
    three fields. `calendar-provider-writers-guard.test.ts` fails if a new
    writer omits the provider or a reader starts using the new columns.
  - Reads are unchanged, still by `googleId` and row id. The one wire change is
    additive: the row JSON returned by `/api/calendar` (list, get, create,
    update) now carries `provider`, `externalId` and `sourceAccountId`.
  - Google-only `LinkedCalendarAccount` readers filter on `provider: "GOOGLE"`
    (`getLinkedCalendarClients`, since replaced in C2 by the dispatcher's routing
    by provider, and the linked-calendars list), so a later CalDAV
    row with no token is never flagged for reconnect and an OUTLOOK row is
    never given a Google client. The guard test fails for a reader without a
    provider filter; the key-rotation sweep reads every provider on purpose.
  - The migration opens with `SET LOCAL lock_timeout = '5s'`, so a deploy
    blocked by a long transaction fails fast instead of queueing behind it.
  - The key-rotation sweep (`scripts/reencrypt-tokens.ts`) covers
    `caldavPasswordCipher` from day one. `purgeUserData` is unchanged: it
    deletes both tables by `userId`.
  - Deploy overlap, verified 2026-09-30 on a scratch Postgres 16 with the
    previous release's generated client: its Google sync upsert keeps working,
    and so does its link-calendar upsert (`ON CONFLICT ("userId","email")`),
    because the old unique index stays. Dropping it first failed that upsert
    with Postgres 42P10, so the old key is kept and the code can be rolled back
    with no schema step.
- For later steps: C2 has two gates (see C2). The contract phase flips reads to
  (provider, externalId) and drops `LinkedCalendarAccount_userId_email_key`
  when a second provider for the same email actually lands (C3/C4). Before it
  drops the `CalendarEvent.provider` default it repairs rows the previous
  release wrote, scoped to GOOGLE rows so no other provider's row is touched,
  in this order:
  `UPDATE "CalendarEvent" SET "externalId" = "googleId" WHERE "provider" =
  'GOOGLE' AND "externalId" IS NULL;` then `UPDATE "CalendarEvent" SET
  "provider" = 'LOCAL' WHERE "provider" = 'GOOGLE' AND "googleId" IS NULL;`.
  Then it adds `CHECK (("provider" = 'LOCAL') = ("externalId" IS NULL))`. The
  CHECK cannot ship in C1: the previous release inserts GOOGLE rows with no
  `externalId`. Finally it drops `googleId` and the remaining defaults.
- Exit: no user-visible change and no flag. The two index builds and the
  backfill are the only non-metadata steps. Nothing is dropped.
- Rollback: revert the PR. The columns and indexes are additive and ignorable,
  and the old unique index is still there for the previous release.

**C2 — calendar provider seam and linked-account sync.** Depends on: C1.
- Tasks: a provider seam in `pim/calendar-providers/` mirroring
  `mail/providers/`; linked Google calendars synced into rows; both C1 database
  review gates settled before the first linked row is written.
- Landed 2026-09-30, review follow-up 2026-10-01 (branch
  `feat/calendar-provider-seam`, PR not yet opened). Migration
  `20261002010000_calendar_linked_source_key`:
  - Seam. `types.ts` (`CalendarProviderActions`, `CalendarSession`, neutral event
    and free/busy shapes), `google.ts` (every googleapis calendar call the app
    makes), `unsupported.ts` and `dispatch.ts`. `connect(account)` resolves the
    credentials once and answers a session, `null` (not connected) or
    `{ unsupported: true }`; a session's methods throw on a hard failure, so each
    caller keeps its own error policy. `OUTLOOK`, `ICLOUD`, `NAVER`, `DEVICE` and
    `LOCAL` answer unsupported. Linked accounts go through the same dispatch as
    the primary one: `connectLinkedCalendars(userId)` reads the user's linked
    rows once (every provider, full rows), dispatches each on the provider it
    already holds (`calendarActionsForProvider`) and hands the row to `connect`,
    which opens a session from it (`buildLinkedCalendarClient` builds the Google
    client from that row; there is no per-account lookup). A conflict check
    therefore costs what it cost before C2, one read of the linked rows plus a
    token decrypt per account, pinned by read-count tests. The conflict checks and
    the sync both use it, so C3 and C4 only add implementations. `pim/calendar.ts`
    keeps its exported functions and results; the primary path is unchanged,
    pinned by characterisation tests written before the move
    (`calendar-google-characterisation`, `automation-scheduler-calendar-sync`, and
    request goldens in the sync route tests). The three sync sites share
    `pim/calendar-sync.ts` (30 days, 100 events, the user's zone, one row
    mapping).
  - Flag `LINKED_CALENDAR_SYNC_ENABLED` (OFF, lenient parse, read per scheduler
    tick). Off: no linked-account lookup, no extra Google call, no linked row
    (tested with a mutation that removes the check). On, for an entitled user
    only (`isEntitled`, exactly like linking an account): after the primary sync,
    every linked account is synced with its own client, the same window and caps,
    rows `provider GOOGLE`, `externalId` = the event id, `sourceAccountId` = the
    linked account. A lapsed user's linked accounts stop syncing. Isolated both
    ways: a primary failure does not skip the linked sync, and a linked failure
    never raises the "Google disconnected" alert.
  - Kill switch. The flag is also the switch for what is already stored: while it
    is off every reader excludes linked rows (`calendarSourceScope()` in the
    `where`, `isCalendarRowVisible()` for a row fetched by id), so turning it off
    hides them at once; the rows stay in the table until their account is unlinked
    or an operator deletes them (see Rollback). The GDPR export is the one reader
    that does not filter: it returns every row the system holds. The guard test
    fails for a reader that neither filters nor is exempt; its patterns match a
    call split across lines (`prisma.calendarEvent` newline `.findMany`), which the
    first version did not and so missed `agent-context.ts`, the reader that feeds
    the LLM context. That reader now filters and dedupes too.
  - Revoked accounts. One failure policy (`pim/linked-calendar-failure.ts`) serves
    the conflict checks and the sync: a revoked grant flags the account for
    reconnect, warns once per account per hour (the log is pruned of expired
    entries) and never reaches Sentry, because only the user can fix it; any other
    failure is warned and captured with the domain only. The sync skips an account
    flagged `needsReconnect` until it is re-linked; the conflict checks still try
    it, because a successful refresh clears the flag. Deviation from main: a
    revoked grant is HTTP 401 or an OAuth `invalid_grant` / `unauthorized_client`
    code (body, code, or the start of the message), not main's broader
    `isGoogleAuthError`, which also matches any message containing "expired",
    "unauthorized", "revoked" or "invalid token". With the broad predicate an
    unrelated "request expired" would be flagged as a revoked account and hidden
    from Sentry; with this one it is captured and the account is left alone.
    Main's predicate is unchanged for the primary paths.
  - Gate (a), dedupe, decided: `CalendarEvent.sourceKey TEXT NOT NULL DEFAULT
    'primary'` (the linked account id for a linked row), and the unique becomes
    (userId, provider, sourceKey, externalId). One row per event per source
    calendar; both copies of an invite exist and readers dedupe. A CHECK keeps
    `sourceKey = COALESCE(sourceAccountId, 'primary')`, and `calendar-rows.ts` is
    the only place that derives it. Linked rows keep `googleId` NULL, so they
    never meet the legacy unique. C1's (userId, provider, externalId) unique is
    dropped, which the gate had not assumed: keeping it makes a linked row block
    the previous release's insert of the same primary event with a unique
    violation that is not its `ON CONFLICT` target (negative control run on the
    scratch database). Rejected: a `COALESCE` expression unique index (Prisma
    cannot declare it or target it in an upsert), `NULLS NOT DISTINCT` (Postgres
    15+, not declarable), a sentinel in `sourceAccountId` (changes the C1 wire
    value and the previous release writes NULL).
  - Overlap, verified on a scratch Postgres 16 with the previous release's
    generated client (C1, run against a database that already had this migration
    and held linked rows): its Google sync upsert (create, update, update of a
    row written before C1, and create while a linked copy exists), its manual
    create, demo seed and link-calendar upsert all succeed; its conflict targets
    (`userId,googleId` and `userId,provider,email`) are untouched. The migration
    applied cleanly to a database holding C1-shaped rows, and both `prisma
    migrate diff` forms report no drift (the CHECK is invisible to the diff).
    The shipped row, dedupe and unlink functions were also run against that
    database: one invite is two rows, the primary one is kept by the dedupe,
    unlink removes the linked row, its attention item and the account, and a
    write after the unlink fails the foreign key.
  - Gate (b), unlinking: `DELETE /google/linked-calendars/:id` deletes the
    account, its events and their mirrored AttentionItems in one `$transaction`
    (`pim/linked-calendar-unlink.ts`), events and attention items first: with
    mocks alone the order looked free, but on a real Postgres deleting the
    account first cascades the events away and leaves the AttentionItems
    orphaned, so the order is pinned by a test. The route stays a Google surface:
    the account lookup and delete are scoped to `provider GOOGLE`, so it can never
    remove another provider's account by id (the mail route does the same).
    `sourceAccountId` is also a foreign key with `ON DELETE CASCADE`, deliberately
    both: the route needs the event ids for the AttentionItems, and the cascade
    covers what no route sees, a sync in flight when the account is unlinked (its
    insert fails the foreign key, skipped quietly) and the previous release's
    unlink after a rollback (verified: its plain `deleteMany` on the account
    removes the events). The index is on `sourceAccountId` alone, not the
    (userId, sourceAccountId) the C1 review suggested, because the cascade looks
    rows up without a userId.
  - Linked rows are read-only mirrors: `PATCH` and `DELETE /api/calendar/:id` on
    a row with a `sourceAccountId` answer 409 (404 while the flag is off, when the
    row is hidden), because Klorn holds only `calendar.readonly` there and the
    next sync would revert the edit or bring the event back.
  - Wire. `/api/calendar` row JSON gains `sourceKey` (additive) and, on a linked
    row only, `readOnly: true`; the field is absent on primary and LOCAL rows, so
    the primary calendar's JSON is byte-identical with the flag off. Contract and
    Swift note for C7: clients should hide edit and delete on a `readOnly` row
    (the desktop and web UI change belongs to C7; the routes already refuse).
  - Readers. `calendar-provider-writers-guard.test.ts` lists every module that
    reads CalendarEvent and fails for a new one. Deduped at read time by
    (provider, externalId), primary copy first, then the lowest `sourceKey`, then
    the lowest `id` (`pim/calendar-dedupe.ts`): `/api/calendar` and
    `/today/summary`, the briefing day shape, the meeting context's nearby events
    (the display cap applies after the dedupe), the inbox summary, its attention
    mirror and its top 3 (one meeting cannot take two slots), the focus digest
    (its dedupeKey is per row, so a copy sent two digests) and the back-to-back
    warning (a copy read as an overlap). Unaffected by a duplicate: team
    availability, the conflict and focus-block lookups, and meeting prep by id.
    The per-member free/busy keeps its old conservative reading: a busy entry
    missing a start or end still counts as busy (`anyBusy`), never as free.
  - Intended effects with the flag on: a linked calendar's event suppresses
    focus-window notifications while it runs, and a booking that collides with it
    is refused by `create_event`'s conflict check (which already reads every linked
    account through Google free/busy), because it is a real commitment of the same
    person. The +-30 minute duplicate check that runs before it looks at primary
    and LOCAL rows only, flag on or off: it names an existing event for the model
    to point at, and a read-only linked mirror is not one.
  - For C7, not deduped yet (closed in C7, see below): the `/api/ops` events-today
    count, the interaction-graph meeting bonus, the weekly-review meeting count and
    the tomorrow list in `proactive-actions.ts`, and the briefing reader's `take:
    20` (it already collapses copies by title and day, but copies spend the cap).
    Matching by event id misses an invite whose two accounts got different ids;
    the iCalUID is the reliable key and needs a column. Events deleted or
    cancelled in Google are removed on the next sync once
    `CALENDAR_CANCELLATION_SYNC_ENABLED` is on (C2b, next bullet); the Outlook and
    CalDAV connectors must do the same.
  - Cancelled events (C2b), behind `CALENDAR_CANCELLATION_SYNC_ENABLED` (OFF by
    default, read at sync time like `LINKED_CALENDAR_SYNC_ENABLED`, in
    `.env.example`). Flipping it is a founder action, after a check against a real
    Google calendar (below). While OFF every sync makes exactly the Google calls it
    always did and removes no row. When ON, after the upsert both Google syncs (the
    primary and every linked account) ask Google which events were cancelled, in a
    SEPARATE `events.list` (`CalendarSession.listCancelledEvents`): the sync's own
    listing is unchanged, because with `showDeleted` on it cancelled events would
    count toward `maxResults: 100` and push live events out of the window.
    - **The request.** `showDeleted: true`, `singleEvents: false`, NO
      `timeMin`/`timeMax`, `orderBy: "updated"`, `maxResults: 250`, `fields:
      nextPageToken,items(id,status,updated,recurringEventId)`, `updatedMin` = the
      later of (now - 7 days) and where this account's last scan left off, each
      page with a 10 s timeout and no retry (`CANCELLED_SCAN_TIMEOUT_MS`). Why:
      `updatedMin` bounds the listing to events changed since then, and "entries
      deleted since this time will always be included regardless of showDeleted";
      `singleEvents: false` returns single events, recurring masters and
      exceptions, not every expanded instance, so a series cannot fill the page
      cap; `orderBy: "updated"` is valid without `singleEvents` (only `startTime`
      needs it) and lets a truncated scan resume; no time window because a deleted
      event is only guaranteed to carry its `id`, so a time filter could drop one
      with no start. A cancelled event, a cancelled series and a cancelled
      instance of a live series each come back as one item, an instance carrying
      `recurringEventId`. Sources:
      developers.google.com/workspace/calendar/api/v3/reference/events/list
      (`showDeleted`, `singleEvents`, `orderBy`, `updatedMin`),
      .../reference/events (`status`) and .../guides/recurringevents.
    - **What is removed.** The row matching (user, GOOGLE, `sourceKey`,
      `externalId`) of every id whose FINAL status in the scan is `cancelled` (an id
      can be listed twice in one scan, cancelled on an early page and restored
      since; the item with the latest `updated` decides, so a restored event or
      series is never removed), and its open or
      snoozed attention items resolved (not deleted), in one transaction per scan
      (`removeCancelledGoogleEventRows`); a primary row the previous release wrote
      with no `externalId` is matched by `googleId`. An item with no
      `recurringEventId` (an event or a whole series) also removes the instance
      rows `<id>_<start>` of that series: the id is split at its LAST underscore,
      the tail must be an instance start (`20261005T000000Z` or `20261005`), and the
      rest must be a cancelled series id, so an unrelated id that merely shares a
      prefix is never touched. Google documents base32hex ids (a-v, 0-9, no
      underscore) only for ids a client supplies, and the `<id>_<start>` instance
      form is observed behaviour, not documented, hence the strict match. A row
      merely missing from a listing is never removed. The scan has no window, so a
      cancelled event's row is removed wherever its date falls, past rows included.
    - **Progress.** The next scan's start is per process (a restart widens the
      first scan back to 7 days; bounded to 5000 accounts, the least recently
      scanned forgotten). After a complete scan it is that scan's start minus 30
      minutes. A scan reads at most 4 pages of 250; when it is cut off it resumes 1 s
      before the last `updated` it read (`CANCELLED_RESUME_OVERLAP_MS`), so a backlog
      of more than 1000 changes converges over consecutive syncs. Google does not
      document whether `updatedMin` is inclusive, and a group of events sharing one
      `updated` can straddle the cut; the 1 s overlap re-reads that group, and
      removals are idempotent. If a resume would not move forward (more than one
      cap's worth of events share the window, so the same pages would be read
      forever) the scan steps 1 ms past the stuck point and warns once per account.
    - **Failure and noise.** A failing scan never fails the sync: one `console.warn`
      per account and kind of trouble (failure, truncation, no progress) until it
      recovers, so one never hides another. A 4xx other than 429 is also reported to Sentry
      once per process. When rows are removed, one log line per account and sync:
      `userId:sourceKey`, the removed count and the resolved-attention count, no
      titles.
    - **Known limits.**
      - "This and following" deletions truncate the series' recurrence and leave no
        tombstone for the instances, so those instance rows stay until the series
        is changed again or the account is unlinked. Nothing is ever removed because
        it is absent from a listing.
      - Restore race: if an event is restored between a scan's read and its
        removal, its row is removed and re-created by the next sync's listing; the
        old row's attention items stay resolved and the new row gets fresh ones.
      - A cancellation older than the lookback that no scan saw (the account was
        not syncing for over 7 days) is not removed.
      - Ties at the resume point: when more than one cap's worth (1000) of events
        share one `updated`, the scan steps past that timestamp and the cancelled
        events tied there beyond the cap are never read. Accepted (a bulk operation
        stamping one instant on over 1000 events), but check during the live
        verification whether `updatedMin` is inclusive and how Google orders ties.
      - Not yet verified against a real Google calendar: that a deleted series is
        returned as one cancelled item and its instances as nothing, the instance
        id form, and that `orderBy: "updated"` with `showDeleted` pages as
        documented. Those are the checks before the flip.
  - Migration locks, measured size and runbook. `ALTER TABLE "CalendarEvent" ADD
    COLUMN` takes ACCESS EXCLUSIVE on the table and, because Prisma wraps the
    migration in one transaction, holds it until commit: reads of CalendarEvent
    are blocked for the whole migration, not only the index builds. The foreign
    key takes SHARE ROW EXCLUSIVE on LinkedCalendarAccount (and on CalendarEvent).
    Production on 2026-10-01 (read-only): 197 CalendarEvent rows (195 GOOGLE, 2
    LOCAL), none with a `sourceAccountId`, 1 LinkedCalendarAccount, no unfinished
    migration, latest applied `20261001010000_calendar_provider`; at that size the
    migration is negligible.
    - Preflight: `SELECT count(*) FROM "CalendarEvent" WHERE "sourceAccountId" IS
      NOT NULL` (0 on 2026-10-01). Anything above 0 means a linked row exists
      already: stop and read Rollback.
    - If the migration fails on `lock_timeout` (a long transaction held a lock),
      Prisma records it as failed and refuses every later deploy with P3009. The
      transaction rolled back, so recover with `prisma migrate resolve
      --rolled-back 20261002010000_calendar_linked_source_key` and redeploy. C1's
      `20261001010000_calendar_provider` has the same exposure and the same
      recovery.
  - Rollback. If the flag was never on, revert the PR: the columns, index and
    constraints are ignorable by the previous release, which was verified against
    them. If it was ever on, in this order: set the flag OFF (readers hide linked
    rows at once); delete the AttentionItems of linked events, `DELETE FROM
    "AttentionItem" WHERE "source" = 'CALENDAR_EVENT' AND "sourceId" IN (SELECT
    "id" FROM "CalendarEvent" WHERE "sourceAccountId" IS NOT NULL)`; delete the
    linked rows, `DELETE FROM "CalendarEvent" WHERE "sourceAccountId" IS NOT
    NULL`; then revert the code. Skipping the deletes leaves linked events visible
    to the previous release, which has no kill switch.
  - Contract phase drops, on top of C1's list: the `sourceKey` default (once the
    previous release is gone; every writer already states it), `googleId` and
    `CalendarEvent_userId_googleId_key` after reads move to (provider,
    externalId). It keeps the per-source unique, the CHECK, the index and the
    foreign key. The primary sync upsert targets `userId_googleId`
    (`calendar-rows.ts`, `upsertGoogleEventRow`): its writers must move to the
    four-column key BEFORE `googleId` and its unique are dropped, or the primary
    upsert has no conflict target. The migration header carries the same record.
- Exit: flag OFF, no user-visible change except the additive `sourceKey` field on
  the `/api/calendar` row JSON. Nothing is flipped.

**C3 — CalDAV connector for iCloud and Naver** (*outline*). Read-only v1.
`caldavUrl` is user-supplied and fetched server-side, so SSRF validation
(resolve the host, pin the address, reject private ranges) is required before
the first request, and the password is stored with `encryptToken`.
**C4 — Microsoft Graph calendar** (*outline*). Needs calendar permissions
added to the Azure app (FA-9); existing users re-consent.
**C5 — mobile device bridge** (*outline*). Blocked on FA-8. Upload policy per
P4.
**C6 — desktop device bridge** (*outline*). EventKit in KlornMac. Upload
policy per P4.
**C7 — one calendar read path.** Depends on: C2. `list_events`, briefing and
conflict checks read rows across providers. Each connector joins as it lands; C7
does not wait for them.
- Landed 2026-09-30 (branch `feat/unified-calendar-read`, PR not yet opened). No
  migration, no new dependency, no schema change. One new flag.
  - Flag `UNIFIED_CALENDAR_READ_ENABLED` (OFF, lenient parse, read per request).
    Off: every behaviour is the one on main. `list_events` (chat and MCP, both go
    through `executeToolCall`) still calls Google live, `check_calendar_conflicts`
    asks Google free/busy only, no row is read for either, and the tool
    descriptions are the original strings (tested, with mutations that remove the
    flag check from `listEvents`, from `checkConflicts` and from the description).
  - The read path is `pim/calendar-read.ts`: `readCalendarRows` and
    `countCalendarRows` take a user and a time predicate and add the scope
    (`calendarSourceScope()`), the dedupe (`dedupeCalendarEvents`) and the cap
    after the dedupe. The caller cannot forget the scope or widen the user: the
    `where` is composed after its predicate. While the linked sync is off no
    linked row is visible and nothing can be a copy, so the queries are the ones
    the readers always ran (a count stays a database count, a cap stays a
    database `take`); rows are fetched and merged only once copies can exist, with
    no `take`, bounded by the sync itself (30 days, 100 events per calendar).
    `pim/calendar-read-format.ts` holds the pure shaping for the model.
  - `list_events`, flag on: the next events that have not ended yet, from rows,
    scoped and deduped, `max_results` applied after the dedupe, and bounded: rows
    starting within a month either side of now, so the read can neither load
    every future row nor scan the user's whole past (the lower `startTime` bound
    is what keeps the (userId, startTime) index range finite). Each event keeps
    the old shape (id, summary, start, end, location, description, all wrapped as
    untrusted) and adds `allDay`, `provider` and `readOnly`. A timed event is
    written as an offset-bearing local time, as Google wrote it to the live call.
    An all-day event is stored as UTC midnight of its dates (end exclusive), so
    its dates are read off the UTC instant, never in the user's zone (west of UTC
    that put it a day early); it stays "upcoming" through the end of its last date
    in the user's zone. A linked calendar's event is `readOnly` and has `id:
    null`: `delete_event` works on the primary calendar only, so an id it cannot
    honour would invite a delete that cannot work. A local-only event also has
    `id: null` (Google has no copy). The primary connection is still checked (a
    local read, no Google call) so the live path's reconnect prompt survives: no
    connection and no rows is main's not-connected error; no connection with rows
    is the events plus a `warning` with the same prompt, since they are a stale
    copy. The connection check can itself throw (a database failure): that counts
    as "not connected" and never replaces rows already read. A failed row read is
    an `{ error }`, never a throw.
  - `check_calendar_conflicts`, flag on: timed rows overlapping the window (scope,
    dedupe, `provider` and `readOnly` per entry) plus the live free/busy answer the
    check always gave, primary and linked. An entry carries the interval, a
    calendar label (`primary` or `linked`), `provider` and `readOnly`, and no
    title: the answer says when the user is busy, like free/busy, and never hands
    the agent the name of a meeting on a linked (work) calendar (`create_event`'s
    skipped echo also drops the `summary` of a linked entry). The degraded
    primary-only path (a 403 for a token without `calendar.readonly`) no longer
    returns the raw invite title either, flag off or on: a deliberate change to
    main's output, as the title is external content. Bounds: at most 100
    rows (after the dedupe), a window of at most a month for the rows (free/busy
    still gets the whole window), a lower `startTime` bound of a month before it.
    Google reports busy time merged, so two adjacent meetings come back as one
    block: a block is accounted for when the rows, joined the same way, cover it,
    and is dropped; every other block stays, because free/busy sees what rows do
    not (calendars the sync does not mirror, changes newer than the last sync).
    The not-connected and invalid-range answers are main's and come before any row
    is read. A failed row read throws, like any other unexpected failure here: the
    check never answers "free" on half the evidence, and `create_event` already
    aborts on a throw. The thrown message is a constant; the tool executor hands
    an error's message to the model and to MCP clients, so the database's own
    message is only logged. All-day rows are left out on purpose: free/busy treats an
    all-day marker (birthday, holiday) as free time, as `summarizeConflicts` always
    did for the primary-only fallback. Attendee free/busy (`checkAttendeeBusy`,
    `getAttendeeBusyBlocks`, `getAttendeeBusyByMember`) is untouched and stays
    live: attendees have no rows (tested with the flag on).
  - Reach of the flag: it changes `listEvents` and `checkConflicts` for every
    caller, not only the chat and MCP tools: the autonomous agent's `list_events`
    and `check_calendar_conflicts`, `create_event`'s enforced conflict check (a
    booking is refused on a row conflict, a stale one included) and the reading
    pane's meeting-context conflict line. Documented in `config.ts` and
    `.env.example`.
  - Freshness trade-off, stated in both tool descriptions while the flag is on:
    rows are a synced copy, refreshed by the scheduler about every 15 minutes
    (`SCHEDULER_CALENDAR_SYNC_INTERVAL_MS`, default 15 min) for the next 30 days
    and at most 100 events per calendar. An event created or moved in the last 15
    minutes may not show in `list_events`; the conflict check sees it only through
    free/busy. The descriptions also say that an event deleted or cancelled in
    Google can still be listed until the sync removes it. Two consequences to weigh
    before the flip, inherited from the sync, not new: (1) a row is not removed
    when its event is deleted or cancelled upstream, except for Google once
    `CALENDAR_CANCELLATION_SYNC_ENABLED` is on, where C2b (C2, above) removes it on
    the next sync; the Outlook and CalDAV connectors must do the same
    (`listCancelledEvents`, a call separate from the sync listing, so deletions
    never spend its cap). Until then, and for a connector without it, `list_events` can
    still list such an event until it ends, and a booking that overlaps it is
    refused by the conflict check (free/busy cannot override a row conflict); the
    Calendar page and the desktop app already show those rows today. (2) A row
    stores neither transparency nor the user's response, so a timed event marked
    free, or one the user declined, is a conflict from its row while free/busy
    would ignore it. Fixing (2) needs columns the sync fills (`transparency`,
    response status); that is not in C7. Recommendation: do not flip the flag until
    the sync removes vanished events for the providers in use (for Google, C2b's
    flag on after its live check, also a founder action), and weigh (2). A
    founder decision.
  - The C2 gaps, closed regardless of the flag (they only matter while linked rows
    are visible): the `/api/ops` events-today count, the interaction-graph meeting
    count (it only uses `> 0` today), the weekly-review meeting count and the
    tomorrow list in `proactive-actions.ts` (the cap of 5 applies after the
    dedupe), and the briefing caps: `listLocalBriefingEvents` (20) and the day
    shape (50), whose query no longer carries the cap while copies can exist. Each
    goes through the read path; with no linked row the outputs are identical to
    main's (tests per reader, including the query shape while the linked sync is
    off). `calendar-provider-writers-guard.test.ts` now requires those modules to
    read through the path and nothing but the GDPR export to return every row.
  - Clients. `/api/calendar` (list and `:id`) and `/today/summary` add
    `sourceLabel` (the linked account's email) on a linked row, next to C2's
    `readOnly: true`; one lookup per response, none when no row is linked (the
    primary calendar's JSON stays byte-identical), and a failed lookup drops the
    labels, never the list. The web agenda and event page show the label (or
    "Linked", a blank label counts as none) with a visible "Read-only" text, and
    hide delete on a `readOnly` row (the web has no edit); the Mac app's event
    popover hides edit and delete, shows the label with a visible "Read-only" text
    (not only for VoiceOver), and
    `beginEditingEvent` / `deleteEvent` refuse a read-only row as well. The two
    new Swift fields are optional, so a row from an older server still decodes
    (self-check). Strings: 7 web locales (parity guard) and 7 `.lproj` files.
  - Per-provider kill switch. `calendarSourceScope()` and `isCalendarRowVisible()`
    take an optional map of provider to "is its connector enabled" (default
    `CALENDAR_PROVIDER_ENABLED`, exported from `pim/calendar-scope.ts`, empty
    today). A connector registers its flag with one entry (C4: `OUTLOOK:
    outlookCalendarEnabled`); its rows are then visible only while that flag is on,
    whatever the Google linked flag says, for every reader and by id. GOOGLE keeps
    `LINKED_CALENDAR_SYNC_ENABLED`; LOCAL is always visible. With nothing
    registered the fragment is exactly what it was (`{ sourceAccountId: null }` or
    `{}`), so a provider with no connector costs no clause. The fragment uses the
    top-level keys `sourceAccountId`, `provider` and `OR`; a caller wraps an `OR`
    of its own in `AND: [...]`. Tested with a fake provider flag.
  - Calendar text to an LLM is wrapped. An event's title, description, location,
    meeting link and attendees are external content. Audited: `agent-context.ts`
    (the upcoming list, the link, the meeting hint), `briefing.ts` (the prompt's
    events, and the calendar-sourced signals through `pim/briefing-prompt-wrap.ts`:
    a calendar action is wrapped as a whole field, never found-and-replaced inside
    other text, and the "shared terms" tokens of a link reason are wrapped),
    `create_event`'s "already exists" skip and `get_upcoming_meetings` (live
    Google: summary, link and attendees, wrapped at the tool boundary;
    `join_meeting` strips the wrapper from a link the model copies back). The
    user-visible renderings (`listLocalBriefingEvents`, the rule-based fallback,
    the notifications) keep the clean text, and the cross-link matching still reads
    it. The reverse direction: tags that come back out. A tool result is stored
    and shown as text (`ActionOutbox.result`, `PendingAction.result`, the approve
    route's response), so `action-outbox.ts` strips `<untrusted_content>` tags once,
    where the result enters it. The briefing system prompt carries the standard
    untrusted-content rule and forbids repeating the tags, and the briefing text
    is stripped before it is saved and before the notification and push use it.
    `meeting-context.ts` already wrapped. `proactive-actions`, `inbox-summary`,
    `briefing-structure`, `focus-digest`, `meeting-prep-pack`, `team-availability`
    and the interaction graph import nothing from the LLM, statically or
    dynamically; `routes/calendar.ts` reaches the model only through `event-parse`
    (the user's own utterance, no row) and `routes/ops.ts` only reads provider
    cooldowns. The writers guard pins those lists and the import detector.
    Not done here: the nesting escape of `wrapUntrusted` itself
    (`</untrusted_</untrusted_content>content>`) is fixed in `untrusted.ts` in a
    separate change.
  - Decision, the cross-calendar key: (provider, externalId) stays the dedupe key.
    An iCalUID column (expand migration plus backfill, and the sync writing it) is
    not added here: it changes the schema and the writers, and its value is for
    copies across providers, which do not exist until C3 and C4 land. The known
    limit from C2 stands: two accounts whose copies of an invite got different
    event ids still show it twice. Revisit with the first non-Google connector.
  - Not verified: every test mocks Prisma, so the flag was never on against a
    real database, and the query cost of the row reads was not measured.
- Exit: flag OFF; no user-visible change except the additive `sourceLabel` field
  on linked rows, which exist only while the C2 flag is on. Nothing is flipped.
- Rollback: revert the PR. There is no schema or data step.

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
A1 → A2a → A2b        A2a → A3        A2a + B0 → A4        A2a + A2b + A4 + A5 → A8
MCP_WRITE_TOOLS_ENABLED flips only after A2b and A3 have both merged
A5 (read-only part), A6 independent
B0 → B3                 B0 → B0b                B1 → B2 → B2b
B4 after security design
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
| `packages/api/prisma/schema.prisma` | A1, A2a, A2b, B2, C1, D2, E1, F |
| `packages/api/src/mcp/tool-gate.ts`, `mcp/write-call.ts`, `mcp/server.ts` | A2a, A2b, A4 |
| `mail/providers/types.ts`, `dispatch.ts` | A4, B0, B0b, B1, B2, B3, E2 |
| `mail/imap-connection.ts`, `mail/imap-sync.ts`, `mail/providers/imap.ts` | B1, B2, B3 |
| `mail/providers/outlook.ts`, `routes/email-replies.ts` | B0b, the `gmail-draft` follow-up under B0 |
| `mail/reply-headers.ts` | B0, B3 |
| `pim/calendar.ts`, `pim/calendar-read.ts`, `routes/calendar.ts` | C3, C4, C5, C6, C7 |
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
