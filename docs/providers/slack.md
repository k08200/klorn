# Slack integration v1 (internal app, read-and-judge only)

Status: built dark behind `SLACK_ENABLED` (`off` | `cohort` | `on`, default
`off`). Roadmap decision 2026-11-12: Slack comes in as an **internal,
customer-built Slack app**, self-host and per-company first. The roadmap
context is `docs/strategy/2026-10-15-founder-roadmap.md` L35, L62-63, L136
(Slack listed as a gap and as priority 6). `docs/providers/unified-platform-plan.md`
has no Slack section; its flip order (founder account → cohort → everyone,
decision L23) applies here too.

## 1. What v1 does, in one paragraph

A Slack admin (or the user) creates a Slack app in their own workspace from
the manifest Klorn ships, installs it, and pastes two values into Klorn:
the app's **signing secret** and the installing user's **user token**
(`xoxp-…`). Klorn checks the token once with `auth.test` and stores only the
signing secret (encrypted) — never the token. Slack then sends Klorn an Events API request for every message the
user can see in DMs, group DMs and channels. Klorn verifies each request's
signature, keeps only what matters to that user (DMs, group DMs, @mentions of
the user, and channels the user opted in), groups the kept messages into short
**conversation episodes**, judges each episode into one of the 5 lanes with
the existing judge, rings PUSH episodes through the existing push pipeline
with a link back to Slack, and runs the existing commitment extractor on the
episode text. **Klorn never posts, reacts, marks read or changes anything in
Slack.** Execution stays approval-based (LOCKED); v1 has no execution at all.

## 2. Why an internal app (and its limits)

- Slack's 2025 rate limits on `conversations.history` / `conversations.replies`
  (1 request/min, 15 objects) apply to commercially distributed apps outside
  the Marketplace; "internal customer-built apps are not impacted"
  (https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps,
  clarified https://docs.slack.dev/changelog/2025/06/03/rate-limits-clarity).
  v1 does not call either method anyway: it is push-only (Events API).
- The Real-time Search API forbids persistent copies of Slack data, so v1 does
  not use it (Slack API Terms, "Data Access API and Real-Time Search API",
  https://slack.com/terms-of-service/api).
- An internal app needs no Marketplace review.

**Open legal question (founder decision, see §14).** The Slack API Terms
(effective 2025-10-10, "Commercial Distribution") apply the
Marketplace-or-partner requirement "regardless of whether you publish an
off-the-shelf Application or you provide customers with a custom Application
or Application template". Handing hosted-Klorn customers a manifest may count
as commercial distribution. Self-host (the customer runs Klorn and the app) is
the cleaner case. Until this is reviewed, keep `SLACK_ENABLED` at `cohort`
(founder's own workspace) on the hosted service.

## 3. Architecture

```
Slack workspace ──Events API (HTTPS POST, signed)──▶ POST /api/slack/events/:hookId
                                                        │ 1. dark gate (404 while off)
                                                        │ 2. 256 KiB body cap; raw bytes kept, NOT parsed
                                                        │ 3. address over its failure budget → 429
                                                        │ 4. hookId → SlackConnection (decrypt signing secret)
                                                        │ 5. v0 HMAC-SHA256 verify, ±5 min, constant-time
                                                        │ 6. per-hook verified-request budget
                                                        │ 7. JSON.parse, envelope shape check
                                                        │ 8. url_verification → echo challenge
                                                        │ 9. event_callback → keep/drop filter
                                                        │10. store message (unique event_id, caps) + episode
                                                        ▼    ack 200 (well under Slack's 3 s)
                                              SlackMessage / SlackEpisode rows
                                                        │
                       slack-episodes scheduler (30 s tick, SchedulerLease "slack-episodes")
                                                        │ ready = quiet 90 s, or 5 min old, or 20 messages
                                                        ▼
                     judgeEmail(..., { source: "slack" })   (existing judge, Slack prompt block)
                                                        │
                     ┌──────────────────────────────────┼─────────────────────────────┐
                     ▼                                  ▼                             ▼
          tier + short reason on               PUSH → interrupt budget       commitment extractor
          SlackEpisode                          → Notification + push         (source SLACK, suggested)
```

- **Routing.** Each connection has a random 128-bit `hookId`; the Slack app's
  Request URL is `https://<klorn-api>/api/slack/events/<hookId>`. A single
  shared `/api/slack/events` cannot work with per-workspace signing secrets:
  choosing the secret would require parsing the body first (to read
  `api_app_id`), and signature verification must come before any parsing.
  The hookId is not the credential (the signature is); it only selects which
  secret to verify against and keeps one workspace's traffic and rate limit
  apart from another's.
- **No new infrastructure.** Ingest is synchronous inside the request (one
  short transaction: a per-conversation advisory lock, the dedupe check, the
  storage caps, the episode append or create, the message insert); judging runs on the existing scheduler
  pattern (`registerScheduler`/`recordSchedulerTick`,
  `packages/api/src/scheduler-heartbeat.ts`; row lease `createSchedulerLease`,
  `packages/api/src/scheduler-lease.ts:338`, as `automation-scheduler.ts:146`
  does). LLM calls go through `createCompletion`
  (`packages/api/src/llm/openai.ts:557`), so the background pacer, the
  per-user daily cost cap (`billing/cost-guard.ts:132`) and the BYOK exemption
  (`openai.ts:264`, `llm/llm-credentials.ts:49`) all apply unchanged.
- **Socket Mode** (app-level `xapp-` token with `connections:write`, a
  WebSocket instead of a public URL;
  https://docs.slack.dev/apis/events-api/using-socket-mode) is the right
  answer for self-hosters behind NAT. Not in v1: it needs a long-lived
  connection per app and its own reconnect handling.

## 4. Manifest and scopes

The manifest is `integrations/slack/manifest.yaml`; Klorn serves the same
manifest with the Request URL filled in at `GET /api/slack/manifest`
(`packages/api/src/slack/manifest.ts` renders both; a test keeps them equal).
Schema: https://docs.slack.dev/reference/app-manifest (`features.bot_user` is
optional, so a user-scopes-only app is valid).

**User token only, no bot user.** A bot token sees only conversations the bot
is a member of; it cannot read a DM between the user and another person
(`im:history` on a bot token covers DMs "that your Slack app has been added
to"). User-token event subscriptions are "perspectival to a member installing
your application" and deliver what that user can see
(https://docs.slack.dev/apis/events-api/, https://docs.slack.dev/authentication/tokens).
`app_mention` is bot-only and there is no user-level mention event, so
@mentions of the user are found by checking `message.channels` /
`message.groups` text for `<@USERID>`.

| User scope | Event | Why it is needed |
|---|---|---|
| `im:history` | `message.im` | DMs to the user — the core signal. **Required.** |
| `mpim:history` | `message.mpim` | Group DMs the user is in; usually direct asks. |
| `channels:history` | `message.channels` | Public channels: the only way to see @mentions of the user, plus opted-in channels. |
| `groups:history` | `message.groups` | Private channels: same, for private channels. |

Not requested: any `*:write` scope (no outbound actions), `users:read`
(display names; v1 shows "Slack" plus the text), `channels:read` /
`groups:read` (the opt-in list takes channel IDs instead of listing
channels), `app_mentions:read` (bot-only). `auth.test` needs no scope
(https://docs.slack.dev/reference/methods/auth.test).

**Least privilege is enforced, not just requested.** On connect Klorn calls
`auth.test` with the user token and reads the granted scopes from the
`x-oauth-scopes` response header. It refuses a token without `im:history`
and refuses a token holding **any scope outside the four above**. Then it
drops the token: v1 makes no Slack API call that needs it, so a database
leak cannot hand anyone read access to a user's Slack history. A later
version that calls Slack (names, thread context) adds token storage with
that justification.

`token_rotation_enabled: false` (a rotating token needs a refresh flow v1
does not have), `socket_mode_enabled: false`, `org_deploy_enabled: false`
(Enterprise Grid org-wide install is out of scope).

## 5. Connection model (per user, v1)

One `SlackConnection` per Klorn user (`userId` unique): `hookId`, `teamId`,
the user's Slack `slackUserId`, the workspace URL (all three from
`auth.test`), the signing secret **encrypted** with the existing AES-256-GCM
envelope (`packages/api/src/crypto-tokens.ts:149` `encryptToken`, the same as
`LinkedInboxAccount` OAuth tokens), and the opted-in channel IDs (max 50).
The user token is not stored (§4). Re-connecting to another workspace or
another Slack user deletes what was stored for the previous one.

**Per user, not per org, in v1 — reversible.** Teams v1 (#1755) has
`Organization` / `OrgMembership` (`schema.prisma:2764`, `:2800`) but it is
flag-off and an org holds no mail today; every existing provider connection
is per user (`LinkedInboxAccount`). A user token is per person anyway: only
the installer gets one from the app's install page; other members would need
an OAuth redirect flow. So v1 = one person, one internal app, one connection.
The upgrade path (v1.1) is an org-level `SlackApp` row (signing secret,
client id/secret) held by the Teams org, plus per-member OAuth to mint each
member's user token. That changes the pricing story (a per-company install),
so it is a founder decision (§14).

Endpoints (all `requireAuth` + `cohortGate`, scoped by the session user; no
id in any path, so there is nothing to IDOR):

| Method | Path | Does |
|---|---|---|
| GET | `/api/slack/connection` | status, workspace URL, team id, opted-in channels, Request URL, last event time. Never a secret. |
| POST | `/api/slack/connection` | create the pending connection (mints the hookId); idempotent |
| GET | `/api/slack/manifest` | the manifest YAML with this connection's Request URL (409 when the server has no public URL) |
| PUT | `/api/slack/connection/credentials` | `{signingSecret, userToken}` → `auth.test` → store the encrypted secret; the token is dropped |
| PUT | `/api/slack/connection/channels` | `{channelIds}` opt-in list |
| DELETE | `/api/slack/connection` | disconnect: delete tokens and every stored Slack row |

`/api/slack/events/:hookId` is the only unauthenticated route; it is listed in
`security/route-auth-exemptions.ts` as `webhook-signature`, like the Paddle
webhook.

## 6. Data flow and the keep/drop filter

Verified events are kept only when **all** hold:

1. envelope `type` is `event_callback`, `team_id` equals the connection's
   team, and `authorizations[]` contains the connection's Slack user (so
   another member's view of the workspace can never land on this user);
2. `event.type` is `message` with no subtype or one of `thread_broadcast`,
   `file_share` (text only — file contents are never fetched);
3. not from a bot (`bot_id` / `bot_profile` present, or `subtype:
   bot_message`) and not a join/leave/topic/etc. subtype;
4. not from the user themselves — the user's own message is never stored or
   judged; it marks the open episodes of that conversation whose last
   message is older than the reply **answered** (no judgment, no
   notification, no LLM spend), and a reply inside a thread also answers the
   top-level episode holding the thread's parent message;
5. `is_ext_shared_channel` is not true (Slack Connect content belongs partly
   to another organization; see §13);
6. the conversation is a DM (`channel_type` `im`) or group DM (`mpim`), or a
   channel/private channel where the text mentions `<@slackUserId>` or the
   channel is on the user's opt-in list.

Everything else is answered `200` and discarded without being stored. A
`message_deleted` event deletes Klorn's copy of that message.

`app_rate_limited` (Slack's 30,000 events per workspace per app per hour)
is logged as a count and answered `200`.

## 7. Episode model

An **episode** is one burst of conversation: messages in the same
conversation key `(connection, channel, thread_ts or "top level")` that
arrive within **10 minutes** of the previous one. An episode is *ready* for
judging when it has been quiet for **90 s**, or its first message is **5
minutes** old, or it holds **20 messages**. A message arriving after its
episode was judged starts a new episode. Constants live in
`packages/api/src/slack/episodes.ts`.

This keeps one LLM call per burst instead of per message, and still rings
within about 90 s of the last message of an urgent DM.

## 8. Judging

The existing judge, not a new engine: `judgeEmail` (`packages/api/src/judge/poc-judge.ts:804`)
with a `source: "slack"` option. For Slack it:

- replaces the email item block of the prompt (`buildJudgePrompt`, `poc-judge.ts:342`)
  with a Slack block (conversation kind, mentions-you, messages), every
  Slack-supplied string wrapped by `wrapUntrusted` (`packages/api/src/untrusted.ts:26`)
  with `slack:*` sources — the same wrapping mail gets;
- skips the email-address-keyed shortcuts (pinned sender rule, marketing
  fast path, sender prior, learned rules), because a Slack user ID is not an
  email address;
- keeps the four-feature LLM score → deterministic tier rule → keyword
  fallback, so the output is one of the 5 lanes (PUSH / MEETING / QUEUE /
  INFO / SILENT) via `normalizeTier` (`judge/tiers.ts:36`); retired values
  can never be emitted.

The call carries `userId` and the user's BYOK credentials, so the per-user
daily cost cap and BYOK exemption apply unchanged. If the cap is hit the
judge's own fallback decides the lane (no Slack-specific bypass).

Not judged: the user's own messages, bot messages, joins and other subtypes
(§6). AE3 v3 facts/policy (`judge/v3/*`) is email-shaped (`FactsMailInput`,
`AttentionItem source "EMAIL"`); Slack does not go through it in v1.

## 9. Notifications

A PUSH episode is offered to the interrupt budget first
(`admitPushNotification`, `packages/api/src/judge/v3/push-budget-gate.ts:66`:
the same per-day budget, trusted-sender reserve and `Notification` dedupe
rows as mail). Held → a bell row only, no ring. Admitted → a `Notification`
row of type `slack` whose `link` is the Slack permalink
(`https://<workspace>.slack.com/archives/<channel>/p<ts without dot>`, plus
`?thread_ts=…&cid=…` for a thread reply — the format Slack's own
`chat.getPermalink` examples use; computed locally so no API call is made),
the desktop WebSocket frame, and `sendPushNotification` (`notify/push.ts:176`)
with the urgent-interrupt category, so quiet hours, focus window and the
user's urgent-push opt-out apply. Push text comes from `slackPushContent`
(sibling of `mailPushContent`, `notify/mail-push-content.ts:102`): title
"Slack", body the first line of the episode (plain text, 180 chars) and the
judge's reason, localized in all 7 notification languages.

## 10. Commitments

Each judged episode (any lane but SILENT) runs the existing ledger ingestion,
`extractAndUpsertCommitmentsFromText` (`packages/api/src/pim/commitment-ingestion.ts:153`),
with `sourceType: "SLACK"` (already in `CommitmentSource`, `schema.prisma:2537`),
`sourceId` `<channel>:<ts>`, `threadId` `<channel>:<thread_ts>`. Rule-only
candidates are written below the 0.7 confirmation line, i.e. **suggested, not
confirmed** (`pim/commitment-confirmation.ts:20`), exactly as for mail. Every
message in a Slack episode is from someone else, so a first-person promise
("I'll send it Friday") is the counterparty's, not the user's.

## 11. What is stored, for how long, and why

| Data | Where | Kept | Why |
|---|---|---|---|
| signing secret | `SlackConnection`, AES-256-GCM | until disconnect | verify requests |
| user token | **not stored** | checked once by `auth.test`, then dropped | — |
| team id, Slack user id, workspace URL, opted-in channel ids | `SlackConnection` | until disconnect | routing, own-message and mention checks, permalinks |
| message text (≤ 4,000 chars each), sender id, ts, event_id | `SlackMessage` | **7 days** after receipt | judging and commitment extraction; event_id dedupe for retries |
| episode: channel, thread ts, counts, lane, short reason (≤ 200 chars), timestamps | `SlackEpisode` | **90 days** | what was decided and why, without the text |
| PUSH notification preview (≤ 180 chars) | `Notification` | with the notification | the bell row |
| suggested commitments (title, short evidence) | `Commitment` (`SLACK`) | until the user acts or disconnects | the ledger |

Dropped events are never stored. Per connection at most **300 new messages
an hour** and **3,000 unexpired messages** are stored; past either, events
are acknowledged and dropped (the signing secret is the user's own, so a
signature proves who sent an event, not that Slack did — the caps bound what
one connection can store). The purge (`purgeExpiredSlackData`) runs at most
every 10 minutes from the Slack scheduler, independent of
`LOG_RETENTION_ENABLED` and of `SLACK_ENABLED`, and keeps running under
`BACKGROUND_AGENTS_DISABLED`; it is covered by unit and Postgres tests. Disconnect deletes the connection, every episode and
message, and the Slack-sourced commitments and notifications. Deleting the
Klorn account deletes all of it (`purge-user-data.ts`). No Slack data is used
to train any model (Slack Developer Policy, "Use of Data",
https://docs.slack.dev/developer-policy).

## 12. Security

- **Signature first.** The Slack plugin installs its own body parser that
  keeps the raw body as bytes (a `Buffer`) and does **not** parse it. The handler
  verifies `X-Slack-Signature` = `v0=` + hex HMAC-SHA256 of
  `v0:{X-Slack-Request-Timestamp}:{raw body}` with the connection's signing
  secret, constant-time (`timing-safe-equal.ts`), and rejects a timestamp more
  than 5 minutes from now — before `JSON.parse`
  (https://docs.slack.dev/authentication/verifying-requests-from-slack).
- **Body cap** 256 KiB (`413` past it). **Rate limits** (`slack/limits.ts`)
  replace the global per-address limiter, which would throttle Slack's shared
  delivery addresses: 30 *failed* requests (unknown hook, bad or missing
  signature) per client address per minute, checked before any database
  lookup; and 600 *verified* requests per hook per minute (Slack's own
  ceiling is 30,000/hour = 500/min), counted only after the signature
  verified so a leaked hook id cannot exhaust a workspace's budget. Unknown
  hooks get the dark route's 404; a known hook without a secret and a bad
  signature get the same 401.
- **Replay / retries.** Slack retries up to 3 times (immediately, +1 min,
  +5 min) with `X-Slack-Retry-Num` / `X-Slack-Retry-Reason`
  (https://docs.slack.dev/apis/events-api/using-http-request-urls). A replayed
  `event_id` hits the `(connectionId, eventId)` unique index and is
  acknowledged without a second message, episode or judgment. A request whose
  signature verified but whose body is unusable gets `400` with
  `X-Slack-No-Retry: 1`.
- **Ack fast.** Ingest is one short transaction; judging is async. A
  transaction-scoped advisory lock per conversation stops two concurrent
  first messages from opening two episodes, and a message never lands in an
  episode the judge already claimed.
- **Untrusted text.** Slack text is wrapped with `wrapUntrusted` before any
  LLM call; text handling is linear and size-capped (4,000 chars/message,
  20 messages/episode; NUL dropped and lone surrogates replaced so Postgres
  never rejects a message); no regex is built from Slack- or user-supplied
  input (this repo had ReDoS outages from mail text).
- **Secrets never leave.** Responses use explicit `select` lists; errors
  never echo a token, a secret or the request body; logs carry reasons and
  counts only (at most one line per reason per hour); the user token is used
  for `auth.test` and never stored.
- **Tenant isolation.** Every authenticated read and write is scoped by the
  session user; the three tables have RLS on (`rls-coverage-guard.test.ts`)
  and are fenced by the data-wipe trigger.

## 13. Not in v1

- Any outbound action: posting, replying, reacting, marking read, setting
  status. (Approval-based execution, LOCKED, would gate it if ever added.)
- Socket Mode, Enterprise Grid org-wide installs, multiple workspaces per user.
- Per-member OAuth and an org-level (Teams) install.
- Slack Connect / externally shared channels (dropped; data partly belongs to
  another organization).
- Display names (`users:read`), channel names (`channels:read`), file
  contents, message edits (`message_changed` is ignored; the original text is
  kept until it expires).
- Showing Slack episodes in Today / Mail lanes or Approvals (they are not
  `AttentionItem` rows; `AttentionSource` has no `SLACK`), the Mac app's
  native banners (built from `AttentionItem`), learning from Slack
  corrections, the AE3 v3 facts/policy path.

## 14. Decisions taken on the founder's behalf (reversible, all dark)

1. Per-user connection in v1; org-level install deferred (§5).
2. `/api/slack/events/:hookId` instead of a single shared URL (§3).
3. Four user scopes, no bot, no write scopes; tokens with extra scopes are
   refused, and the user token is not stored at all (§4).
4. Slack Connect channels dropped (§6).
5. Retention: text 7 days, episode verdicts 90 days (§11).
6. Legal: whether a hosted-Klorn manifest template is "commercial
   distribution" under the Slack API Terms needs review before `SLACK_ENABLED`
   goes past the founder cohort on the hosted service (§2).

## 15. Self-host setup

1. Set `SLACK_ENABLED=on` (or `cohort` plus `ROLLOUT_COHORT_USER_IDS`) and
   `PUBLIC_URL` to the public HTTPS origin of your Klorn API (Slack must be
   able to reach it; the same variable the phone webhooks use, falling back
   to `RENDER_EXTERNAL_URL`). Without it Klorn refuses to hand out a manifest.
   `TOKEN_ENCRYPTION_KEY` (already required) encrypts the signing secret.
2. In Klorn: Settings → Integrations → Slack → **Start setup**. Klorn mints
   your Request URL and offers the filled-in manifest.
3. In Slack: https://api.slack.com/apps → **Create New App** → **From a
   manifest** → pick the workspace → paste the manifest → **Create**.
4. **Install to Workspace** and allow. Copy the **User OAuth Token**
   (`xoxp-…`, OAuth & Permissions) and the **Signing Secret** (Basic
   Information → App Credentials).
5. In Klorn, paste both and **Connect**. Klorn checks the token with
   `auth.test` and its scopes.
6. In Slack: **Event Subscriptions** → the Request URL shows unverified
   (Slack tried before Klorn had the secret) → **Retry**. It turns
   "Verified" and events start.
7. Optional: add channel IDs (channel name → View channel details → bottom
   of the About tab) to judge every message in those channels, not only
   mentions.

To stop: **Disconnect** in Klorn (deletes everything Klorn stored), then
delete the app in Slack.
