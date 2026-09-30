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
| Microsoft | merged, flag OFF, Azure registration pending; replies and drafts are unthreaded by design (`getReplyHeaders` returns `{}`; native reply is B0b) | none (Graph scopes are `Mail.*` only) | none |
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
- **Landed 2026-09-30** (branch `feat/mcp-set-tier`, not yet merged):
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
an explicit unsupported result. Outlook returns unsupported until B0b lands,
because a draft made through Graph `POST /me/messages` does not thread.
- The tool never accepts header strings from the caller. It takes an email id,
  and the server resolves the reply headers through `getReplyHeaders`.
- Rule: if any send path ever carries agent-supplied reply context, the
  resolved in-reply-to email id and the thread id join the receipt payload
  hash, and `RECEIPT_SCHEMA_VERSION` (`judge/attention-floor.ts`) is bumped.
- **Landed 2026-09-30** (branch `feat/mcp-create-draft`, not yet merged):
  - **`create_draft(email_id, body, subject?)`** (`mcp/create-draft.ts`,
    `mcp/reply-target.ts`). MCP-only: not in `ALL_TOOLS`, `CHAT_TOOL_NAMES` or the
    risk table. It is the third member of the write set (`mark_read`,
    `set_tier`, `create_draft`), so the A2a gate, audit row and per-user cap apply
    unchanged; its success predicate is `success === true`, and the audit
    `targetId` is the email id. Result: `{success: true, draft_id, provider, to}`;
    a provider's own `{unsupported}` or `{error}` is returned unchanged; Klorn's
    refusals are `{error, code}` with `INVALID_ARGUMENT`, `NOT_FOUND`,
    `NO_REPLY_ADDRESS` or `UNAVAILABLE`. A hard failure is captured and answered
    generically, and does not claim that no draft exists.
  - **Plan gate: `email_write`** (`TOOL_FEATURE_MAP` in `billing/stripe.ts`), not
    `email_read`. The human draft route (`POST /api/email/:id/gmail-draft`) is
    Pro-only compose, so an agent key must not draft on a plan whose owner
    cannot. FREE keys see `mark_read` and `set_tier` but not `create_draft`. This
    is a choice the brief did not spell out; say so if FREE should draft.
  - **The arguments are closed.** Anything outside `email_id`, `body`, `subject`
    is refused with `INVALID_ARGUMENT` (no echo of the input): `to`, `cc`,
    `bcc`, `in_reply_to`, `references`, `thread_id`, `html`, `attachments`. The
    schema says `additionalProperties: false` for clients that read it.
  - **Resolution.** `email_id` (Klorn id or provider id) resolves the caller's
    own row (`userId` in the lookup), the row's `linkedInboxAccountId` goes to
    `mailActionsFor`, `getReplyHeaders` and `createDraft` (`null` only for a
    primary-inbox row), and the provider comes from the dispatcher. OUTLOOK
    answers `{unsupported: true}` before any provider call. The reply headers are
    `getReplyHeaders` of the original: In-Reply-To is its Message-ID, References
    is its chain plus that id (the `/reply` route's shape), and with `{}` the
    draft carries no `reply` and threads by thread id alone.
  - **Recipient.** One bare address, parsed in one linear pass with no
    backtracking regex on the raw header: display names dropped, quoted names may
    hold commas, and a second address, group, comment, control character, non-ASCII
    address or header over 998 characters is refused. The Reply-To branch is
    implemented and tested (single valid Reply-To wins, several or invalid falls
    back to From) **but no provider returns Reply-To yet**: `EmailMessage` has no
    such column and `ReplyHeadersResult` is `{messageId, references}`. Today the
    recipient is always From. Making it live is two lines once B3 has merged
    (`replyTo?` on `ReplyHeadersResult`, `"Reply-To"` in the Gmail
    `metadataHeaders`), which this step did not touch because B3 edits both files.
    `createEmailDraft` still refuses a no-reply sender, and that error passes
    through.
  - **Subject and body.** Subject: the agent's, checked (1 to 300 characters, no
    control character or line break, tested before trimming so a trailing newline
    is an error), else `Re: <original>` flattened to one line and capped, with no
    second `Re:` in any case. Body: plain text, 1 to 20,000 characters, no NUL, sent
    as `text/plain` and never interpreted (there is no html argument). Both
    limits are proposed values. A localised reply prefix in the original
    (for example `AW:`) is not recognised, so it gets a `Re:` in front.
  - **Never sends.** No send call exists in the module (the test reads the
    source), and every test in the file asserts a `sendEmail` spy stayed
    uncalled. No local state is written: no reply chip, no `repliedAt`, no
    candidate-intake status, because nothing was sent.
  - **Verify result.** Flag x permission x plan for list and call; foreign id;
    Outlook; unsupported and soft-error passthrough; the row's account at every
    step; headers from the provider and never from input; the Reply-To and From
    cases; subject and body limits; audit row, cap sharing and a failed insert;
    flag off byte-identical to `legacyMcpToolDefs`. The implementer (not CI) ran
    ten mutations on 2026-09-30 and each failed at least one test before it was
    restored: `to` flowing from the validated input at the call site, `to`
    accepted from the arguments, From preferred over Reply-To, the row's account
    replaced by the primary, Outlook no longer refused, reply headers taken from
    the arguments, a send call added, the plan entry removed, the line-break
    check moved after trimming, and the `userId` scope dropped from the lookup.
  - **Not covered.** No live Gmail call: the provider seam is a spy, so the MIME
    that `createEmailDraft` builds from `to`, `subject` and `reply` is checked
    only by its own existing tests. A5's write-tool page is still to do.

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

**B0b — Microsoft native reply** (*outline*). Depends on: B0. Outlook replies
use Graph `/messages/{id}/reply` and reply drafts use `/messages/{id}/createReply`,
because `sendMail` cannot set In-Reply-To. `getReplyHeaders` stays `{}`, so the
reply route never reports `threaded: true` for an Outlook send. The flag stays
OFF. The seam needs a way to name the message being answered; the PR that
starts this step designs it and expands this brief.

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

**B2 — IMAP move actions.** Depends on: B1. Archive, trash and their
inverses. A MOVE assigns a new UID, so the row must store where the message
went; that is a schema change. Trash is a MOVE to the Trash folder. It is
never `\Deleted` plus EXPUNGE, which is `delete_permanent` and sits on the
floor.

**B3 — SMTP send for IMAP providers.** Depends on: B0. SMTP client, a
per-provider SMTP host pinned like `hostMatchesProvider`, draft support. The
send path stays behind the deterministic floor. Security review is mandatory.
Reply headers reuse `mail/reply-headers.ts`.

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
    (`getLinkedCalendarClients`, the linked-calendars list), so a later CalDAV
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

**C2 — calendar provider seam and linked-account sync** (*outline*). Mirrors
`mail/providers/`. Linked Google calendars are synced into rows, not only
consulted for conflicts. Two gates from the C1 database review (2026-09-30),
both settled before C2 writes a linked row:
- Dedupe semantics. The unique (userId, provider, externalId) does not include
  `sourceAccountId`, so an invite present in both the primary and a linked
  Google calendar collides. Decide between a sentinel `sourceAccountId` for
  primary rows and a `COALESCE(sourceAccountId, ...)` expression unique index
  (raw SQL; confirm the CI drift check accepts it before choosing).
- Unlinking. `DELETE /google/linked-calendars/:id` (`routes/auth.ts`, around
  `:1590`) must delete that account's events in the same `$transaction` (or
  the column becomes a foreign key with `ON DELETE CASCADE`), because
  `/api/calendar` has no source filter and orphaned events would keep showing.
  Add an index on (userId, sourceAccountId) when that query first exists.

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
A1 → A2a → A2b        A2a → A3        A2a + B0 → A4        A2a + A2b + A4 + A5 → A8
MCP_WRITE_TOOLS_ENABLED flips only after A2b and A3 have both merged
A5 (read-only part), A6 independent
B0 → B3                 B0 → B0b                B1 → B2
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
