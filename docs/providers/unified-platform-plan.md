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

**B2b — non-destructive UIDVALIDITY reset.** Depends on: B2. Landed 2026-09-30 (two
commits: the repair, then the review follow-up), behind the IMAP flags (all OFF;
production has no Naver, iCloud or IMAP account). Gmail and Outlook paths are unchanged.
- The live bug it fixes: B2 held a reset (actions refused, one report) but kept
  ingesting, so a NEW message that reused an old UID was deduped into the stale row
  (its flags and labels written over the old row's; the new mail never got a row or a
  triage). Deleting the mailbox's rows was rejected in review: it takes user work with
  it and acts on one observation.
- Landed (`mail/imap-uidvalidity-reset.ts`, `mail/imap-tombstone.ts`,
  `mail/imap-poll-guards.ts`, `mail/imap-hold-state.ts`, `mail/imap-history.ts`,
  migration `20261004010000_imap_uidvalidity_reset`, three nullable columns on
  `LinkedInboxAccount`, additive, `SET LOCAL lock_timeout`):
  - Hold stops ingest. While a mailbox is held (live value usable and different from
    the stored one, or a reset pending, also when the live value is unusable) the poll
    persists NOTHING for it and skips the moved-row cleanup. A live value that is
    unusable with nothing pending ingests as before (no reset can be told).
  - A hold does not look healthy: a held poll does not stamp `lastSyncedAt`, so the UI
    stops saying "Synced 1m ago". It logs at most every `HELD_WARN_INTERVAL_MS` (15 min)
    and alerts Sentry at most once per account per `HELD_ALERT_INTERVAL_MS` (24 h),
    whatever the value, so a hold that lasts days keeps being seen. In-process state,
    bounded to `MAX_TRACKED_ACCOUNTS` (1000) per map; a restart forgets it.
  - Two sightings. The first poll that sees a new value stores it as
    `inboxUidValidityPending` with `inboxUidValidityPendingAt`. A later poll seeing the
    same value at least `MIN_SIGHTING_GAP_MS` (60 s) after it repairs. The stored value
    seen again clears the pending one; a third value replaces it and restarts the clock;
    an unusable value leaves it. At most one repair per account per
    `RESET_LIMIT_WINDOW_MS` (24 h, from `inboxUidValidityResetAt`); inside it the
    mailbox stays held.
  - Repair, one `prisma.$transaction` (timeout 30 s): (a) claim, a conditional
    `updateMany` on id, userId, the stored value, the pending value, the pending time
    this poll read and "no repair in the last 24 h", moving the account to the new value
    and setting `inboxUidValidityResetAt` to the claimed pending time (the FIRST
    sighting, not the repair time); a count other than 1 stops there; (b) the OPEN and
    SNOOZED AttentionItems (`source EMAIL`, `sourceId` = EmailMessage.id) of the
    mailbox's live rows become RESOLVED, chunked by 1000; (c) one raw
    `UPDATE "EmailMessage" SET "gmailId" = "gmailId" || '#uv<old>.<repair epoch ms>'`
    over the rows with `starts_with("gmailId", '<prefix>:<email>:')` and
    `"gmailId" !~ '#uv[0-9]+\.[0-9]+$'`, every value a bound parameter. The repair
    time makes each suffix unique, so a server going A -> B -> A -> B repairs every
    time instead of colliding with the first A tombstone; the anchored pattern skips
    earlier tombstones and still re-keys an address that itself contains `#uv`. No
    createdAt split is needed: nothing was ingested while held. Any failure, a unique
    collision or a timeout included, rolls all of it back and the mailbox stays held;
    the next attempt waits `repairBackoffMs` (10 min, doubling per consecutive
    failure, capped at 6 h) so a repair that keeps timing out does not take a pooled
    connection every poll. Failures log each time and alert Sentry once per account
    per 24 h, sanitized (the database error quotes the colliding id). The repair poll
    persists nothing; the next poll ingests the window under the new numbering. Row
    ids are kept, so summaries, stars, reply state, attachments, candidate intakes and
    commitments stay attached; nothing is deleted.
  - Dating the reset from the first sighting keeps the 24 h limit and the moved-row
    floor sound: from the first sighting every action refuses the mailbox, so Klorn
    records no move between that instant and the repair.
  - Re-ingested history (`imap-history.ts`): a tombstone, or an IMAP row whose account
    has `inboxUidValidityResetAt` set and that was received before it, is stored and
    judged as usual but gets no firewall PUSH, no urgent-sweep notification (bell, push
    or SMS) and no unattended reply (the rule loop and the auto-mode candidates). The
    account lookup is one query per batch and none when no row is IMAP. Mail received
    during the hold (at or after the first sighting) keeps its side effects. In the
    urgent sweep, the rule auto-reply loop and the auto-mode candidates a failed lookup
    is caught (`findReingestedHistoryFailClosed`): every IMAP row counts as history for
    that tick, Gmail and Outlook rows go through, the rest of the user's tick runs, and
    the failure is reported once per process per path.
  - Actions refuse tombstoned ids: the strict parse (`parseImapMessageId`) rejects
    `...:101#uv1000.<ms>`; tests pin it for flags, trash, archive, both undos, reply
    headers and the undo re-sync. No new error code. The link route's
    `format: "email"` rejects `\` and `:` in an address (pinned by a route test), so an
    address cannot forge the `<prefix>:<email>:` boundary.
  - Moves recorded before the reset are ignored by the moved-row cleanup
    (`recentlyMovedSourceIds(scope, notBefore = resetAt)`): their ids are old numbers
    that a new message may now carry.
  - PUSH dedupe, IMAP ids only (`isImapMessageId`). The `[gmailId]` marker is shared by
    the firewall PUSH (`email-firewall.ts`) and the urgent sweep
    (`automation-scheduler.ts`, `notify/urgent-dedup.ts`). For an IMAP id a marker counts
    only when the notification was created at or after the row's `createdAt` (firewall:
    the query's `createdAt` floor; sweep: `unnotifiedEmails`), and the sweep's
    at-most-once key is `urgent:<gmailId>@<row id>` for an IMAP lead (it is unique
    forever). Gmail ids: same query, same key, no extra read (pinned by tests).
- Known limits:
  - Tombstoned rows are NOT hidden from lists, counts or search (about 90 call sites,
    out of scope by decision), so after a repair each recent message can show twice:
    the tombstone and the re-ingested row.
  - Each repair adds one row per message in the poll window (50) and re-judges them
    (judge cost per repair, bounded by one repair per account per day); tombstones
    accumulate and are never pruned.
  - A server that alternates between two new values (B, C, B, ...) never shows the
    same value twice in a row, so every poll restarts the pending clock and the mailbox
    stays held, alerting once a day, until an operator acts.
  - `receivedAt` is the Date header, which the sender controls: a mis-dated message can
    land on the wrong side of the history cutoff (a real new message silenced, or an
    old one pushed). New mail that arrived between the server's renumbering and the
    first sighting (up to one poll interval) counts as history. Accepted.
  - The 60 s gap and the 24 h window compare app-instance clocks with times other
    instances wrote; a clock skew of 60 s or more between instances weakens the gap
    (the claim still lets only one poll repair).
  - Relink is not addressed: an unlink keeps the EmailMessage rows and a relink
    baselines from the live value, so rows of an old numbering become actionable again,
    guarded only by the envelope check.
  - The `auto-reply:<gmailId>` claim key is not made IMAP-aware; re-ingested history
    never reaches it, but a genuinely new message that reuses a re-keyed id whose old
    message was answered finds the old claim and gets no unattended reply (the safe
    direction; no IMAP unattended send is enabled today).
- Tests: `imap-uidvalidity-reset.test.ts` (real poll, fake server, strict database with
  rollback and LIKE-faithful `startsWith`: the named limits and every step; a held poll
  leaves the old row byte-for-byte unchanged, creates nothing and does not stamp
  `lastSyncedAt`; alert and log rate limits; one sighting changes nothing; the gap
  boundary; re-key without delete; attention scope, including a `a_b` / `aXb` pair;
  user work kept; other accounts untouched; ingest after repair and which rows are
  history; an address containing `#uv1.2`; A -> B -> A -> B; overlapping polls; the
  claim refusing each moved field; flap back, third value, unusable value; the 24 h
  boundary from the first sighting; rollback, backoff and a single alert on failure;
  a unique collision; a move recorded before the repair), `imap-history.test.ts`,
  `automation-urgent-sweep-history.test.ts` (one real scheduler tick: the urgent sweep
  and the rule auto-reply loop skip history and tombstones, Gmail unchanged),
  `firewall-push-imap-dedupe.test.ts`, additions to `auto-mode-candidates.test.ts`,
  `urgent-dedup.test.ts`, `scheduler-notification-dedup.test.ts`,
  `routes-icloud-imap.test.ts` and the four action suites. B2 assertions that encoded
  "a held poll still ingests" and "one alert per value" were changed in
  `imap-moves-poll-regression.test.ts`. Mutations, each caught: every claim condition
  dropped, the claim count relaxed, the gap set to 0 or its comparison loosened, the
  24 h window shortened or its check removed, the re-key guard removed, loosened or
  unanchored, the suffix without the repair time, the anchored tombstone test made a
  substring test, the attention prefix re-check removed, hold not stopping ingest,
  `lastSyncedAt` stamped while held, log or alert rate limits removed or keyed per
  value, the alert interval shortened, backoff ignored, made flat or uncapped, the
  bounded map not evicting, the reset dated from the repair, history widened to Gmail
  ids or to `receivedAt == resetAt`, tombstones not history, the Gmail rows looked up,
  and each side-effect guard (firewall, sweep, rule loop, auto mode) removed. The
  re-key SQL mutations are caught because the fake database only accepts the exact
  statement text; the anchored pattern is also checked semantically by the `#uv1.2`
  address test.
- Verified on a scratch Postgres 16 (not in the suite): `prisma migrate diff` from the
  migrations to the schema is empty; the re-key statement re-keys exactly the
  account's rows, skips earlier tombstones, re-keys a `a#uv1.2@...` mailbox, leaves
  `aXb` alone for an `a_b` address (Prisma's `startsWith` does NOT escape `_`: it
  matched `myXname` for `my_name`, which is why the attention step re-checks the
  prefix in code), and a
  collision raises 23505 (P2010) and rolls the whole transaction back.
- Not verified: no real Naver or iCloud server.

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

**B4 — generic IMAP (user-supplied host).** Depends on: B1, B2. Design written
2026-09-30 before any code; implementation follows it. Flag `GENERIC_IMAP_ENABLED`,
OFF. Not flippable until the security review below signs off.

- Scope. IMAP over implicit TLS on port 993 only. Read, unread and star (B1) and
  archive, trash and undo (B2) work on a generic row only while their own flag AND
  `GENERIC_IMAP_ENABLED` are on. **Send, drafts and reply headers are out of scope
  (decision):** a user-supplied SMTP endpoint is a second outbound target with
  STARTTLS-downgrade risk on ports 465/587, and it would double this design. A
  generic row keeps the unsupported stubs for them whatever `IMAP_SEND_ENABLED`
  says, its registry entry has `smtp: null`, and the SMTP transport refuses a
  provider without an endpoint. Generic send is its own later step.
- Threat model. The attacker is an authenticated, entitled user. They choose the
  host string, control DNS for any name they own (any A/AAAA answer, TTL 0,
  answers that change between queries) and run the IMAP/TLS server at any public
  address. What they must not reach: Klorn's internal network, the cloud metadata
  service, services on localhost. What they must not get: a port scanner, a
  reachability oracle for internal or third-party hosts, a credential-stuffing
  proxy, a way to stall the serial poll tick. Out of scope: a hostile server
  reading the user's own mail (it is the user's own choice of host).
- D1 Host grammar (`mail/generic-imap-host.ts`, pure, checked before any
  network). A DNS name only. Accepted: `host` or `host:993`. Rejected: empty,
  IP literals in any spelling (dotted, decimal, hex, bracketed IPv6, anything
  that WHATWG IDNA folds to an address), userinfo and anything else with
  `@ / \ ? # [ ] %` or whitespace, a second colon, any port but `993`
  (canonical text), a trailing dot, a single label, a label outside
  `[a-z0-9-]` or over 63 characters, a name over 253 characters, a last label
  that is not alphabetic or `xn--`, and the internal suffixes `local`,
  `localhost`, `internal`, `localdomain`, `lan`, `home`, `corp`, `intranet`,
  `private`, `home.arpa`, `arpa`, `test`, `invalid`, `example`, `onion`, plus
  `metadata.goog`, and the hosts of providers that have their own connection
  (`imap.gmail.com`, `imap.googlemail.com`, `outlook.office365.com`,
  `imap-mail.outlook.com`, and every host of the exact Naver/iCloud allowlist, read
  from `isAllowedImapHost` so the lists cannot drift), answered "Use the built-in
  connection for that provider instead." The name is folded with `url.domainToASCII` (UTS 46: case,
  full-width forms, ideographic dots, punycode) and only the ASCII result is
  stored (`host:993`) and used. An IDN look-alike therefore stays a different,
  `xn--` host and can never equal its ASCII twin.
- D2 Resolve-then-pin (`mail/pinned-address.ts`, `mail/ip-policy.ts`). Klorn
  resolves A and AAAA itself (c-ares through `node:dns` `Resolver`, so neither
  `/etc/hosts` nor search domains), with a 3 s per-query timeout. The name is
  refused when it has no address OR when ANY answer is non-public. One address is
  pinned (first IPv4, else first IPv6). Non-public means: 0/8, 10/8, 100.64/10
  (CGNAT, Alibaba metadata), 127/8, 169.254/16 (link-local, AWS/GCP/Azure metadata),
  172.16/12, 192.0.0/24 (Oracle metadata), 192.0.2/24, 192.88.99/24, 192.168/16,
  198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4; IPv6 is default-deny:
  only 2000::/3 passes, minus 2001::/23 (Teredo, benchmarking), 2001:db8::/32,
  2002::/16 (6to4) and 3fff::/20, so `::`, `::1`, fc00::/7 (AWS `fd00:ec2::254`),
  fe80::/10, ff00::/8, NAT64 `64:ff9b::/96` and every other reserved block are
  refused. An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`, dotted or hex) is judged
  by the IPv4 address inside it.
- D3 The socket goes to the checked address, never to the name
  (`mail/imap-pinned-client.ts`). The client is built as before through
  `createImapClient` (still synchronous, so the poller, the verify handshake and the
  actions are untouched), then its `connect()` is wrapped: each call resolves the
  name afresh, checks every answer, and only then hands imapflow
  `tls: { host: <checked IP>, servername: <hostname>, rejectUnauthorized: true,
  minVersion: 'TLSv1.2' }` (imapflow merges the `tls` option over `host`/`servername`
  at connect time). The constructor `host` is `host.invalid`, which cannot resolve,
  so if a future imapflow stopped honouring `tls.host` the connection fails closed
  instead of resolving the name itself. Nothing is cached: every connection, poll or
  action re-resolves and re-checks, so a name that turns private after the
  connect-time check is caught on the next connection, and there is no window
  between check and connect because the connection targets the checked address.
  Certificate verification stays on with the hostname as SNI and name, so TLS still
  authenticates the server: a self-signed server is refused by design. There is no
  plaintext and no STARTTLS path. imapflow does not follow RFC 2221 referrals (it
  only parses them).
- D4 Bounded connections and sessions (reviewed 2026-09-30). One connect budget (the
  caller's `connectionTimeout`, default 15 s) covers the DNS wait AND the
  handshake; `greetingTimeout` defaults to 10 s. One wall-clock deadline of 90 s
  from the start of `connect()` hard-closes the session whatever it is doing, because
  imapflow's inactivity timer is reset by every byte a dripping server sends. A
  line, a literal and a whole response are capped at 2, 4 and 8 MiB (imapflow
  `maxLineLength`, `maxLiteralSize`, `maxResponseSize`, set after the caller's
  options so they cannot be raised; the response cap must stay above the literal cap).
  The poll fetches TEXT as a 64 KiB slice (`bodyParts: [{ key: "TEXT", start: 0,
  maxLength }]`, which imapflow sends as `BODY.PEEK[TEXT]<0.N>`) and stops consuming
  FETCH results at its window of 50, so a lying server cannot make one poll
  unbounded. Registry `maxAccounts` for generic is 3, not 10: the poll is serial, and
  each generic account is an arbitrary slow host.
  Second review (2026-10-01), which found the per-response caps were not enough: they
  bound ONE response, not a series. A SELECT answered NO makes imapflow LIST, and 400
  untagged LIST lines of 1 MiB (each far under every cap) grew RSS by 585 MiB. So a
  generic client has a byte budget for the WHOLE session, 32 MiB, counted at the
  stream every received byte is piped into (imapflow's `streamer`, so every command
  is covered): past it the session is hard-closed and no later byte reaches the
  parser (`GENERIC_SESSION_BYTE_BUDGET`; wire-tested against a LIST flood and a FETCH
  flood with the real library, with an honest 8 MiB transfer left alone). The
  scheduler no longer has a global tick lock: one boolean meant a tick that never
  settled stopped ALL IMAP polling, Naver and iCloud included (the heartbeat, then
  recorded ahead of the guard, stayed green). The double-poll guard is per ACCOUNT
  (`imap-accounts.ts`: a row whose previous poll is still running is skipped, released
  on every exit), the heartbeat is recorded inside a tick that runs, and EVERY
  provider's session now has a wall-clock deadline: 5 minutes for the fixed hosts
  (`FIXED_HOST_SESSION_DEADLINE_MS`; they had only a 30 s inactivity timer), 90 s for
  generic. Non-auth generic failures back the account off, 10 minutes doubling to a
  6 h cap, per account, in memory and size-bounded, cleared by a successful poll or a
  relink (`imap-poll-backoff.ts`; a stalling host used to cost a serial tick ~105 s
  every five minutes, three accounts per user). Everything here is generic-only except
  the per-account guard, the heartbeat placement and the fixed-host deadline: Naver
  and iCloud clients, queries and logs are otherwise unchanged (their suites pass
  untouched, apart from B2b's overlap test, below).
- D5 No oracle, no scanner. The connect route runs at most 10 attempts per user per
  hour (`mail/generic-imap-attempts.ts`, in-process like `login-throttle.ts`; answers
  429), on top of the route's per-IP limit (5 per 15 minutes), entitlement and the
  beta gate. Every failure before an authenticated session, whatever the cause
  (DNS, blocked address, refused, timeout, TLS or certificate failure, no IMAP
  greeting), answers one message: "Could not connect securely to that server."
  Only a rejected LOGIN, which needs a full verified TLS session and an IMAP
  greeting first, gets its own hint, because the user has to fix the password. Host
  syntax errors are static messages (they depend on the input, not on the
  network). Raw library errors are never returned, only logged server-side, and
  what is logged from a user-chosen server (a library or TLS message) is one line
  capped at 240 characters (`mail/log-text.ts`), so it cannot forge log lines or
  flood a log.
- D6 Every boundary re-checks. `checkImapRow` validates the stored host with the
  grammar for a generic row (and with the exact allowlist and host pin for
  Naver and iCloud, unchanged), so a row edited by hand still cannot reach
  anything the grammar refuses; resolution is checked in D3 at every connect.
  Folder trust for archive and trash stays SPECIAL-USE only (name lists are empty).
- D7 Host change is refused (v1, reviewed 2026-09-30). Connecting again with an
  existing generic address works only on the SAME host (compared in folded form:
  password rotation); another host answers a constant 409, "Disconnect this account
  first; changing the server is not supported yet.", before any attempt is counted or
  connection made. Re-pointing used to keep the row's INBOX UIDVALIDITY and every
  message row of the old server: the next poll either held the mailbox forever, or,
  when both servers report the same UIDVALIDITY, matched the new server's UIDs to the
  old `generic-imap:<email>:<uid>` rows and dedupe-dropped real mail. The follow-up is
  the B2b UIDVALIDITY re-key (tombstones, now on main) run on a host change; it is not
  wired here: a host change is refused, not repaired.
- D8 A rejected login stops the retries (reviewed 2026-09-30). A generic poll whose
  LOGIN is rejected starts the same in-process cooldown the actions use (15 min,
  keyed by row id and stored cipher, so one rejection pauses polls and actions
  alike and a new password is tried at once) and sets `needsReconnect` on the row
  (scoped by id and user; the settings status already reports it, and a successful
  reconnect clears it). A flagged or cooling row is skipped by the poll, so a revoked
  password is not sent to the host every five minutes. The actions of B1/B2 did not
  flag `needsReconnect` and still do not; only the poll does, for generic rows. Other
  failures (refused, timeout, TLS, blocked address) are retried next tick with no
  flag. Sentry gets one event per account per failure kind until the kind changes or
  a poll succeeds (`mail/imap-poll-failures.ts`), reported by the fan-out only; the
  poll's own `.sync` report is skipped for generic rows, which was a duplicate.
- Residual risk, accepted and recorded. (a) One address is tried per connection: a
  round-robin name with a dead first record fails that attempt (the next poll
  retries). (b) Failure classes differ in timing (NXDOMAIN is faster than a timeout),
  which the per-user limit bounds but does not remove. (c) The attempt limiter is
  in-process: a restart resets it and each replica counts alone (single instance on
  Render today). (d) The bounds cap a slow host at 90 s per session, so a user with
  3 generic accounts can cost a tick up to 4.5 minutes until the backoff slows them;
  ticks overlap rather than queue, each skipping the accounts already in flight.
  (e) A name that is a CNAME to a built-in provider host (for example a vanity name for
  imap.gmail.com) passes the host grammar, which looks at the name typed; it connects
  as an ordinary generic account and fails the login or works as IMAP. A UX gap only
  (the user should have used the built-in connection), not a security one, so there
  is no code for it. (f) Network-level egress filtering on the host would be a second
  layer; not verified, not assumed.
- Verify (test-first): a table-driven validator test (every range above, mixed
  public and private answers, rebinding between two resolutions, IP literals in
  every spelling, userinfo and port injection, IDN folding, internal suffixes);
  connection tests that assert the socket target is the checked address and the
  TLS name is the hostname; a wire test with the real imapflow over real TLS
  (throwaway certificate) proving the handshake is to the pinned address, verified
  against the hostname, and refused for a wrong certificate. Review fixes added:
  a wire test where the real library refuses an oversized literal and a server that
  drips bytes is cut by the session deadline; unit tests for the budget shared by
  DNS and the socket (fake timers), the window cap, the bounded TEXT query, the
  scheduler guard, the host-change refusal, the cooldown and the Sentry dedupe.
- Landed 2026-09-30 (branch `feat/generic-imap`, PR not yet opened), flag OFF:
  - `GENERIC_IMAP_ENABLED` (`genericImapEnabled()` in `config.ts`, lenient parse,
    read at request time). Off: `/api/generic-imap/*` answers the cloaked 404
    (`darkRouteGate`), the poll never selects IMAP rows
    (`enabledImapProviderKeys()`), and dispatch leaves a generic mailbox on the
    unsupported stubs whatever the B1/B2 flags say. On, a generic mailbox gets B1
    only with `IMAP_ACTIONS_ENABLED` and B2 only with `IMAP_MOVE_ACTIONS_ENABLED`.
    `IMAP_SEND_ENABLED` changes nothing for it (no send part exists).
  - New modules, each pure or single-purpose: `generic-imap-host.ts` (D1 grammar),
    `ip-policy.ts` (D2 address policy, strict hand-written IPv4/IPv6 parsing),
    `host-resolver.ts` (c-ares `Resolver`, A and AAAA, 3 s per query, 2 tries),
    `pinned-address.ts` (refuse on no answer or any non-public answer, pin one),
    `imap-pinned-client.ts` (D3 connect wrapper), `generic-imap-attempts.ts` (D5
    limiter), `generic-imap-verify.ts` (D5 message collapse).
  - Registry: `IMAP_PROVIDERS.IMAP` (`hostPolicy: "user-supplied"`, `idPrefix`
    `generic-imap`, `maxAccounts` 3, `smtp` and `webmailUrl` null). Naver and iCloud
    gain `hostPolicy: "fixed"` and nothing else; their client options, allowlist and
    host pin are unchanged (asserted byte for byte). `hostMatchesProvider` for the
    generic provider is the grammar. `checkImapRow` applies the grammar to a stored
    generic row and the exact allowlist to the others.
  - `createImapClient` stays synchronous: a generic provider gets the pinned client,
    the others a plain one. `imap-sync.ts`, `imap-poll-guards.ts`,
    `imap-uidvalidity.ts` and `email-firewall.ts` are untouched, so the B2 poll
    (INBOX only, 50-message window, UIDVALIDITY baseline and hold) applies unchanged
    to generic rows.
  - Connect route: host required; grammar first (static messages, no attempt
    counted), then the new-account cap (3), then the attempt limiter (429 with
    `retry-after`), then verify, then upsert of the folded host and `encryptToken`
    password. `email-undo.ts` takes the IMAP re-sync path for any IMAP-family key.
    Archive and trash folder trust is unchanged: SPECIAL-USE only.
  - Tests (hermetic): the table-driven validator and address-policy tests above;
    `imap-generic-connection.test.ts` (target address, TLS name, rebinding between
    connections, close during resolution, Naver unchanged); `imap-pinned-wire.test.ts`
    (real imapflow, real TLS, throwaway openssl certificate: pinned address, SNI and
    verification against the host name, wrong-name and untrusted certificates refused
    with no LOGIN sent, blocked answers open no socket); poll, dispatch, route,
    verify, limiter and registry tests. Mutations run and caught: skipping
    re-resolution, accepting any one public address among mixed answers, letting the
    library resolve the name, certificate verification off, no TLS server name,
    CGNAT block dropped, internal-suffix check dropped, mapped-address unwrap
    dropped, generic flag ignored, attempt counted before host validation.
  - Review fixes (second commit, same day): D7 host-change refusal, D4 size and time
    bounds with the in-flight scheduler guard, D8 poll cooldown, reconnect flag and
    Sentry dedupe, built-in provider hosts refused, the resolver's error code kept in
    the log, server text sanitised before logging, and the wire test's openssl call
    made portable (it skips with a warning if the binary is missing). imap-sync.ts
    has three small additive edits: the TEXT query and the window break in the fetch
    loop and the failure report in the final catch.
  - Second review fixes (2026-10-01): the session byte budget; the per-account guard
    in place of the global tick lock, the heartbeat inside the tick and a 5 minute
    session deadline for every provider; the backoff; `syncImapMessage` fetches the
    same TEXT slice as the poll; a poll that started before a relink flags
    `needsReconnect` only while the row still holds the cipher it began with (a
    conditional write); a generic account is stored by a conditional create or update,
    never an upsert (an existing row is updated only while it still has the host it
    was checked with, and a unique-key collision with a concurrent create is settled by
    the winner's host: same host is a double click, another host is the 409), so two
    concurrent first connects to different hosts cannot both pass; a stored subject
    and cc are capped at 1 000 and 4 000 characters for every provider (neither was
    capped anywhere; shorter values are stored exactly as before, and the subject cap
    lives in `envelopeSubject`, the one place the stored and the compared value are
    derived). B2b's "overlapping polls" test now stages its race from a poll outside
    the in-process guard, which is what two processes (a rolling deploy) are.
  - Rebased onto B2b (#1351, 2026-09-30). Conflicts were the `.env.example` flag
    blocks (both kept), the `imap-sync.ts` imports and the `lastSyncedAt` stamp in
    `imap-accounts.ts`: B2b's rule (a held poll stores nothing, so it does not stamp)
    and this step's failure re-arm both apply, so a held generic poll neither stamps
    nor re-arms the Sentry report. B2b's hold, repair, tombstones, re-ingested-history
    cutoff, PUSH and urgent-sweep dedupe floors and the auto-mode exclusion all apply to
    generic rows with NO production change: `isImapMessageId` derives its prefixes
    from `IMAP_PROVIDERS` (`imap-message-id.ts`), the registry already holds the
    generic entry, and B2b's modules take the provider config (`idPrefix`,
    `logScope`) instead of naming providers. `canAutoSendFromMailbox` allows only
    GOOGLE, so a generic mailbox never gets an unattended reply. What was missing was
    proof, added test-first: the real poll, hold, repair, history and actions for a
    generic mailbox (`imap-generic-reset.test.ts`, with the scheduler's per-account
    guard and the hold together: a held generic mailbox is stamped by no tick, and a
    stuck account does not block the next tick), the primitives with Gmail and Outlook ids excluded
    (`imap-generic-protections.test.ts`), and B2b's firewall PUSH, urgent sweep,
    rule auto-reply and auto-mode tests re-run over a generic id head. Detection
    hard-coded back to the two prefixes fails 18 of those tests.
  - Not verified: no real IMAP server has been reached; behaviour rests on faked
    imapflow and resolver plus a local TLS server on loopback. The openssl
    invocation was run on LibreSSL only, not on OpenSSL 3. The real c-ares
    resolver path (`host-resolver.ts`) is tested only against a mocked `Resolver`.
    Whether Render's egress can reach IPv6 and what a real provider's LIST reports
    are unknown. A self-signed server is refused by design.
- Before the flip: (1) security review sign-off of this block and of the code;
  (2) real-server tests from the Render egress: Fastmail, Daum or Kakao, and a
  self-hosted Dovecot with a publicly trusted certificate, each for connect, poll,
  read, star, archive and trash (record the LIST SPECIAL-USE flags each reports);
  (3) rate-limit tuning (10 attempts per hour, 3 accounts) against what those
  servers tolerate; (4) check which address families the egress can reach, since one
  address is pinned per connection; (5) decide whether the host should also be
  blocked at the network layer.

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

**C3 — CalDAV connector for iCloud and Naver, read-only.** Depends on: C2.
- Tasks: link an iCloud or Naver account for its calendar with an app-specific
  password; an ICLOUD and NAVER implementation of the C2 provider seam; the C2
  linked-sync loop syncs it into rows; rows of events deleted upstream removed;
  unlink.
- Landed 2026-10-01 (branch `feat/caldav-calendar`, PR not yet opened). No
  migration: `CalendarProvider.ICLOUD` and `NAVER` and
  `LinkedCalendarAccount.caldavPasswordCipher` came with C1, the per-source row key
  with C2. One new dependency, `ical.js` (below).
  - Change from the outline. The outline assumed a user-supplied `caldavUrl`. v1
    takes NO URL: each provider's base URL is pinned in
    `pim/caldav/caldav-providers.ts`, the link body has no URL field (an extra field
    is dropped by the schema, tested), and `caldavUrl` stays NULL on every row. A
    generic CalDAV server (user URL, RFC 6764 discovery) is a later step and needs
    the outline's resolve-pin-reject design for the first hop too; the guard below
    already does it for every hop.
  - Flag `CALDAV_CALENDAR_ENABLED` (OFF, lenient parse, read per call, in
    `.env.example`), one flag for both providers. Off: the three routes answer
    Fastify's default 404 (`darkRouteGate`), `calendarActionsForProvider` answers
    ICLOUD and NAVER with the unsupported stub it answered before C3 (no request,
    no decrypt, no row), every reader hides ICLOUD and NAVER rows already stored,
    and the window reconcile removes nothing (each tested, and each killed by a
    mutation that removes the check). Syncing events also needs
    `LINKED_CALENDAR_SYNC_ENABLED` and the user's entitlement, the C2 loop's own
    gates. Independent of `ICLOUD_INBOX_ENABLED`: the calendar routes are their own
    dark surface.
  - Base URLs, checked 2026-10-01. Neither provider has an official page naming its
    CalDAV server. iCloud `https://caldav.icloud.com`: Apple Community threads show
    discovery handing out per-account partition hosts `pNN-caldav.icloud.com`
    (https://discussions.apple.com/thread/6447414,
    https://discussions.apple.com/thread/255132611); third parties document the
    host (https://cli.nylas.com/guides/icloud-caldav-settings); login is the Apple
    ID and an app-specific password (https://support.apple.com/en-us/102654).
    Naver `https://caldav.calendar.naver.com`, principal
    `/principals/users/<Naver ID>/`, the Naver ID and a 2-step-verification
    application password (https://extrememanual.net/41175,
    https://blog.miyu.pe.kr/992). One guide calls the Naver endpoint unofficial and
    liable to disappear; Naver's help centre has no page for it. That is a product
    risk for the flip, recorded here. Probed 2026-10-01 without credentials through
    the shipped transport: both hosts resolve to public addresses, the TLS handshake
    to the pinned address under the host name succeeds, and a PROPFIND at the root
    answers 401 with no redirect. Nothing past that was checked.
  - SSRF guard (`pim/caldav/caldav-http.ts`, `caldav-providers.ts`, and B4's
    `mail/host-resolver.ts`, `mail/pinned-address.ts`, `mail/ip-policy.ts`, reused
    as they are). Every request, the base URL and every
    href and redirect after it, goes through, in order: https only; no userinfo; no
    IP literal (after WHATWG parsing, so `0x7f000001` is caught); port 443 only; a
    host on the provider's own allowlist (iCloud: exactly `caldav.icloud.com` or
    `^p\d{1,4}-caldav\.icloud\.com$`, stricter than a `.icloud.com` suffix; Naver:
    exactly `caldav.calendar.naver.com`; the two never share a host); DNS asked
    directly (c-ares, not `dns.lookup`) and EVERY answer checked public (IPv6
    default-deny); the connection made to that one checked address with the host
    name kept for SNI and the certificate (`lookup` pinned, `agent: false`).
    Redirects are never followed by the transport: a 301/302/307/308 is resolved
    against the URL that answered and re-checked as a new hop, at most
    `CALDAV_MAX_REDIRECTS` (3), so Basic credentials only ever reach an allowlisted
    host. Bounds, named constants: `CALDAV_MAX_RESPONSE_BYTES` 4 MiB per response
    (a declared or streamed overrun is cut off; compressed bodies refused, identity
    asked for), `CALDAV_REQUEST_TIMEOUT_MS` 15 s per request, `CALDAV_SYNC_DEADLINE_MS`
    45 s per listing and `CALDAV_LINK_DEADLINE_MS` 20 s per link verification
    (DNS included; a transport that ignores the abort cannot hold the caller), at
    most `CALDAV_MAX_CALENDARS` (25) calendars per account. Error messages are
    constants; no URL, server text or credential reaches a log, Sentry or a user.
  - Link. `POST /api/caldav-calendar/link` (Pro-gated, `rateLimit` 5 per 15
    minutes like the IMAP connect route, demo user refused) with `{ provider,
    username, password }`. iCloud logs in with the Apple ID (an address); Naver with
    the Naver ID (`id@naver.com` is reduced to it, the account is listed as
    `id@naver.com`, and the ID is checked against `[a-z0-9][a-z0-9_-]{0,29}` because
    it reaches a URL path). Verification is discovery steps 1 and 2 (principal,
    calendar home) through the guard. EVERY verification failure (401, 5xx, a
    refused redirect, a private address, unreadable XML, a timeout, the legacy
    `(userId, email)` unique) answers one constant message, so the route is no
    oracle; the class is logged (`http:401`, `guard:host`...). The password is
    stored with `encryptToken` in `caldavPasswordCipher` (already covered by the
    key-rotation sweep since C1), never returned, never logged (tested). NEW links
    are capped at 10 per provider; a re-link is always allowed and clears
    `needsReconnect` and the failure backoff. `GET /linked-calendars` (never a
    password) and `DELETE /linked-calendars/:id` (provider read first, scoped to
    ICLOUD/NAVER, then `unlinkCalendarAccount` with it) sit beside it; the three
    handlers are named functions (review 2026-10-02, no behaviour change). Review
    fix 2026-10-02: a second limit, 5 per 15 minutes per Apple ID or Naver ID
    (normalised by `caldavAccountIdentity`, sha256 in the limiter's key, through
    `@fastify/rate-limit`'s `createRateLimit`), checked just before Apple or Naver
    is asked, so rotating IPs cannot hammer one account's password (a lockout of
    the victim, our egress IP blocked); the IP limit stays (tested both ways). NOT
    changed: the IMAP connect route (B4) has the same IP-only gap.
  - Reusing the linked inbox's app password: simple and safe, so offered.
    `{ provider, username, reuseInboxPassword: true }` reads the user's OWN
    `LinkedInboxAccount` of the same provider and address, decrypts it, verifies it
    against CalDAV and stores its own cipher. The password never leaves the server,
    and an Apple app-specific password already grants the whole account, so the copy
    widens nothing. Unlinking the inbox does not unlink the calendar. Not verified:
    whether an iCloud MAIL address works as the CalDAV login when it differs from the
    Apple ID, and whether one Naver application password serves both IMAP and
    CalDAV; a refusal is just the generic failure.
  - Sync. No change to the loop or the scheduler. `syncLinkedCalendarWindow` prefers
    a session's optional `listWindow` (new on `CalendarSession`, CalDAV only), which
    returns the events plus `complete`. Discovery every sync (3 PROPFINDs), then one
    `calendar-query` REPORT per VEVENT calendar (`supported-calendar-component-set`
    absent or naming VEVENT; reminders, inbox and notification collections are not
    read) with a time-range one day wider than the window on each side, so an
    all-day or floating event the server reads in its own zone still comes back.
    The window cut is made here, with the same instants the rows store. Rows: the
    provider of the session, `externalId` = the UID (a series occurrence
    `UID#<original start, UTC stamp or date>`, so a moved occurrence keeps its id; a
    UID over 400 characters hashed), `sourceAccountId` and `sourceKey` = the account
    id, same 30 days per account; a CalDAV listing holds up to
    `CALDAV_LISTING_MAX_OCCURRENCES` (500, its own constant since the review: the
    sync's `CALENDAR_SYNC_MAX_RESULTS` of 100 is Google's page size, and a month of
    100+ occurrences turned every removal off). Change from the brief: `sourceKey`
    is per ACCOUNT, not per CalDAV calendar, because C2's CHECK pins it to
    `COALESCE(sourceAccountId, 'primary')`; one UID in two calendars of one account
    is one row. Each row records the calendar that listed it in
    `CalendarEvent.caldavCalendarKey` (review fix; migration
    `20261005010000_calendar_caldav_calendar_key`, one nullable TEXT column, no
    backfill: a sha256 prefix of the collection path, never the path, which carries
    the iCloud account number). A 401 anywhere throws (the password was revoked:
    the shared failure policy flags `needsReconnect`, once-an-hour warning, no
    Sentry, tested through the real dispatcher); any other failure of one calendar
    leaves it out and makes the listing incomplete; every calendar failing throws
    the first error. Review fixes 2026-10-02: (a) a flagged account opens no CalDAV
    session at all, so the conflict checks (which still try a flagged Google or
    Outlook account) never send a revoked app password again. Only a re-link
    clears the flag, as for Outlook (`routes/outlook-calendar-link.ts`; nothing in
    `outlook-token.ts` clears it); Google clears it on a refreshed token
    (`mail/gmail.ts` `persistRefreshedLinkedToken`), which has no CalDAV equivalent:
    an app password does not heal. (b) Any failure but a 401 backs the account off
    (`pim/caldav/caldav-backoff.ts`, the pattern of `mail/imap-poll-backoff.ts`):
    15 minutes doubling to 6 hours, cleared by a listing that returns or a re-link;
    while backed off no session opens, so neither the sync tick (up to 45 s per
    stalled account) nor a conflict check waits on it. (c) Sentry hears of a CalDAV
    failure once per account per kind (`caldavErrorClass`) per process; the warning
    line stays. Google and Outlook pass their own provider and keep the old policy
    (their tests unchanged and green).
  - Parsing (`pim/caldav/ical-events.ts`, ical.js). All-day DATE values are UTC
    midnight of the date, end exclusive, like Google's. A TZID Intl knows (IANA, a
    Windows name through the Outlook table, or a prefixed form such as
    `/mozilla.org/.../Europe/Berlin`) is read with `wallClockToUtcMs`, so the tz
    database decides DST, not a VTIMEZONE carrying some years' rules; any other
    TZID through its own VTIMEZONE (ical.js, no global registration); none, or a
    floating time, in the user's zone. RRULE/RDATE expansion, EXDATE and
    RECURRENCE-ID overrides (moved, cancelled, and moved INTO the window from a later
    original time): ical.js walks RRULE/RDATE only; EXDATEs and overrides are
    matched here by INSTANT (`ical-events.ts`). ical.js drops a TZID it has no
    VTIMEZONE for and reads the value as floating, so it missed a UTC RECURRENCE-ID
    or EXDATE against a TZID start and took an EXDATE at the same wall clock in
    another zone for a match; every value is now read with the TZID its property
    was written with (`ical-time.ts`), never the user's zone. A DATE EXDATE still
    removes a timed occurrence on that date (ical.js's rule for the mixed form).
    `STATUS:CANCELLED` on an event or an override drops it. An override of an
    instance an EXDATE removes is dropped with it (EXDATE wins; RFC 5545 does not
    say; tested). Bounds: a series is
    walked at most 25 000 steps and one listing 200 000 in all (a rule with no
    COUNT or UNTIL, MINUTELY or SECONDLY, cannot pin the CPU or starve the next
    one); running out marks the listing truncated. ical.js's own search for the
    next occurrence has no bound for SECONDLY to WEEKLY rules (`FREQ=DAILY;
    BYMONTH=2;BYMONTHDAY=30` never returned, synchronously), so
    `ical-recur-guard.ts` counts its passes, 12 000 per occurrence (was 50 000:
    Feb 29 on a given weekday recurs every 28 years, 10 227 days, so a DAILY rule
    fits; an impossible rule now costs ~10 ms, measured) and 1 200 000 per listing;
    an INTERVAL over 1 000 and more than 10 RRULEs in one VEVENT
    (10 000 RRULEs in a 340 KB object blocked the event loop 6.5 s) are refused up
    front. Each makes the object unreadable. BYxxx lists need no bound of ours:
    ical.js 2.2.1 refuses out-of-range values and keeps distinct values only
    (tested). The guard patches ical.js's `RecurIterator` prototype, so
    `package.json` pins `ical.js` to exactly `2.2.1`; since the review it installs
    on the first CalDAV listing, once, not at import (main's process is untouched
    while the flag is off; tested in its own file), and throws if the methods it
    wraps are gone. Anything unreadable is counted, never guessed.
    Review fixes 2026-10-02 (`ical-bounds.ts`; the review measured 53 s, 40 s,
    4.4 s and 2.4 s on four hostile inputs): caps per object and per listing on
    VEVENTs (1 000 / 5 000), overrides (500 / 2 500), RDATE values (1 000 / 5 000)
    and EXDATE values (1 000 / 5 000), counted on the parsed jCal before anything is
    expanded: an object over one is skipped whole, one warning per listing, listing
    truncated. A parse budget of 2 s of working time per listing (waits for the
    event loop not counted), checked before each object and on every step of a
    walk: running out truncates. The work yields to the event loop (`setImmediate`)
    every 10 ms, so a large legitimate calendar holds the process one slice plus one
    bounded step at a time. Override instants are a sorted array searched by
    bisection, not scanned on every step. A truncated listing never removes a row.
    The CalDAV XML reader refuses a document over 60 000 elements (a 4 MB body of
    `<a/>`: 357 ms and 168 MB of heap -> 26 ms and 17 MB here).
    Measured on this machine (scratch benchmark, before -> after over two runs,
    the longest event-loop block after in brackets): 20 000 VEVENTs x
    `COUNT=100000` in one 2.7 MB object 18 171 ms -> 58-90 ms (the same); one
    VEVENT with 200 000 RDATEs, descending, 18 574 -> 90-100 ms (the same); 30 000
    overrides of a DAILY series 1 982 -> 64-93 ms (the same); 500 overrides (the
    cap) of a DAILY series since 1990 242 -> 130-133 ms (20-22); 60 impossible
    rules 1 906 -> 654-660 ms (61-74 on the cold first slice, under 25 after);
    2 000 weekly series since 2015 1 002 -> 1 005-1 084 ms (20; still truncated by
    the 200 000-step listing cap). What remains of the hostile blocks is ical.js
    parsing one object, which is not sliced: ~60-100 ms for a 3-4 MB object,
    bounded by the 4 MB response cap.
    `meetingLink` is the first `CONFERENCE` or `URL` value `safeMeetingLink` passes
    (https only, `pim/meeting-link.ts`, #1354).
  - Removal of vanished events (`pim/calendar-window-reconcile.ts`). Google never
    removes a row for being absent (C2b). CalDAV may: a time-range query returns
    every object with an instance in the range, so a COMPLETE listing is the
    window's whole current set. Complete means at least one calendar found, every
    collection under the home classified (a 403 entry or an unreadable
    `resourcetype` may hide an event calendar), none over the calendar cap, every
    calendar answered, no 507 from the server, every object response carrying data
    (any status), nothing unreadable, no series cut short, no object skipped over a
    cap, the parse budget not spent, and no more than 500 occurrences. Then, in one
    transaction, the rows of
    that account (user, provider, source key) inside the window (same overlap rule)
    whose `externalId` the listing lacks AND written before the listing started (so
    a concurrent sync's fresh row is never taken) are deleted, their open or snoozed
    attention items resolved, one log line per account with counts only. Only for
    ICLOUD and NAVER, only with `CALDAV_CALENDAR_ENABLED` on. Truncated, partial,
    unreadable and thrown listings remove nothing (tested; a mutation of each
    condition is killed). A row whose event is past the window is untouched, like
    Google's. Review fixes 2026-10-02: (a) only rows of a calendar the listing read
    are candidates; a row whose `caldavCalendarKey` names a calendar the discovery
    did not list (or none) is unknown, never removed. (b) The deletion valve: a
    removal of more than half (`CALDAV_DELETE_MAX_SHARE`) of the account's rows in
    the window, when over 5 rows (`CALDAV_DELETE_VALVE_MIN_ROWS`), is refused (a
    transient empty 207 would otherwise remove the window and resolve its attention
    items, with nothing to restore them); one warning and one Sentry event per
    account per process. The share counts every row of the account in the window,
    including the ones this sync just wrote. (c) Unchanged: only a complete listing
    removes. Tested: an empty 207 over 8 rows, a calendar missing from discovery, a
    single legitimate removal, the valve's edges, 150 occurrences still complete.
  - Free/busy. `busyBlocks` is a live listing of the window: timed occurrences not
    `TRANSP:TRANSPARENT`, label `calendar`, no title. `peopleFreeBusy` answers
    unknown for everyone (CalDAV shows no one else's calendar). Writes reject with
    `CalendarReadOnlyError`.
  - Readers. ICLOUD and NAVER are registered in `CALENDAR_PROVIDER_ENABLED` as
    `caldavCalendarEnabled`. Every C7 reader keys on `sourceAccountId`, never a
    provider name (C4's guard), so a CalDAV row is read-only, wrapped as untrusted,
    and title-free in a conflict exactly like a linked Google or Outlook row
    (`calendar-caldav-read.test.ts`). Side effect, intended: with the flags off every
    reader's `where` now carries `provider: { notIn: ["OUTLOOK", "ICLOUD", "NAVER"] }`
    (the flag-off query tests assert the new shape).
  - Dependency. `ical.js` 2.2.1: 1,021,863 downloads in the week to 2026-09-29, last
    release 2025-08-08, one npm maintainer (Philipp Kewisch, Mozilla Thunderbird),
    zero runtime dependencies, MPL-2.0 (not marked Incompatible With Secondary
    Licenses, so it combines with AGPL-3.0). Pinned exactly (`"ical.js": "2.2.1"`,
    no caret) because the recurrence guard patches its internals (lazily, since the
    review). Lockfile: +7
    lines, one package.
    `pnpm audit --prod`: no known vulnerabilities. Rejected: `tsdav` 2.3.5 (177,473
    a week, MIT, pulls `debug` and `xml-js`, and does its own fetching, which would
    have to be bypassed for the pinned, manual-redirect transport), `node-ical`
    (pulls `rrule-temporal` and `temporal-polyfill`), and `fast-xml-parser` (95M a
    week, MIT, six dependencies; in the tree only as an optional transitive, pinned
    by a root override since #1007's audit clean-up). The CalDAV client is about 210
    lines here and the XML reader about 170 (local names, five entities, DOCTYPE
    refused).
  - No UI. C4 added none for Outlook ("belongs to C7's web and desktop work"), so
    C3 adds none: no web page, no Swift, no locale strings. The routes exist and are
    dark.
  - Shared address policy. B4 landed first (#1353), so C3 dropped its copies
    (`net/ip-policy.ts`, a verbatim copy of `mail/ip-policy.ts`, its test, and
    `net/pinned-host.ts`) and imports B4's modules; the CalDAV guard tests run
    against them. NOT done: main's `notify/is-safe-push-endpoint.ts` `isPrivateIp`
    (deny list, default-allow IPv6) is a weaker third and should move onto
    `mail/ip-policy.ts` in its own change.
  - `time-zone.ts`: one cached `Intl.DateTimeFormat` per zone (at most 1 000), since
    a long series paid a formatter construction per occurrence. Same output:
    `wallClockToUtcMs`, `localDayUtcRange`, `localDateKey`, `localMinuteOfDay` and
    `offsetStringFor` compared against main's file over 14 zones (DST edges, an
    unknown and an empty zone), 245 560 calls, 0 differences.
  - Known limits. (1) Only ICLOUD and NAVER; no generic CalDAV. (2) The legacy
    `(userId, email)` unique still exists: an Apple ID already linked as a Google or
    Outlook calendar cannot also be linked (generic failure, logged), as in C4.
    (3) No iCalUID cross-provider dedupe (C7's decision stands); two accounts holding
    one invite are two entries unless they share provider and UID. (4) Discovery runs
    every sync (3 PROPFINDs per account per 15 minutes); the home set is not cached.
    (5) Rows store no transparency, so a transparent timed event is a row conflict
    (C7's limit (2)). (6) Found while wiring, NOT fixed (pre-existing, outside C3):
    `readSyncTimezone` in `pim/calendar-sync.ts` reads `User.timezone`, which does
    not exist (the zone is on `AutomationConfig`), so every sync passes the default
    `Asia/Seoul`; CalDAV floating times are read in Seoul during the sync, as are
    Google's offset-less times. `busyBlocks` reads the configured zone. (7) ical.js
    2.2.1 does not expand a YEARLY rule with BYHOUR, BYMINUTE or BYSECOND as RFC
    5545 says (`FREQ=YEARLY;BYHOUR=9,10` gives one time a year; with BYSECOND as well,
    nothing). Such a series is missing or wrong, the same way every sync, so it never
    had rows to remove; neither provider's UI writes such a rule. (8) PARTSTAT is
    not read: an invitation the user DECLINED is still a busy block and a row (no
    code change; review 2026-10-02). (9) Every fixture is hand-written from RFC
    4791 / 5545 shapes; none was captured from a real iCloud or Naver answer.
    (10) The deletion valve also refuses a real mass deletion (more than half of a
    month, over 5 rows): those rows stay until they leave the window. (11) An
    override of an EXDATE'd instance is dropped (EXDATE wins). (12) Found by the
    review fix, NOT fixed (ical.js): an RDATE-only VEVENT (no RRULE) is iterated
    without its DTSTART instance, so that instance has no row. (13) One object's
    ical.js parse is not sliced (~60-100 ms for 3-4 MB, bounded by the response
    cap). (14) The IMAP connect route's link limit is per IP only (see Link).
  - Rollback. Flags never on: revert the PR. Ever on: set
    `CALDAV_CALENDAR_ENABLED` OFF (rows hidden at once), then `DELETE FROM
    "AttentionItem" WHERE "source" = 'CALENDAR_EVENT' AND "sourceId" IN (SELECT "id"
    FROM "CalendarEvent" WHERE "provider" IN ('ICLOUD', 'NAVER'))`, then `DELETE FROM
    "CalendarEvent" WHERE "provider" IN ('ICLOUD', 'NAVER')`, then revert. The
    accounts can stay: nothing reads them while the flag is off. The
    `caldavCalendarKey` column is additive and nullable: a revert leaves it unused;
    drop it only after.
  - Before the flip (founder; the code only ever ran against a fake CalDAV server
    built from RFC 4791 / RFC 5545 shapes). With one real iCloud and one real Naver
    account: (a) the link verifies with an app-specific password and fails with the
    generic message on a wrong one; (b) discovery answers as assumed: iCloud's
    principal at the root and its home set on a `pNN-caldav.icloud.com` host the
    pattern accepts, Naver's root PROPFIND answer (404 or a principal) and its home
    set; record any redirect; (c) one sync writes the expected rows: a timed event,
    an all-day event read from a zone west and one east of UTC, a recurring series
    with a deleted and a moved occurrence; (d) delete an event upstream and see its
    row removed on the next sync, confirm a calendar of 101-500 occurrences in the
    window still removes one, and one over 500 removes nothing; delete most of a
    test calendar's month upstream and see the valve refuse it once in Sentry; (e)
    revoke the app-specific password: the next sync flags `needsReconnect`, warns
    once, Sentry stays quiet, and a conflict check sends nothing to Apple; (f) the
    `reuseInboxPassword` path with a linked iCloud and a linked Naver inbox; (g)
    unlink removes the rows and their attention items. Decide on the Naver risk
    above before flipping for Naver users.
- Exit: flag OFF, no user-visible change. Nothing is flipped.
**C4 — Microsoft Graph calendar, read-only.** Depends on: C2. Needs FA-9
(`Calendars.Read` on the Azure app) before the flip, not before the merge.
- Tasks: link an Outlook account for its calendar over the existing Outlook OAuth
  app; an OUTLOOK implementation of the C2 provider seam (events, free/busy);
  the C2 linked-sync loop syncs it into rows; unlink.
- Landed 2026-09-30 (branch `feat/graph-calendar`, PR not yet opened). No
  migration: `CalendarProvider.OUTLOOK` and the per-source row key came with C1
  and C2.
  - Flag `OUTLOOK_CALENDAR_ENABLED` (OFF, lenient parse, read per call). It
    also needs `OUTLOOK_INBOX_ENABLED`, like the Outlook mail path:
    `outlookCalendarEnabled()` in `config.ts` is the AND of the two. Off (either
    one): the three calendar routes answer Fastify's default 404 (`darkRouteGate`,
    byte-identical to an unregistered route) and `calendarActionsForProvider(
    "OUTLOOK")` answers the same unsupported result it did before C4, so no
    Graph call, no token read and no row can follow (tested with a mutation that
    removes each check). Syncing events additionally needs
    `LINKED_CALENDAR_SYNC_ENABLED` and the user's entitlement, which are the C2
    loop's own gates; nothing there changed.
  - Link. `POST /api/auth/outlook/link-calendar` (Pro-gated, rate limited, 503
    without the Azure credentials) returns the authorize URL; the callback is the
    inbox link's, `/api/auth/outlook/callback`, so Azure needs no new redirect
    URI. A distinct signed-state marker, `__link_outlook_calendar__` (10 minute
    JWT), sends it to `routes/outlook-calendar-link.ts`, which upserts a
    `LinkedCalendarAccount` keyed (userId, OUTLOOK, email) with encrypted tokens
    and lands on `/calendar?linked=success|failed|limit` (the markers the Google
    flow uses). Re-checks entitlement at the callback (TOCTOU), caps NEW links at
    10 per user and always allows a re-link, and a calendar state that arrives
    after the flag went off exchanges nothing and writes nothing. An inbox state
    still writes only an inbox row. `GET /linked-calendars` (never tokens) and
    `DELETE /linked-calendars/:id` sit beside it.
  - Scopes. `Calendars.Read` is requested ONLY for a calendar link, and for
    refreshing a calendar account's token. `getOutlookAuthUrl`,
    `exchangeOutlookCode` and `refreshOutlookTokens` take a scope set that
    defaults to `inbox`, which is byte-for-byte the list that shipped (tested
    against a literal copy, with a mutation that adds the calendar scope to it),
    so no existing inbox link asks for anything new. The calendar set is
    `openid email offline_access User.Read Calendars.Read`: read-only and no
    `Mail.*`, so a calendar link never asks an org admin for mail access.
    `User.Read` is asked for explicitly so Graph `/me` can name the account; the
    inbox set has never listed it and relies on Microsoft adding it, which the
    tenant test below also checks. A user with an Outlook inbox linked who adds
    the calendar sees one consent screen for the new scope and gets a separate
    `LinkedCalendarAccount` row with its own tokens.
  - Provider (`pim/calendar-providers/outlook*.ts`; docs checked 2026-09-30).
    Events: `GET /v1.0/me/calendarView?startDateTime&endDateTime&$top&$orderby=
    start/dateTime&$select`, https://learn.microsoft.com/graph/api/calendar-list-calendarview
    (the window values are read with their own offset; `$top` 1 to 1000;
    recurring series come back as occurrences). Paging follows `@odata.nextLink`
    (https://learn.microsoft.com/graph/paging), at most 10 pages, only to an https
    link on graph.microsoft.com (the token rides every request), and stops at
    `maxResults`. Cancelled events (`isCancelled`) are left out and do not count
    toward the cap. Header `Prefer: outlook.timezone="<user zone>", IdType=
    "ImmutableId"`: the zone Graph renders times in (UTC without it), and
    immutable ids (https://learn.microsoft.com/graph/outlook-immutable-id) so an
    event moved between folders keeps its `externalId` instead of syncing as a
    new one. Graph answers naive wall-clock times plus a zone name: read in that
    zone when Intl knows it, else in the zone the query asked for. An all-day
    event is midnight in the zone it was created in; when Graph returns it
    converted to the asked-for zone (the start is no longer `T00:00:00`), its date
    is the one the same instant has in `originalStartTimeZone` /
    `originalEndTimeZone` (both in `$select`; Windows zone names, mapped to IANA by
    the table in `outlook-time-zones.ts`, the CLDR primary mapping). A zone that
    is not in the table, or `tzone://Microsoft/Custom`, keeps the date Graph
    returned rather than guess. The row is midnight UTC of that date, like a
    Google all-day row. `meetingLink` (`onlineMeeting.joinUrl`, else
    `onlineMeetingUrl`) is kept only when it is an https URL without embedded
    credentials, and is normalised: it reaches the web `<a href>`, the Mac app's
    `NSWorkspace.open` and the model's prompt, so `javascript:`, `file:`, `http:`,
    custom schemes and malformed values become null. Only the account's default
    calendar is read (`/me/calendarView`, and getSchedule for the same mailbox);
    secondary and shared calendars are not. Every Graph fetch refuses redirects
    (`redirect: "error"`) so the bearer token cannot be forwarded. A listing that
    hits the page cap logs `truncated after 10 pages`. Free/busy:
    `POST /v1.0/me/calendar/getSchedule` for the account's own address over the
    window (https://learn.microsoft.com/graph/api/calendar-getschedule), where
    `busy`, `tentative`, `oof` and `unknown` block and `free` and
    `workingElsewhere` do not. That page lists delegated personal Microsoft
    accounts as not supported, so a 4xx that is not 401, 408 or 429, or a
    per-schedule error, falls back to the calendar view's `showAs`; a 401, a
    timeout, throttling or a 5xx rejects and is never hidden behind the fallback.
    The first time each distinct fallback answer is seen per process it is logged
    with the status and Graph's short code only (no body, no address). A busy
    item whose times cannot be read is treated as busy, never free: it blocks the
    whole window (a readable block beside it stays).
    `peopleFreeBusy` is the same call for other addresses, unreadable ones
    `blocks: null` (unknown, never free). `createEvent`, `updateEvent` and
    `deleteEvent` reject with `CalendarReadOnlyError`; nothing calls them on a
    linked session today.
  - Tokens (`outlook-token.ts`). Decrypt, refresh when under 5 minutes are left,
    persist Microsoft's rotated refresh token (an access-only refresh never
    overwrites a newer token), clear `needsReconnect` on a good refresh. What a
    refreshed pair is saved as is one pure function, `refreshedTokenUpdate`
    (`mail/outlook-token-update.ts`), used by both `mail/outlook-token.ts` and
    this module, so only the table and the reconnect marker differ; the rest of
    the lifecycle is a sibling of the mail one because that module is tied to
    `LinkedInboxAccount`. A rotten refresh cipher with a still-valid access token
    does not flag the account (the mail path's rule); it surfaces as a revoked
    grant once the access token runs out. The refresh is lazy (`connect` only
    decrypts) so a revoked grant rejects inside the caller's try/catch instead of
    escaping the dispatcher's loop and skipping every other account. A Graph 401
    gets one forced refresh and one retry with the new token before it reaches
    the failure policy (a token that looks fresh can be dead without the grant
    being revoked); a second 401, or a token that was itself just refreshed,
    propagates.
  - Revoked grant. The shared failure policy (`isRevokedGrantError`, renamed from
    `isRevokedGoogleGrantError` now that it serves both providers) also reads a
    Graph 401 (the `status` on the error) and a Microsoft `interaction_required`
    refresh answer as a revoked grant: the account is flagged `needsReconnect`,
    warned about once per hour, never sent to Sentry. Anything else (403, 429,
    5xx, `server_error`, `invalid_client`) is warned and captured with the domain
    only, and the account is left alone. The sync skips a flagged account;
    conflict checks still try it.
  - Sync. No change to the loop or the scheduler. `syncLinkedCalendarWindow` now
    writes the row's provider from the session that listed it, so OUTLOOK rows
    are `provider OUTLOOK`, `externalId` the Graph event id, `sourceAccountId` and
    `sourceKey` the account id, over the same 30 days and 100 events, with the
    same entitlement and `needsReconnect` handling. `calendar-rows.ts` has one
    `upsertLinkedEventRow(provider, ...)` for every linked provider in place of
    the Google-only one. The writers guard test lists the new writer of
    `LinkedCalendarAccount`.
  - Two providers are never merged. The dedupe key is (provider, externalId), so
    the same invite in Google and in Outlook stays two rows and two entries
    (tested at the dedupe, the row key and the sync, with mutations at each).
    Future key for C7: Graph's `iCalUId`, which is per occurrence in a series
    (https://learn.microsoft.com/graph/api/resources/event). It needs a column and
    a decision together with the Google `iCalUID`, and is not started here.
  - Unlink. `unlinkCalendarAccount(userId, id, provider)` takes the provider of
    the calling surface (GOOGLE by default, so the Google route is unchanged); the
    Outlook route passes OUTLOOK. Events and their AttentionItems go first, then
    the account, in one transaction, and neither route can remove the other's
    account by id.
  - Kill switch (after C7). OUTLOOK is registered in `CALENDAR_PROVIDER_ENABLED`
    (`pim/calendar-scope.ts`, the per-provider hook C7 added) as
    `outlookCalendarEnabled`, read at request time. OUTLOOK rows are visible
    only while OUTLOOK_CALENDAR_ENABLED and OUTLOOK_INBOX_ENABLED are both on,
    for every reader and by id, whatever `LINKED_CALENDAR_SYNC_ENABLED` says;
    turning either off hides them at once, the rows staying until their account
    is unlinked or deleted (Rollback). Google primary, Google linked and LOCAL
    rows are unaffected (tested through `calendarSourceScope()`,
    `isCalendarRowVisible()` and `list_events` with `UNIFIED_CALENDAR_READ_ENABLED`
    on). Side effects, both intended: while the flags are off every reader's
    `where` carries `provider: { notIn: ["OUTLOOK"] }` (the flag-off query tests
    assert the new shape; no OUTLOOK row exists then), and
    `anyLinkedRowVisible()` replaces the Google flag in `pim/calendar-read.ts`'s
    choice between a database cap/count and fetch-then-dedupe: with only the
    Outlook flags on, OUTLOOK rows are visible with the Google sync off, and two
    Outlook accounts can hold the same invite, so a cap must come after the
    dedupe (tested). Every C7 reader treats an OUTLOOK row as a linked Google row:
    read-only (`sourceAccountId` is set), text wrapped as untrusted, no title in a
    conflict; a guard test fails if a reader starts comparing a provider name.
  - Review fixes (round 2).
    - DST: `naiveLocalToUtc` read the zone's offset at the wall clock written as
      if it were UTC, which is an hour off in the hours either side of a DST
      transition (a Singapore holiday read in Los Angeles landed a day early after
      the fall-back). It now settles the offset over two passes (a third at a
      spring-forward gap) in one shared function, `wallClockToUtcMs` in
      `time-zone.ts`, which `localDayUtcRange` uses as well. Live paths whose
      behaviour changes, and only for a naive time on a transition day in a zone
      with DST: the Google sync's offset-less `dateTime`
      (`calendar-providers/google.ts` -> `mapGoogleEventTimes` ->
      `parseGoogleDateTime`; Google normally sends an offset, so this is rare), and
      `checkAttendeeBusy` and `checkConflicts` in `pim/calendar.ts` through
      `toAbsoluteInstant` (an agent's or draft's naive time in the user's zone).
      Asia/Seoul, the default, has no DST and is unaffected. Tested across
      spring-forward and fall-back in Los Angeles and Berlin, plus a quarter-hour
      sweep over Sydney and Lord Howe.
    - Attention items. `attention-mirror.ts` copies an event's title into a
      `CALENDAR_EVENT` item, and the briefing listed open PUSH items of every
      source, so the title outlived the kill switch (an Outlook flag turned off, or
      a linked Google event while the linked sync is off). Readers of such items
      now pass them through `withoutHiddenCalendarItems`
      (`pim/attention-calendar-visibility.ts`): one batch lookup scoped by
      `calendarSourceScope()`, and an item whose event is hidden or gone is
      dropped, as the inbox summary already did. The briefing reads four times as
      many items as it shows so the filter cannot starve the list. A guard test
      lists every module that reads AttentionItem and fails for an unclassified one.
    - Concurrent refresh. A rotation is a compare-and-swap on the refresh cipher
      that was read (`refreshedTokenUpdate(refreshed, previousCipher)`, shared with
      the mail path): the loser's write matches no row. The calendar source then
      re-reads the row and uses the winner's access token, and an `invalid_grant`
      re-reads the row before it can flag the account: a changed refresh cipher
      means the winner rotated first, so it uses the winner's token (one retry with
      its refresh token if that has run out), and only an unchanged cipher, or a
      refused retry, is a revoked grant. The mail path takes the swap with its own
      behaviour otherwise unchanged (a lost swap logs and syncs with the fresh
      token); both are tested.
    - Smaller. Meeting links are capped at 2048 characters, after normalising as
      well. Token-endpoint fetches (`mail/outlook-oauth.ts`) refuse redirects like
      the Graph ones; every caller already treats a rejected fetch as a failure
      (the link callbacks redirect to `failed`, the mail poll counts the account's
      error, the calendar sync captures it without flagging), tested at each. A
      failed token save logs the error's class, code and first line, not the raw
      database error. The reader guard now catches `case`, `.includes`, constants,
      template literals and lookups keyed by a provider, covers every consumer of
      `readCalendarRows`, and no longer exempts `tool-executor.ts`.
  - Known gaps, deliberate. (1) The legacy (userId, email) unique on `LinkedCalendarAccount`
    still exists, so an address that is already a linked calendar of another
    provider cannot also be linked as an Outlook calendar (an `outlook.com` or
    `gmail.com` address is unlikely, not impossible): the callback answers
    `linked=failed`, not an error. The contract phase drops
    `LinkedCalendarAccount_userId_email_key` (see C1); C4 does not. (2) The
    Outlook UI for linking belongs to C7's web and desktop work; the routes exist
    and are dark.
  - Rollback. If the flags were never on, revert the PR. If they were: set
    `OUTLOOK_CALENDAR_ENABLED` OFF, then `DELETE FROM "AttentionItem" WHERE
    "source" = 'CALENDAR_EVENT' AND "sourceId" IN (SELECT "id" FROM
    "CalendarEvent" WHERE "provider" = 'OUTLOOK')`, then `DELETE FROM
    "CalendarEvent" WHERE "provider" = 'OUTLOOK'`, then revert the code. The
    accounts can stay: nothing reads them while the flag is off.
  - Before the flip (real Microsoft 365 tenant; the code was only ever run
    against mocked Graph). Do it once with a work account and once with a
    personal outlook.com account. FA-9 first: add delegated `Calendars.Read` to
    the Azure app. (a) The consent screen lists Calendars.Read and no Mail.*; an
    org that blocks user consent ends in `linked=failed`. (b) `/me` names the
    account with the calendar set (`User.Read`). (c) One sync writes the expected
    rows; a cancelled occurrence of a recurring meeting is absent; an all-day
    event keeps its date when read in a zone west of UTC and in one east of it,
    from an account whose own zone is on the other side, and record whether Graph
    returns it at midnight or converted (the code handles both; the converted case
    needs `originalStartTimeZone` to be a name in the table). An event cancelled
    AFTER its first sync stays as a row: removal of upstream-cancelled events
    (C2b, in flight, Google only) must be extended to Outlook before the flip,
    or the calendar shows meetings that were cancelled. (d) `Prefer: outlook.timezone` accepts an
    IANA name and echoes it; a moved event keeps its id. (e) getSchedule on the
    work account returns the account's own busy time; record the exact status a
    personal account answers, because the fallback rule (any 4xx except 401, 408
    or 429) is a guess about it. (f) A refresh rotates the refresh token and the
    new cipher is stored. (g) Revoke the app at the account's consent page: the
    next sync flags `needsReconnect`, warns once, and Sentry stays quiet. (h)
    Unlink removes the rows and their attention items.
- Exit: flags OFF, no user-visible change. Nothing is flipped.
**C5 — mobile device bridge** (*outline*). Blocked on FA-8. Upload policy per
P4. Uploads through C6's `/api/device-calendar` API (below), unchanged: a mobile
client sends the same per-calendar snapshot with its own device-scoped key.
**C6 — desktop device bridge.** Depends on: C2. EventKit in KlornMac. Upload
policy per P4.
- Landed 2026-10-02 (branch `feat/device-calendar-mac`, PR not yet opened).
  Migration `20261007010000_linked_calendar_display_name` (the latest, after main's
  `20261006010000_proactive_draft`): two nullable columns on `LinkedCalendarAccount`,
  `displayName` TEXT and `deviceSnapshotAt` TIMESTAMP(3), no backfill
  (`CalendarProvider.DEVICE` came with C1, so no enum change).
  - Flag `DEVICE_CALENDAR_ENABLED` (OFF, lenient parse, read per request, in
    `.env.example`). Off: the three routes answer Fastify's default 404
    (`darkRouteGate`, byte-identical to an unregistered route, tested), no snapshot
    is stored, and every reader hides DEVICE rows already stored (registered in
    `CALENDAR_PROVIDER_ENABLED` as `deviceCalendarEnabled`; the flag-off `where` of
    every reader now carries `provider: { notIn: [..., "DEVICE"] }`). The prefix is
    `/api/device-calendar`, not `/api/calendar/device-sources`: main's
    `GET /api/calendar/:id` would answer that path with a 401, so a dark sub-route
    there would not look unregistered. Independent of `LINKED_CALENDAR_SYNC_ENABLED`;
    the dispatcher still answers DEVICE unsupported (the server fetches nothing).
  - API (C5 reuses it). `GET /sources` -> `{ sources: [{ key, title, uploadedAt }] }`.
    `PUT /sources/:key/window` with `{ windowStart, windowEnd, snapshotAt,
    calendarTitle, events: [{ externalId, title, start, end, allDay, location?,
    meetingLink?, status? }] }` -> `{ created, updated, removed, skipped, valveRefused }`
    (plus `stale: true`, all counts 0, for a snapshot older than the last applied);
    400 names the refused part and never echoes a value, 409 is a new calendar over
    the source cap (`code: "device_source_cap"`) or a snapshot over a row cap
    (`code: "device_row_cap"`, its own words), 413 a body over 2 MiB. `DELETE /sources/:key` -> `{ success: true }` or 404.
  - Opt-in (P4). A source is a `LinkedCalendarAccount` with provider DEVICE, `email`
    `device:<key>` (so the existing (userId, provider, email) unique is its upsert
    key and no address can collide under the legacy (userId, email) one) and
    `displayName` the calendar's title. The key is computed on the Mac: sha256 of the
    device id and the EventKit calendar identifier; the server accepts exactly 64
    lowercase hex characters, so a raw identifier is refused. The first PUT creates
    the source (at most 50 per user, new ones only); DELETE removes the source, its
    rows and their attention items through `unlinkCalendarAccount(..., "DEVICE")`.
    No other path creates a DEVICE row.
  - Boundary (`pim/device-calendar/device-snapshot.ts`, named constants). Window at
    most 62 days, starting no earlier than now - 9 days (the Mac's 7 plus two: see
    round 3) and ending no later than now + 93; times must carry Z or an offset;
    `snapshotAt` no later than now + 1 day and no earlier than now - 9 days. An event longer than 31 days (`DEVICE_EVENT_MAX_SPAN_DAYS`) is dropped and
    counted, so no row ends far past a window (a year-9999 end cannot be stored). At most 500 events; title and location 500
    code points, external id 512, calendar title 200, meeting link 2048, then
    `safeMeetingLink`. An all-day event is two dates (`YYYY-MM-DD`, end exclusive)
    stored at UTC midnight, as C4 and C7 store them; a timed one two instants stored
    as UTC. Cancelled events, events outside the window and a repeated external id
    are dropped and counted (`skipped`); a malformed time refuses the snapshot. NUL
    (which Postgres text cannot hold, so one invitation would fail every upload) is
    stripped from every string. No description field exists; unknown fields are
    dropped by the schema.
  - Reconcile (`device-ingest.ts`), one interactive transaction. The source upsert
    takes the source row's lock, so two snapshots of one calendar never interleave.
    Rows are matched by external id wherever they lie (an event moved into the
    window updates its row), created in one `createMany` (`createLinkedEventRows`,
    identity from `linkedEventSource`), updated only when a field changed. Rows of
    THAT source inside the window (the snapshot's overlap rule) that the snapshot
    lacks are removed and their open or snoozed attention items resolved, through
    C3's valve (`isOverDeletionValve`: more than half of the window's rows, when over
    5); a refusal keeps every row, still applies creates and updates, and warns and
    reports to Sentry once per source per process. Retention: rows of the source that
    ended more than 9 days ago (`DEVICE_ROW_RETENTION_DAYS`, the oldest a window may
    reach) are removed in the same transaction, outside the valve, so the server keeps
    no more of a device calendar than the device still shows.
  - Auth and limits. `requireAuth` (a live Device row for the bearer token) runs
    `onRequest`, before the body is read; every query is scoped to the token's user.
    Rate limits as hooks in a fixed order: 120 per 10 minutes per device session
    (sha256 of the bearer token) before authentication, 240 per 10 minutes per user
    after it (without a token the key is the Cloudflare or socket address, never
    `request.ip`). PUT is Pro-gated (`requireEntitled`, also before the body); GET and
    DELETE are not, so a downgraded user can always see and remove what was uploaded.
  - Readers. Every C7 reader keys on `sourceAccountId`, so a DEVICE row is read-only,
    wrapped as untrusted on LLM paths and title-free in a conflict
    (`calendar-device-read.test.ts`). `sourceLabel` on a DEVICE row is the calendar's
    title, never the `device:` key (`calendar-source-label.ts`).
  - Mac (`DeviceCalendarBridge.swift`, `DeviceCalendarSnapshot.swift`,
    `DeviceCalendarSection.swift`). Preferences shows a "Device calendars" section
    only when `GET /sources` answers 200 (re-asked each time Preferences opens; the
    default 404 hides it; any other failure is asked again every 5 minutes). The master switch "Upload device calendars" is the only
    place that asks macOS (`requestFullAccessToEvents`, macOS 14); nothing touches
    EventKit before it. Denied or restricted: a short explanation and a button to
    System Settings › Privacy & Security › Calendars. Granted: every EventKit calendar
    with its own switch, all off. A calendar is uploaded when switched on, on
    `EKEventStoreChanged` (5 s debounce), at launch and every 15 minutes; an unchanged
    snapshot is skipped for up to 6 hours. One pass at a time. Window: start of today
    - 7 days to + 31 days; EventKit is asked one day wider on each side and the
    builder keeps what overlaps the window as the server reads it (east of UTC the
    all-day day before the local window overlaps it in UTC). Recurrence: EventKit
    expands occurrences in `predicateForEvents`; a recurring or detached occurrence is
    keyed by its identity plus `occurrenceDate`, so a moved occurrence keeps its id.
    External ids are sha256 of `calendarItemExternalIdentifier` (else
    `calendarItemIdentifier`); notes and attendees never leave the Mac. Declined
    events are skipped: EventKit exposes `EKParticipant.isCurrentUser` and
    `participantStatus`. Over 500 events, the earliest are kept and the window ends at
    the first one left out, so the snapshot stays complete. Switching a calendar off
    sends DELETE, queued behind any upload in flight so a late PUT cannot recreate it
    (passes run in tasks of their own, never cancelled mid-request); a removal that
    fails (offline, or a 404 while `GET /sources` does not answer 200) is kept and
    retried at every launch and pass, even with uploading off, so the rows cannot come
    back with the flag. A calendar that leaves the Mac pauses (round 2, below).
    Signing out ends the opt-in on that Mac (another account must opt in itself) and
    owes a DELETE per source switched on, sent with the session token read before the
    Keychain is cleared and kept for that user until it succeeds. Dates use the
    autoupdating calendar and zone, so a Mac that travels reads all-day dates in its
    new zone. Device id: the hardware UUID, else a random one kept in the defaults.
    Info.plist gains `NSCalendarsFullAccessUsageDescription` and
    `NSCalendarsUsageDescription`, localised in 7 `InfoPlist.strings` copied into the
    main bundle by `make-app.sh`; `Klorn.entitlements` grants the hardened runtime
    `com.apple.security.personal-information.calendars`, and the Developer ID signing
    step in `desktop-release.yml` now passes it (without it a notarized build is
    refused calendar access). 10 strings in all 7 `.lproj` catalogues (`%d` for the
    count).
  - Tests. API: snapshot boundary, ingest against a fake table that applies the
    `where` keys, sources, routes (dark 404 byte-identical, auth, 400/409/413, unknown
    fields dropped, both rate limits), DEVICE through the read path, label, migration,
    and the guards (writers, readers, provider-name branching, kill-switch
    exemptions). Mutations, each killed: DELETE keeping the rows, removal widened past
    DEVICE, candidates or deletion not scoped to the source, valve removed, dark gate
    removed, DEVICE not registered, `safeMeetingLink` bypassed, candidates not scoped
    to the user (survived the first run; a test was added), cap counting other users,
    the route ignoring the token's user; after the review, the Pro gate moved after the
    body, NUL kept, expired rows kept, the limiter keyed on `request.ip`. Mac self-check: window and query range, key
    and id hashing, all-day in Seoul and Los Angeles, UTC instants, recurrence and a
    moved occurrence, declined/cancelled/repeated, the 500 cut, clamping, links, the
    wire's fields, access states, the 404 rule, defaults all off, sign-out reset, the
    one access call site, the usage strings in 7 languages and the entitlement.
    Mutations, each killed: switches default on, access asked at launch, all-day end
    not walked back, occurrence ignored, declined sent, no device id in the key,
    unsafe link, the 404 rule, the window not cut. Review (code and security, 2026-10-02): no
    critical finding; fixed: removals owed while uploading is off or at sign-out, a
    failed probe never retried, a switch-off racing an upload in flight, a returning
    calendar removed by a stale removal, the zone going stale after travel, a
    duplicate calendar id trapping, the Pro gate after the body, NUL, the limiter's
    address, retention. Not fixed: (9) below.
  - Known limits. (1) Not run on a real Mac against real calendars: the permission
    prompt (and the entitlement in a notarized build), EventKit's all-day `endDate`
    and `occurrenceDate` conventions, the stability of
    `calendarItemExternalIdentifier`, and the System Settings link are unverified.
    (2) A source whose Mac stops uploading (app deleted, Mac wiped, left offline)
    keeps its rows until the hourly expiry removes it 14 days after its last snapshot;
    there is no web control, and until then it counts toward the 50-source cap. (3) The same calendar on two
    Macs is two sources; their rows collapse at read time only when their hashed ids
    match. A calendar that is also linked as ICLOUD or GOOGLE shows twice
    (cross-provider dedupe is C7's open decision). (4) Meeting links come from the
    event's URL field or a location that is a URL; links inside notes are not
    extracted. (5) The valve also refuses a real mass deletion (more than half of the
    window, over 5 rows); those rows stay until they leave the window. (6) Rows store
    no transparency (C7's limit (2)); a declined invitation is skipped only when
    EventKit marks the user's participant as the current user. (7) An older
    snapshot that arrives after a newer one wins until the next upload (the Mac sends
    one at a time; the 15-minute pass repairs it). (8) Every ingest test mocks Prisma:
    `createMany` with `skipDuplicates`, the upsert's row lock and the query cost were
    not run against Postgres, and neither were the row-cap counts nor the expiry
    query. (9) Review, not fixed: a snapshot changing all 500 events runs 500
    sequential `updateMany` in one transaction (bounded by the rate limits; a single
    `UPDATE ... FROM unnest(...)` needs a real-Postgres check first); the 50-source cap
    is checked outside the transaction, so concurrent first uploads can pass it once;
    the source key has no per-account salt, so two accounts on one Mac share keys
    (visible only to an operator); a source the expiry reads as stale and a snapshot
    refreshes in the same instant is removed and re-created on the Mac's next pass. (10) The Mac change reaches users only with a desktop
    release; until then nothing uploads, and the section stays hidden while the flag
    is off.
  - Before the flip (founder). (a) Apply the migration (additive; nothing to
    preflight). (b) Ship a desktop release containing C6, signed with
    `Klorn.entitlements`, and on a real Mac: turning the switch on shows one macOS
    prompt with the localised text; denying shows the explanation and the button opens
    the Calendars pane; granting lists the calendars, all off; switching one on puts its
    events in `/api/calendar` with `readOnly` and the calendar title as `sourceLabel`;
    an edit or deletion on the Mac reaches the server within the debounce; a recurring
    series with one moved and one deleted occurrence, and an all-day event read with
    the Mac set to a zone west and one east of UTC, come out right; switching the
    calendar off removes its rows, the master switch removes all; a declined
    invitation is absent. (c) Then turn `DEVICE_CALENDAR_ENABLED` on. LLM paths
    (`list_events`, conflicts) see the rows only with `UNIFIED_CALENDAR_READ_ENABLED`
    too (C7's own flip).
  - Rollback. Flag never on: revert. Ever on: set the flag OFF (rows hidden at once),
    `DELETE FROM "AttentionItem" WHERE "source" = 'CALENDAR_EVENT' AND "sourceId" IN
    (SELECT "id" FROM "CalendarEvent" WHERE "provider" = 'DEVICE')`, `DELETE FROM
    "CalendarEvent" WHERE "provider" = 'DEVICE'`, `DELETE FROM "LinkedCalendarAccount"
    WHERE "provider" = 'DEVICE'`, then revert. The columns are additive: drop them
    only after.
  - Review round 2 (2026-10-02), each test-first. Server: row caps, 1 000 per source
    (`DEVICE_MAX_ROWS_PER_SOURCE`) and 10 000 per user (`DEVICE_MAX_ROWS_PER_USER`),
    counted after the writes inside the transaction; over either, the snapshot is
    refused with 409 and rolled back whole (a flood of 1 ms windows stops at the cap,
    tested). A stale snapshot (older `snapshotAt` than the source's `deviceSnapshotAt`)
    is ignored the same way; the source upsert takes the row lock first, so the check
    sees the newest applied one. Retention and the window are one span: the Mac sends
    7 days back from local midnight, the server accepts a window and keeps rows 9 days
    back (7 plus two, round 3), so an event deleted on the Mac lingers at most two
    days past its window. Hourly, while the flag is on, the scheduler removes every DEVICE source
    no snapshot refreshed for 14 days (`DEVICE_SOURCE_EXPIRY_DAYS`, 200 per sweep),
    through the same unlink; a running Mac re-sends an unchanged calendar every 6
    hours, so a live source never expires. Mac: EventKit reads, the snapshot build
    and its JSON encoding run on an actor (`DeviceCalendarReader`), off the main
    thread; the bridge keeps UI state only. Every network job (upload pass, removal,
    launch reconcile, sign-out removal) runs through one serial queue, so a DELETE is
    never overtaken by a PUT that recreates the source. A calendar missing from the
    Mac pauses; only a switch-off deletes, and the server's expiry covers one that
    never returns. At launch the Mac compares `GET /sources` with the sources IT
    uploaded for the signed-in user (kept per user in the defaults; another Mac's
    sources are never touched) and deletes those no longer switched on. Owed removals
    are kept per user across sign-out until a DELETE succeeds and retried at that
    user's next sign-in here. An all-day recurring occurrence is keyed by its floating
    date, so a time-zone change keeps its id; the refresh loop holds the bridge weakly
    and ends with it; the content digest is encoded with sorted keys (JSONEncoder's
    key order is not stable, which would have re-sent unchanged calendars). Self-check
    cases for a 25-hour day (Los Angeles, 2026-11-01) and a 23-hour day (2027-03-14),
    timed and all-day. The self-check now drives the real bridge against a fake store
    and a stubbed URLSession (its runner keeps the main run loop turning instead of
    blocking on a semaphore). `make-app.sh` no longer sets `CFBundleLocalizations` or
    `CFBundleDevelopmentRegion`: the `.lproj` folders alone carry the usage string
    (CFBundle lists all 7 localisations from them on the built bundle; the prompt in
    each language on a real Mac is unverified). Mutations, each killed: row-cap check
    removed, user cap ignored, span unbounded, stale check removed, snapshot time not
    recorded, snapshot time unbounded, expiry without unlink, expiry without the
    provider filter, expiry ungated; on the Mac: absence deleting, sign-out owing
    nothing, a failed removal dropped, the launch reconcile skipped, the sign-out
    removal not queued, the reconcile touching another Mac's sources.
  - Review round 3 (2026-10-03), test-first. (1) An upload that succeeds no longer
    clears an owed removal (`uploadedSource`): a calendar switched off while its PUT
    was in flight lost its DELETE until the next launch or the expiry. Only a
    confirmed DELETE or switching the calendar back on clears one (scenario: a 400 ms
    PUT, switched off meanwhile, DELETE sent after it). (2) The lag had no margin: at
    23:59 on a 25-hour fall-back day the Mac's window starts 8 days and 59 minutes
    back, over a limit of exactly 8 x 24 h, so the last hour of each day answered 400
    for about 8 days. `DEVICE_WINDOW_MAX_LAG_DAYS` is now the Mac's 7 days plus 2 (the
    local-midnight day, that hour, a slow clock), and the retention follows it
    (tested at the fall-back boundary and one millisecond past the limit). (3) The
    expiry sweep handles each source in its own try/catch (one failure is reported
    and left for the next sweep); its comment no longer claims an index (none serves
    the read; the table holds one row per linked calendar). The two 409s carry
    machine codes and the row cap its own words; the Mac reads the code from the PUT
    reply and shows `deviceCalendars.error.rows` (7 languages) for it. A `stale: true`
    reply is not recorded as a send: nothing is remembered, and the next pass reads
    the calendar again and retries.
- Exit: flag OFF; no user-visible change on the server, and the Mac section stays
  hidden until the flag is on. Nothing is flipped.
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
    `CALENDAR_PROVIDER_ENABLED`, exported from `pim/calendar-scope.ts`; C4
    registered OUTLOOK in it). A connector registers its flag with one entry (C4: `OUTLOOK:
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

#### Security follow-ups

- Meeting links (done, 2026-09-30): the web and Mac clients open a `meetingLink` only when it is an https URL with no userinfo (#1348). The server applies the same rule before a link is stored or handed on: C4's Outlook normaliser is now the shared `safeMeetingLink` in `pim/meeting-link.ts` (absolute https, no userinfo, normalised, at most 2048 characters, else null), used by Outlook unchanged, by Google's conferenceData `uri` / `hangoutLink` (`googleMeetingLinkOf`, so sync rows, linked accounts and every `listEvents` read), by `getUpcomingMeetings` including its description/location regex, and by `POST /api/calendar`. An unsafe first candidate falls back to the next safe one. `joinMeeting`'s host allowlist is unchanged and still applies on top. Rows already stored with an unsafe link are rewritten by the next sync inside its 30-day window; LOCAL rows created earlier through the route are not rewritten.

### Workstream D — drive

**D1 — object storage foundation** (*outline*). Depends on: FA-7. S3-compatible
client, per-user key prefix, size caps, signed downloads. It may start early:
E4 needs it before workstream D's turn comes.
**D2 — drive model and provider seam.** Depends on: nothing. A metadata index
of files across sources: one table, one writer, one read path, a provider seam
with no connector behind it yet, and two read-only routes.
- Landed 2026-10-03, flag OFF (branch `feat/drive-model`, PR not yet opened).
  Flag: `DRIVE_ENABLED`, default OFF, read at request time. While off, both
  routes answer Fastify's default 404 before authentication (`darkRouteGate`)
  and every reader hides every row. Nothing writes a row in D2, so with the flag
  on the list is still empty.
- Model. Migration `20261008010000_drive_file` (after
  `20261007010000_linked_calendar_display_name`), additive only: one enum, one
  table, `SET LOCAL lock_timeout = '5s'`. Its SQL is pinned by
  `drive-file-migration.test.ts`.
  - Enum `DriveProvider`: KLORN (D3), GOOGLE (D5), ONEDRIVE (D6), DEVICE (D7).
    Only the sources the D steps name.
  - Table `DriveFile`, metadata only: `userId`, `provider`, `sourceKey`,
    `externalId`, `name`, `mimeType`, `isFolder`, `sizeBytes`,
    `parentExternalId`, `modifiedAt`, `webUrl`, `storageKey`, `readOnly`,
    `trashed`, `summaryStatus`, timestamps. No content column and no summary
    text. The test pins the column list, so a content column cannot be added
    without changing it.
  - Identity: unique (userId, provider, sourceKey, externalId). `sourceKey` is
    `'klorn'` for the user's Klorn drive, the connector's account id for GOOGLE
    and ONEDRIVE, and the device source key for DEVICE. `provider` and
    `sourceKey` have no default: the table is new, so no previous release
    writes it and the compiler makes every writer state both. `externalId` is
    required (a Klorn file gets the id D3 mints), so every row is addressable
    and a parent id always has something to name. The Prisma name of the unique
    is `driveFileIdentity`, because the generated name is the one
    `CalendarEvent` already has and the calendar guard greps for it.
  - Index (userId, modifiedAt, id) for the list and the search: both read one
    user's rows newest first, keyset-paged on (modifiedAt, id). On a scratch
    Postgres 16 with sequential scans disabled the list plan is an
    `Index Scan Backward` on it.
  - Two CHECK constraints Prisma cannot declare: `webUrl` is NULL or starts
    with `https://`; `storageKey` is NULL unless the provider is KLORN or
    DEVICE. The drift check does not see them; the migration test pins them.
  - `sizeBytes` is BIGINT (a drive file passes 2 GiB). `JSON.stringify` refuses
    a BigInt, so no route returns a raw row: the read path selects its columns
    and maps the size to a number.
  - `summaryStatus` is a string, default `'NONE'`, like
    `EmailAttachment.analysisStatus`: D4 reuses that pipeline and owns the
    vocabulary. D2 never writes or returns it.
  - Rows cascade on user delete (foreign key, verified on Postgres), and
    `purgeUserData` deletes them explicitly, since it keeps the user row.
- Decisions.
  - Accounts: no account table in D2, and no reuse of `LinkedInboxAccount`,
    `LinkedCalendarAccount` or `UserToken`. Those rows carry a mail or calendar
    grant; a Drive grant is a different scope on the same identity (P5), and
    unlinking a drive must not unlink an inbox. Their enums are per service, and
    `UserToken`'s unique (userId, provider) is what the primary mail path rests
    on. A `LinkedDriveAccount` table is the right shape, but with no connector
    it would be a credential store with no writer, no reader and no test, and
    its columns depend on D5's grant flow, which V2 still blocks. So D5 or D6,
    whichever lands first, adds `LinkedDriveAccount` together with a nullable
    `sourceAccountId` foreign key on `DriveFile` (ON DELETE CASCADE), as C2 did
    for `CalendarEvent`, and the key-rotation sweep in the same PR. `sourceKey`
    already holds that account's id, so no row is rewritten. This puts D5 and D6
    on the shared-files row for `schema.prisma` (below).
  - Parent, not path: `parentExternalId`, NULL at a source's root. Google Drive
    and Graph both report a parent id and neither reports a stable path; a
    folder rename would rewrite the path of every descendant; a name may
    contain `/`; and a path is many attacker-written names joined into one
    unbounded string. A folder is a row with `isFolder` true.
  - Search: ILIKE through Prisma's `contains`, inside one user's rows, on the
    name only. No pg_trgm: it needs an extension created in the migration,
    whether its index helps a Korean name depends on the database's locale
    (not measured), and one user's index is small. A trigram index can be added
    later with no API change. The text is composed (NFC, as names are stored, so
    a name typed on a Mac and a search for it meet), capped at 100 characters,
    and `%`, `_` and `\` are escaped, because Prisma sends `contains`
    unescaped.
- One writer: `drive/drive-rows.ts` (`klornDriveSource`, `connectedDriveSource`,
  `driveRowData`, `upsertDriveFileRow`). The provider names live in
  `drive/drive-providers.ts`, which imports nothing. It cleans what a source reported
  before a row exists: the name loses control characters and bidi overrides, is
  composed and capped at 500 characters; the link is kept only if it passes
  `safeMeetingLink` (https, no credentials, at most 2048 characters) and never
  for a Klorn-held file; the media type must be well formed; the size a whole
  non-negative number. An external row is always `readOnly` (V4) and a storage
  key on one is refused. An update never rewrites the identity, leaves a
  storage key the caller did not name alone, and never touches `summaryStatus`.
  A row that cannot be stored is refused with the part at fault, never written
  half-cleaned. Nothing calls it yet.
- Seam: `drive/providers/types.ts`, `dispatch.ts`, `unsupported.ts`, the shape
  of `pim/calendar-providers`. `DriveProviderActions.connect(source)` answers a
  `DriveProviderSession`, `null` (not connected) or `{ unsupported: true }`. A
  session has exactly `list`, `search`, `getMetadata` and `fetchForSummary`
  (V4: no upload or edit; a test fails if a fifth method or a write appears).
  `fetchForSummary` takes `maxBytes` and answers content, `too-large` or
  `unavailable`. The dispatcher enforces the cap on every session it hands out:
  the request is clamped to `DRIVE_SUMMARY_MAX_BYTES` (8,000,000, what the
  attachment pipeline reads) and content longer than asked for is answered
  `too-large`. Every provider is the unsupported stub in D2. A connector plugs
  in with two entries: its flag in `DRIVE_PROVIDER_ENABLED` and its actions in
  the dispatcher's table; it is served only while `DRIVE_ENABLED` and its own
  flag are both on.
- Kill switch: `drive/drive-scope.ts`. `driveSourceScope()` is the `where`
  fragment of every list and search, `isDriveRowVisible()` the check on a row
  fetched by id. A row is visible only while `DRIVE_ENABLED` is on and its
  provider's flag in `DRIVE_PROVIDER_ENABLED` answers exactly `true`. Unlike
  the calendar's switch it fails closed: it lists the providers known to be on,
  so a provider nobody registered is hidden. The registry ships empty.
- Read path: `drive/drive-read.ts` (`listFiles`, `searchFiles`, `getFile`).
  Every query names the user, composes the scope inside an `AND` (so a caller's
  own provider filter cannot replace it), skips trashed rows, orders by
  (modifiedAt, id) descending, and pages by keyset with a default of 50 and a
  ceiling of 100 whatever is asked. The cursor is opaque and validated; a
  forged one can only start elsewhere in the caller's own rows.
- API, read-only (`routes/drive.ts`, types in `packages/contract/src/drive.ts`):
  `GET /api/drive/files` (`q`, `provider`, `sourceKey`, `limit`, `cursor`) and
  `GET /api/drive/files/:id`. Session-authenticated, 30 and 60 requests a
  minute. An unknown id, another user's, a trashed file and a file of a
  disabled provider are one 404. No storage key crosses the wire. There is no
  upload, download or delete route: those are D3.
- Guards: `drive-file-guard.test.ts`. One writer; reads only in the read module
  and the export; every list has the scope inside its `AND` and every by-id
  read the visibility check; every read names the user and selects its
  columns; no raw SQL names the table.
- Untrusted text. A file name is written by whoever shared the file. No module
  that holds drive rows imports the LLM today, and the guard fails for a new
  one until it is listed: as not LLM-facing, or as LLM-facing with the pattern
  that shows the name inside `wrapUntrusted`. D4 adds the first such entry.
- Export: `GET /api/user/me/export` now carries `driveFiles`, every row the
  user has (trashed and disabled-provider rows included, as calendar events
  are), without the storage key.
- What plugs in.
  - D3 writes KLORN rows through `upsertDriveFileRow` with D1's object key as
    `storageKey`, registers KLORN in `DRIVE_PROVIDER_ENABLED`, and adds the
    upload, download and delete routes. It must delete a file's object before
    its row, in `purgeUserData` too. Folder browsing (children of a folder, a
    source's root) is D3's: it adds that query and its index (userId, provider,
    sourceKey, parentExternalId).
  - D4 owns `summaryStatus`, calls `fetchForSummary` through the dispatcher,
    stores its summary in a table of its own (not in `DriveFile`), and is the
    first module the guard lists as LLM-facing.
  - D5 and D6 implement `DriveProviderActions`, add `LinkedDriveAccount`, sync
    metadata through `upsertDriveFileRow`, and register a flag each. Unlinking
    deletes the account's rows.
  - D7 decides whether an imported file is a KLORN row or a DEVICE row. Both
    may carry a storage key; DEVICE needs its own flag.
- Known limits.
  - No connector, so no row and no data in the list.
  - Name search only. A search reads one user's rows; that is bounded by the
    rate limit and the page ceiling, not by an index.
  - No row cap per source and no bound on the export: a connector sets its own
    cap, as the device calendar did.
  - `DriveFile` has no row-level-security policy, like every table created
    since `20260806033517` (`../rls-rollout.md`).
  - No user-facing noun and no copy in D2, so no vocabulary row. The first step
    with UI adds it.
- Verify: 203 tests in seven files (migration, rows, scope, dispatch, read,
  routes, guard), plus the `LIKE` cases added to `fake-db.test.ts`. The fake
  database's `contains` now follows Postgres `LIKE`, escapes included.
  Full API suite green (546 files, 7705 tests, on main at `43467202`).
  Mutation checks: 26 single-line changes to the drive modules (user scoping,
  the kill switch, the page ceiling and tie-break, the search escape and cap,
  the flag-off gate and its order, the writer's link, read-only and storage-key
  rules, the summary cap, the rate limit), each failing at least one test.
  On a scratch Postgres 16 (not in the suite): `prisma migrate deploy`, the CI
  drift check ("No difference detected"), both CHECKs refusing a row, the
  upsert's conflict target, the list order and paging across a five-row tie,
  the search with `%`, `_`, `\` and a decomposed Korean query, an empty
  provider list as valid SQL, a 5 GB size as a JSON number, and the cascade on
  user delete.
- Rollback: revert the PR. The table and the enum can stay; nothing reads them.
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
| `packages/api/prisma/schema.prisma` | A1, A2a, A2b, B2, C1, D2, D5, D6, E1, F |
| `drive/drive-scope.ts`, `drive/drive-rows.ts`, `drive/providers/dispatch.ts`, `routes/drive.ts` | D3, D5, D6, D7 |
| `packages/api/src/mcp/tool-gate.ts`, `mcp/write-call.ts`, `mcp/server.ts` | A2a, A2b, A4 |
| `mail/providers/types.ts`, `dispatch.ts` | A4, B0, B0b, B1, B2, B3, E2 |
| `mail/imap-connection.ts`, `mail/imap-sync.ts`, `mail/providers/imap.ts` | B1, B2, B3 |
| `mail/providers/outlook.ts`, `routes/email-replies.ts` | B0b, the `gmail-draft` follow-up under B0 |
| `mail/reply-headers.ts` | B0, B3 |
| `pim/calendar.ts`, `pim/calendar-read.ts`, `routes/calendar.ts` | C3, C4, C5, C6, C7 |
| `pim/calendar-sync.ts`, `pim/calendar-scope.ts`, `pim/calendar-rows.ts`, `pim/calendar-providers/types.ts`, `dispatch.ts` | C2, C3, C4, C5, C6, C7 |
| `pim/device-calendar/*`, `routes/device-calendar.ts` | C5, C6 |
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
| FA-9 | Azure app registration (existing action B). That action lists `Mail.*` permissions only; calendar and file permissions must be added for C4 and D6. For C4: add delegated `Calendars.Read` (and `User.Read` if it is not already listed); the calendar link requests exactly `openid email offline_access User.Read Calendars.Read`, reuses the existing redirect URI, and asks for no `Mail.*`. Existing inbox links keep their consent unchanged | B5, C4, D6 |

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
