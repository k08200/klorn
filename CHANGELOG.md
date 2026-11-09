# Changelog

All notable changes to Klorn are recorded here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Klorn is pre-1.0 — the public API can break between minor versions. The
`v1.0.0` threshold is gated on POC retention (3/5 ICP sustaining use through
the Day 14+7 measurement window) plus the cost-gate gap closure, not on
calendar time.

## [Unreleased]

### Security

- **Client address derivation hardened.** One helper
  (`packages/api/src/security/client-address.ts`) now supplies the client
  address for every per-address rate limit, the `RATE_LIMIT_ALLOW_IPS`
  exemption, the device-session address and the request log. A forwarding
  header is trusted only when the new `CLIENT_IP_SOURCE` names it
  (`socket`, `x-forwarded-for` with `TRUSTED_PROXY_HOPS`, or
  `cf-connecting-ip`). The default is the TCP peer, or `cf-connecting-ip` on
  Render. The playground demo cap and the device-session address no longer
  read `X-Forwarded-For` directly. **Self-hosters behind a proxy:** set
  `CLIENT_IP_SOURCE=x-forwarded-for`, or keep a proxy that sets
  `CF-Connecting-IP` (the earlier Caddy/nginx examples) and set
  `CLIENT_IP_SOURCE=cf-connecting-ip`. Without either, all clients share the
  proxy's bucket, and the API logs a one-time warning. See
  docs/self-hosting.md ("Client address").

## [0.4.0] — 2026-11-08

First server release since 0.3.0 (2026-06-09). It covers every PR merged since
then, from #491 on. `@klorn/api` and `@klorn/web` are at `0.4.0`.
`@klorn/contract` replaces `@klorn/core`, which was removed in #821, and has
its own version.

Tags named `desktop-v*` and `desktop-win-v*` that appeared after 0.3.0 are
macOS and Windows app builds. They do not carry a server version. The desktop
and mobile apps ship from their own tags; the last group below summarizes them
briefly.

Database migrations run when the API boots (`packages/api/scripts/start.sh`
runs `prisma migrate deploy`). An entry marked "behind a flag, off by default"
does nothing until you set the environment variable it names.

### Breaking — self-hosters and API clients
- **The api and web images run as a non-root user.** Both run as `klorn`
  (uid/gid `10001`) instead of root. The app tree stays root-owned; the
  runtime user owns only `packages/api/data`, `packages/web/.next/cache` and
  its home directory.
  - The stock `docker-compose.selfhost.yml` mounts no volume into `api` or
    `web`, so it needs no change.
  - A bind mount or named volume you added (for example for
    `EVE_CONVERSION_STORAGE_DIR`) must be writable by uid `10001`:
    `sudo chown -R 10001:10001 <path>`, or
    `docker run --rm -v <volume>:/d alpine chown -R 10001:10001 /d`.
  - The hosted service does not use these images.
- **OpenRouter is removed; Klorn calls the Claude API by default.**
  - `OPENROUTER_API_KEY`, `FALLBACK_MODEL` and `DISABLE_FREE_MODEL_FALLBACK`
    are no longer read. Delete them.
  - Set at least one of: `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, or
    `OPENAI_COMPAT_BASE_URL` together with `OPENAI_COMPAT_MODEL` (Ollama,
    LM Studio, vLLM, llama.cpp).
  - `LLM_PROVIDER_ORDER` sets the order of the cloud providers. An
    `openrouter` entry is ignored with a boot warning.
  - `CHAT_MODEL`, `AGENT_MODEL`, `JUDGE_MODEL`, `DRAFT_MODEL` and
    `VISION_MODEL` now default to `claude-haiku-5-5`. If you set any of them
    to an OpenRouter-style id (`vendor/model:free`), change it to a model your
    provider serves.
  - Migration `20261104120000_drop_openrouter_key` drops
    `User.openRouterApiKey`, so stored OpenRouter BYOK keys are deleted. BYOK
    now takes an Anthropic key (`sk-ant-…`).
  - See `.env.example`, `.env.selfhost.example` and `docs/self-hosting.md`.
  - (#1543, #1611, #1615)
- **Secrets fail closed.** If `NODE_ENV` is anything other than `development`
  or `test`, a missing `JWT_SECRET` or `TOKEN_ENCRYPTION_KEY` stops the API at
  boot. The public dev fallbacks are gone (#824, #832, #833).
- **Plaintext stored OAuth tokens are rejected.** A token column without the
  v1/v2 encryption prefix throws, and the account has to reconnect (#529).
- **Set `CORS_ORIGINS` to your web origin.** Outside `development` and `test`,
  an unset `CORS_ORIGINS` trusts only `https://klorn.ai` and
  `https://www.klorn.ai`. The self-host compose file defaults it to
  `http://localhost:3000` (#931).
- **The rate-limit client IP no longer comes from `X-Forwarded-For`.** It comes
  from `CF-Connecting-IP`, or from the socket address when that header is
  absent. Behind a reverse proxy that is not Cloudflare, all clients can share
  one bucket (#932).
- **Gmail Pub/Sub push:** OIDC tokens are now verified against Google's
  certificates. `GMAIL_PUSH_OIDC_AUDIENCE` is required whenever
  `GMAIL_PUSH_OIDC_EMAIL` is set (#496).
- **Five lanes.** Classification emits PUSH / MEETING / QUEUE / INFO / SILENT.
  - This is controlled by `TIER_V2_ENABLED`, which is on by default; set it to
    `false` to revert.
  - Rows stored with retired v1 values are folded on read. To rewrite them,
    run the optional `pnpm exec tsx scripts/backfill-tier-v2.ts --apply` (a
    dry run without `--apply`).
  - The `tiers.AUTO` and `summary.AUTO` response keys remain and are always
    empty.
  - (#496, #1124, #1125, #1134, #1135, #1138, #1360)
- **API changes:**
  - WebSocket auth uses the `klorn-ws-v1` subprotocol only; the `?token=`
    fallback was removed (#804, #1083).
  - `GET /api/email/:id?markRead=true` no longer marks mail read. Use
    `PATCH /api/email/:id/read` (#1086).
  - A repeated query parameter returns 400 (#1084).
  - A compose attachment outside the MIME allowlist returns 415 (#1085).
  - Web sign-in requires the matching API, so upgrade `api` and `web`
    together (#1505).
- **Every signup starts on FREE.** `BETA_AUTO_PRO_ENABLED` and
  `BETA_AUTO_PRO_LIMIT` were removed. FREE accounts do not get auto-reply,
  agent Auto mode or the agent write tools. To grant them, set the account's
  plan in `/admin`, or list the operator's verified address in
  `ADMIN_EMAILS` (#1574).
- **Removed integrations:**
  - GitHub notifications (#1053).
  - Slack, including `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` (#1271).
  - The public `POST /api/waitlist` endpoint; creating waitlist rows is now
    admin-only (#1257, #1261).
- **Database size alarm.** Admin notifications start at 80% of
  `DB_SIZE_LIMIT_MB`, which defaults to 500. Set it to your real limit (#1465).
- **Account-link OAuth handoff is held in memory.** Run a single API instance,
  or the link callbacks can miss (#1451).

### Added — Self-hosting
- `docker-compose.selfhost.yml` runs Postgres 16, the API and the web app.
  This release also adds `.env.selfhost.example`, `SECURITY.md` and
  `docs/self-hosting.md`, which covers providers, Caddy/nginx/Traefik reverse
  proxies, backup and restore, and a fully local LLM through Ollama (#959,
  #1268).
- Prebuilt images `ghcr.io/k08200/klorn-api` and `ghcr.io/k08200/klorn-web`
  are built for `linux/amd64` and `linux/arm64`.
  - A `v*` tag publishes them as `<version>`, `<major>.<minor>` and `latest`.
    The compose file pulls `latest` (#1173, #1176).
  - The web image is built with `NEXT_PUBLIC_API_URL=http://localhost:3001`.
    To serve it from another host, rebuild it after changing `WEB_URL`,
    `CORS_ORIGINS`, `NEXT_PUBLIC_API_URL` and `GOOGLE_REDIRECT_URI` together.
- `Dockerfile.api` applies migrations on start (#504).
- Self-host reference fixes: `RATE_LIMIT_ALLOW_IPS` is documented (format,
  default, scope and the effect of an over-broad range), along with keeping
  the API port behind the reverse proxy; `GMAIL_PUSH_OIDC_AUDIENCE`, required
  whenever `GMAIL_PUSH_OIDC_EMAIL` is set, is passed through the self-host
  compose file; `.env.selfhost.example` and `.env.example` match what compose
  and the code do.
- Health and liveness checks:
  - Compose healthchecks (#1268).
  - `GET /api/health/ready` returns 503 while the database is unreachable
    (#1480).
  - `GET /api/health/schedulers` returns 503 when a background scheduler goes
    silent (#788).
- Token-encryption key rotation through `TOKEN_ENCRYPTION_KEYS`,
  `TOKEN_ENCRYPTION_ACTIVE_KEY_ID` and `src/scripts/reencrypt-tokens.ts`
  (#805).
- LLM providers:
  - A native Anthropic provider is the default when `ANTHROPIC_API_KEY` is set.
    It is configured with `ANTHROPIC_MODEL` and the other `ANTHROPIC_*`
    settings (#1543).
  - Gemini and any OpenAI-compatible endpoint remain available, and the local
    endpoint is used first (#500, #1611).
  - Requests time out and fail over to the next provider; the timeout is set
    with `LLM_REQUEST_TIMEOUT_MS` (#1477).
  - PDF attachments go to Claude as document blocks (#1599).
- Operator tooling:
  - `GET /api/admin/flags` lists every flag with its environment variable name
    (#895, #896).
  - An hourly judge fallback-rate alarm, tuned with
    `JUDGE_HEALTH_FALLBACK_RATE` and `JUDGE_HEALTH_MIN_SAMPLE` (#647, #1362,
    #1368).
  - Ops-log pruning, behind `LOG_RETENTION_ENABLED`, off by default (#803).

### Added — Mail
- Compose with attachments (`POST /api/email/compose`), in-thread replies
  (`POST /api/email/:id/reply`) and three reply options per message
  (`POST /api/email/:id/reply-options`) (#594, #596, #745, #835).
- Reply drafts for meeting mail include verified calendar facts. When the
  sender's calendar is readable, they also include free/busy and slots that
  both sides have free (#1104, #1144, #1160).
- Reading aids:
  - AI summary card and on-demand summaries (#1150, #1166).
  - Sender dossier (#1162, #1164).
  - A brief of the whole thread (#1199).
  - The assistant knows which message is open (#1197).
- HTML mail is sanitized and rendered in a sandboxed iframe, with `cid:` inline
  images (#1109, #1122, #1306, #1455, #1491).
- Folders and reply state:
  - Per-account Sent, Drafts and Archived folders (#1304).
  - Reply-needed and replied state on each row, plus
    `GET /api/email/waiting-on` (#1317, #1323).
- Unsubscribe on request with `POST /api/email/:id/unsubscribe`. It tries
  RFC 8058 one-click first, then mailto, then returns the link (#1280).
- Sent-mail provenance: `SentMessage.origin` is `user`, `approved`,
  `auto_reply` or `unsubscribe`, so mail Klorn sent is not mistaken for mail the
  user wrote (#1591, #1598, #1614).
- Gmail sync:
  - Sync uses the History API, so messages older than the newest 30 are no
    longer dropped.
  - The default sync interval is 60 s (#527, #675).
  - The list refreshes when new mail lands (#633, #737).
  - Opening the queue triggers a debounced pull. Set
    `ACTIVITY_MAIL_SYNC_DISABLED` to turn it off (#1052).

### Added — Classification and learning
- Correction loop:
  - Manual overrides feed few-shot examples and sender priors back into the
    judge.
  - A prior never resolves to SILENT without the LLM (#500, #533).
- Ways for the user to teach the judge:
  - Sender pins and exact-domain pins (#1188, #1277).
  - Plain-language rules, compiled to pins and reviewed before saving
    (Settings → Rules) (#1279).
  - Sender labels, company domains, written priorities and a purpose for each
    mailbox (#1292, #1309, #1310, #1316).
- An onboarding step to confirm or correct the first classifications (#791).
- Measurement:
  - Decision-label ledger.
  - `GET /api/admin/decision-metrics`, which reports bounds rather than point
    estimates.
  - Daily calibration snapshot (`GET /api/admin/calibration`).
  - `GET /api/admin/judge-health`.
  - LLM usage ledger (`GET /api/admin/llm-usage`).
  - (#500, #508, #509, #536, #538, #539, #647)
- Ontology:
  - Deterministic policy modules, exposed at `GET /api/admin/ontology` and on
    the `/admin/ontology` page.
  - Advisory threshold proposals with approve and revert.
  - (#547, #552, #553, #554, #556)
- Judge settings:
  - Model pins `JUDGE_MODEL` and `DRAFT_MODEL` (#511, #512, #528).
  - Temperature 0 with an exact-prompt cache (#577, #645).
  - An optional escalation model, `JUDGE_ESCALATION_MODEL` (#547).
  - A `JUDGE_MODEL` that the committed eval records as failing its gate is
    replaced by the default, unless `JUDGE_MODEL_ALLOW_GATE_FAILURE=true`
    (#1320, #1322).

### Added — Assistant, API keys and MCP
- The assistant was rebuilt (#726, #734).
  - It works through an allowlist of tools: mail, calendar, briefing and time.
  - It accepts voice input, can create events from voice
    (`POST /api/calendar/parse-event`), and lets the user choose the model.
  - Tools that sent content to third parties (web search, translate, URL
    shortener, currency) were removed.
- Personal API keys (`klorn_sk_…`) are stored hashed, shown once, and limited
  to 5 per user. A read-only MCP endpoint is at `POST /api/mcp` (Streamable
  HTTP), with a guide in `docs/mcp/connect-clients.md` (#1281, #1283, #1326,
  #1333).
- A BYOK key per user, encrypted at rest. Calls made on it do not count toward
  Klorn's cost caps (#568, #580, #585, #859, #1611).
- Telegram delivery adapter (#500, #501).
- A public playground at `/playground` (`POST /api/playground/classify`). It
  uses the visitor's Anthropic, OpenAI or Gemini key for one call and never
  stores it on the server (#542, #1582, #1611).

### Added — Calendar
- New-event dialog (#724, #729).
- Double-booking detection across calendars (#630, #750).
- Free/busy from a second linked Google account (#638, #641, #693).
- The time zone defaults to "Automatic" (the device zone). `PATCH
  /api/automations` returns 400 for an invalid zone (#1521).

### Added — Notifications and briefings
- Push notifications:
  - One push format: the sender is the title, and the body is the subject plus
    the reason. Reply and Later actions appear where the platform supports
    them (#637, #1642).
  - Push text in 7 languages (#1635).
  - One OS notification per PUSH in a browser tab (#1637).
  - Settings → Notifications lists where you get alerts (#1641).
- Holding back alerts:
  - Quiet hours (#500).
  - A focus window that holds non-urgent pushes during calendar blocks. It is a
    per-user setting, off by default (#1187).
- Briefings:
  - The daily briefing uses the judge's verdicts (#624, #625, #626).
  - Briefing v2 is localized on the server (#1191).
  - A weekly signal report on Mondays follows the daily-briefing preference
    (#1189).
- An alert and a reconnect prompt when Gmail disconnects (#955, #1212).

### Added — Web app
- Seven UI languages: en, ko, ja, zh, es, fr and de. The ja, zh, es, fr and de
  strings are machine translations with no native review yet (#740, #1118,
  #1119, #1211, #1215, #1220, #1222, #1224, #1229).
- Look and layout:
  - Dark mode (#1111, #1112).
  - Design Language v2 (#1365, #1597).
  - Settings split into sections (#1373).
  - Redesigned sign-in pages (#1407).
  - Device-class layouts (#1620, #1621, #1622).
  - An offline page (#1405).
  - A touch-friendly month calendar (#1630).
  - Accessibility passes (#664–#671, #674, #682, #1099).
- Other pages:
  - A `/usage` dashboard for spend and tokens (#1101).
  - A relationship graph at `/graph` (#564–#567).
- Self-service account deletion (`DELETE /api/auth/account`) (#930).

### Added — Accounts and billing
- Billing, behind `PAYWALL_ENABLED`, off by default (#610–#617, #639, #644,
  #646, #656, #732, #733, #736, #738, #923, #925, #926, #1161, #1196):
  - Entitlement gates.
  - A trial, set with `TRIAL_DAYS`.
  - A free-tier daily cost cap, set with `FREE_DAILY_COST_CAP_CENTS`.
  - Web checkout through Paddle or Stripe, and RevenueCat for mobile.
  - Persisted webhook dedup.
  - In-app cancel and undo.
- Signup attribution (utm, referrer, landing path), stored in your own
  database and shown in admin (#1143, #1158, #1178, #1202, #1305).
- First-party product analytics, stored in your own database and deleted with
  the account (#936). The events are `app_open`, `queue_action`, `notif_muted`,
  `push_sent` and `push_opened`.

### Added — Behind a flag, off by default
- **Mail providers:**
  - iCloud IMAP: `ICLOUD_INBOX_ENABLED` (#1034).
  - Outlook over Microsoft Graph, with threaded replies and drafts:
    `OUTLOOK_INBOX_ENABLED` (#1035, #1036, #1038, #1041, #1343, #1570).
  - IMAP read and unread state: `IMAP_ACTIONS_ENABLED` (#1332).
  - SMTP send, reply and drafts: `IMAP_SEND_ENABLED` (#1339, #1341).
  - Archive, trash and undo: `IMAP_MOVE_ACTIONS_ENABLED` (#1344, #1351).
  - Generic IMAP by hostname: `GENERIC_IMAP_ENABLED` (#1353, #1356).
  - Multi-provider first run: `ONBOARDING_V2` (#1392).
  - A second Google inbox: `MULTI_INBOX_SYNC_ENABLED` (#659–#714).
  - Linked-inbox auto-reply: `AUTO_REPLY_LINKED_INBOX_ENABLED`.
  - Inbox selector: `PROVIDER_INBOX_SELECTOR_ENABLED` (#1030, #1031, #1032).
- **Sign-in:** Apple with `APPLE_LOGIN_ENABLED` and Naver with
  `NAVER_LOGIN_ENABLED` (#1037, #1208, #1210).
- **Calendars** (read-only, except the primary Google calendar):
  - Linked Google: `LINKED_CALENDAR_SYNC_ENABLED` (#1342).
  - A single read path across calendars: `UNIFIED_CALENDAR_READ_ENABLED`
    (#1346).
  - Cancellation sync: `CALENDAR_CANCELLATION_SYNC_ENABLED` (#1349).
  - Outlook: `OUTLOOK_CALENDAR_ENABLED` (#1352, #1440).
  - CalDAV for iCloud and Naver: `CALDAV_CALENDAR_ENABLED` (#1359, #1425).
  - macOS device calendars: `DEVICE_CALENDAR_ENABLED` (#1372).
  - Hide declined invitations: `CALENDAR_HIDE_DECLINED_ENABLED` (#1427).
  - Co-attendance counts per contact, with counts only and no attendee lists:
    `CALENDAR_COATTENDANCE_ENABLED` (#1604, #1617).
- **Files:**
  - S3-compatible storage: `OBJECT_STORAGE_ENABLED` (#1379).
  - File index: `DRIVE_ENABLED` (#1378).
  - Klorn drive: `KLORN_DRIVE_ENABLED`. Uploads are refused until
    `KLORN_DRIVE_QUOTA_BYTES` is set (#1403, #1527).
  - File summaries: `DRIVE_SUMMARIES_ENABLED` (#1416).
  - Google Drive: `GOOGLE_DRIVE_ENABLED` (#1449, #1452, #1453, #1454).
  - The drive flags also accept `cohort`, which reads
    `ROLLOUT_COHORT_USER_IDS` (#1526).
- **Klorn mailbox:** a `<handle>@<KLORN_MAILBOX_DOMAIN>` address that receives
  mail through Resend inbound, behind `KLORN_MAILBOX_ENABLED` (#1523, #1529).
- **Attention engine v3:**
  - Fact extraction and a shadow store: `JUDGE_V3_SHADOW` (#1587, #1589,
    #1595, #1603, #1608).
  - A policy layer with a daily PUSH budget, ranked QUEUE, and held-back PUSH
    mail waiting in QUEUE: `JUDGE_V3_POLICY` (#1596, #1609, #1627, #1628,
    #1640).
  - The PUSH budget defaults to 5. Set it with `JUDGE_V3_PUSH_BUDGET`; users
    can set 1–50.
  - The policy applies only to users that `JUDGE_V3_SHADOW` covers.
  - `JUDGE_V3_POLICY_VERSION=v3.0` rolls back from v3.1.
- **Mail features:**
  - Import 12 months of Sent history: `SENT_HISTORY_BACKFILL_ENABLED` (#1600).
  - Proactive reply drafts for PUSH mail: `PROACTIVE_DRAFT_ENABLED`, with
    `PROACTIVE_DRAFT_DAILY_CAP` defaulting to 5 (#1364).
  - A Subscriptions page: `BULK_UNSUBSCRIBE_ENABLED` (#1469).
  - Automatic one-click unsubscribe with per-user, per-host and global daily
    caps: `AUTO_UNSUBSCRIBE_ENABLED` (#1280, #1421).
  - Server-side receipts for manual sends: `MANUAL_SEND_RECEIPTS_ENABLED`
    (#1463).
- **Assistant and API:**
  - MCP write tools (`mark_read`, `set_tier`, and a reply-only `create_draft`)
    with an audit log: `MCP_WRITE_TOOLS_ENABLED` (#1325, #1331, #1334, #1336,
    #1340).
  - Teams and whole-team availability: `TEAM_MODE_ENABLED` (#1165, #1168,
    #1174, #1422).
- **Web UI:**
  - Keyboard triage: `KEYBOARD_TRIAGE` (#1375).
  - Lane-first mail view: `MAIL_V2` (#1383, #1386, #1405, #1459, #1483, #1485).
  - Today home: `UNIFIED_HOME` (#1388, #1391, #1422, #1430, #1530, #1533,
    #1537, #1632).
- **Inbox extras:**
  - First-contact screener: `SCREENER_ENABLED` (#1221, #1228).
  - Lane written back as a Gmail label: `GMAIL_LABEL_MODE_ENABLED` (#1223,
    #1227, #1236).
  - Daily email digest: `DAILY_DIGEST_ENABLED`, which needs `RESEND_API_KEY`
    (#1230, #1232).
  - Telegram chat: `TELEGRAM_CHAT_ENABLED` (#1285).
  - PMF survey: `PMF_PROBE_ENABLED` (#1234, #1235).
  - Item aging: `ATTENTION_AGING_ENABLED` (#1049).
  - Key-free playground demo: `PLAYGROUND_NO_KEY_DEMO_ENABLED` (#956).
- **Judge inputs:**
  - `JUDGE_INCLUDE_BODY` (#623).
  - `LEARNED_RULES_IN_JUDGE` (#606).
  - `SENDER_TRAITS_IN_JUDGE` (#602).
  - `CONTACT_ENGAGEMENT_IN_JUDGE` (#795, #853).
  - `CI_NOISE_SILENT_FLOOR` (#819).
  - `FALLBACK_REJUDGE_SWEEP` (#858, #861, #997).
  - `SENDER_ADDRESS_INDEX_ENABLED` (#685).
  - Semantic ranking of few-shot examples, active when `EMBEDDING_MODEL` is set
    (#642).

### Changed
- **Gmail SPAM intake:** each sweep takes up to the 10 newest SPAM messages
  into QUEUE. They never interrupt. This is on by default; set
  `SPAM_INTAKE_ENABLED=false` to turn it off (#1132, #1138).
- **Promotional mail is marked read in Gmail** when the deterministic
  marketing rule files it as SILENT. There is no flag for this (#587, #590).
- **Auto mode** is a per-user delegation setting, not a lane.
  - Once a user picks Auto and has `email_auto_reply`, Klorn sends unattended
    replies, guided by the user's guideline, to eligible items.
  - `AUTO_MODE_SEND_ENABLED=false` is the global kill switch.
  - Auto-replies send only from Google accounts.
  - `AUTO_REPLY` rules match the parsed sender address only, and a rule that
    names no sender is refused.
  - (#1128, #1129, #1139, #1338, #1476)
- **Accounts and sign-in:**
  - New accounts start with the autonomous agent off (#534).
  - Signup is open unless `BETA_GATE_ENABLED=true` (#1202).
  - FREE keeps 3 signed-in devices (#1574).
  - Google login is identity-only; Gmail and Calendar access is granted in the
    connect flow (#1025).
- **Push rate caps are split into two buckets:**
  - Interrupt (urgent mail, meeting alerts, reminders): 6 per 10 min and 20 per
    60 min, set with `PUSH_INTERRUPT_CAP_10MIN` and `PUSH_INTERRUPT_CAP_60MIN`.
  - Ambient: 3 per 10 min and 6 per 60 min, set with `PUSH_CAP_10MIN` and
    `PUSH_CAP_60MIN`.
  - Web push actions are now Reply and Later; Mute and the tier-override token
    were removed.
  - (#1636, #1642, #1645)
- **Classification and replies:**
  - Every lane lists newest first (#1044, #1057).
  - Replies follow the language of the incoming mail (#1068).
  - Automated senders are demoted from PUSH to QUEUE, and a thread collapses to
    one card (#794).
  - Routine sign-in and confirmation mail goes to QUEUE (#629).
- **Plan limits:** FREE users get upgrade paths instead of bare 403s. A daily
  cap now returns 429 with `DAILY_COST_CAP_FREE` or `DAILY_COST_CAP` instead of
  500 (#1575, #1576, #1577, #1578).
- **LLM pacing and spend:**
  - Background LLM pacing uses the `LLM_BACKGROUND_*`,
    `LLM_RPM_FOREGROUND_RESERVE` and `LLM_USER_RPM` settings (#843, #844).
  - The global daily cost ceiling, `GLOBAL_DAILY_COST_CAP_CENTS`, defaults to
    5000 and persists across restarts (#496, #1004, #1062).
- **Other:**
  - The license changed from MIT to AGPL-3.0 (#493, #494, #731).
  - On self-host and native builds, `/` redirects to `/login` (#716, #719).
  - Legal pages: Anthropic replaces OpenRouter as a subprocessor, and the pages
    now cover the mobile apps, the digest opt-out and a minimum age of 16
    (#1473, #1543, #1579, #1581, #1611).

### Removed
- OpenRouter, its model-catalog tooling and the `model-canary.yml` workflow
  (#506, #516, #519, #520, #524, #723, #1611, #1615, #1616). See Breaking.
- GitHub notifications (#1053) and Slack (#1271).
- The public waitlist endpoint (#1257, #1261).
- `BETA_AUTO_PRO_ENABLED` and `BETA_AUTO_PRO_LIMIT` (#1574).
- The Electron desktop shell (`packages/desktop`); the native macOS app
  replaces it (#569).
- `@klorn/core` (#821, #829, #831).
- Password login for the seeded demo account outside `development` and `test`
  (#804, #832).
- Web rendering of the retired AUTO lane (#1360).

### Fixed
- The action outbox never drained because of a missing `OutboxStatus` enum
  (#559).
- Push notifications:
  - PUSH-judged mail did not push, or the noise filter vetoed it (#522).
  - Duplicate pushes (#562, #576).
  - Notifications are reconciled when a tab resumes (#548).
- Time zones: calendar create, the agent, event parsing and calendar sync used
  Asia/Seoul instead of the user's zone (#758, #763, #765, #1426).
- Gmail sync and connection:
  - An empty INBOX listing no longer deletes the local mirror (#619).
  - An expired Gmail watermark catches up 250 messages (#1258).
  - The Gmail watch heals itself after a reconnect (#1045).
  - Dead Google tokens are no longer retried every tick (#1536).
- Attention items:
  - A manual lane correction no longer reverts after reading or re-judging
    (#1334).
  - Bulk archive left items open (#1397).
  - `GET /api/inbox/summary` returned 500 (#1404).
- Replies:
  - An auto-reply that failed to send was recorded as sent (#1338).
  - Linked-inbox replies and sends now use the right account (#760, #766,
    #785).
  - The web "Later" action posted to a route that did not exist (#1643).
- Gmail attachments were duplicated on every re-sync (#1462). Duplicates
  created before this fix are not cleaned up.
- The MEETING lane filled with bulk and system invites (#1497).
- The judge:
  - It was starved by the call-count cap; BYOK users past the cap now run on
    their own key (#1517).
  - LLM requests had no timeout (#1477).
  - Fenced JSON from fallback models was not parsed (#541).
  - A learned prior could mute a sender without an LLM look (#533).
  - The cost gate charged 0¢ per call (#500).
- IMAP:
  - IMAP-only users saw demo mail (#1436).
  - IMAP bodies were stored as raw MIME (#1468).

### Security
- The api and web container images run as a non-root user (see Breaking).
- Session revocation now applies to password reset and change, logout,
  WebSocket connections, and routes gated only by `getUserId()` (#549, #588,
  #614, #711).
- Login and OAuth:
  - Google login requires a verified email (#573).
  - Closed a pre-registration account takeover through a Google merge (#932).
  - Login CSRF on web sign-in (#1505).
  - Account-link OAuth CSRF (#1451).
  - A pairing code for desktop poll sign-in (#1506).
  - PKCE for desktop and native sign-in (#711, #928).
  - The OAuth state TTL is 10 min, and JWT verification is pinned to HS256
    (#922, #931).
  - An unverified Apple or Naver email can neither attach to an account nor
    create one (#1037).
  - `requireAdmin` requires a verified `ADMIN_EMAILS` address (#1574).
- Prompt injection:
  - Email fields and sender text are wrapped as untrusted, and the wrapper
    cannot be closed from inside the data (#588, #1151, #1345, #1478).
  - The manual-override marker is a database column, so judge text cannot fake
    it (#749, GHSA-cxc5-fmqv-pxv6).
- Event-loop stalls from crafted mail:
  - Text handling is linear-time (#1414, #1466, #1467).
  - Attachments are extracted in a worker thread (#1534, #1535).
  - Inflate and zip-bomb caps (#573).
- SSRF guards:
  - Naver IMAP (#614).
  - Web Push, including DNS rebinding (#802, #849).
  - A shared public-address policy for push and unsubscribe (#1434).
  - Generic IMAP resolves the host once and pins that address (#1356).
- Request hardening:
  - Pub/Sub OIDC tokens are verified (#496).
  - A global error handler, Helmet and CSP (#496, #804, #929).
  - Per-route rate limits and a per-account login lockout (#864, #1081,
    #1082).
  - bcrypt cost 12 (#1096).
  - Querystring schemas (#1084) and a MIME allowlist for attachments (#1085).
  - Reset and verify tokens are stored hashed (#800).
  - `Cache-Control: no-store` (#931).
- Data deletion and privacy:
  - Data deletion covers every user-scoped table, is fenced against work
    already running, and revokes the Google grant with retry (#579, #833,
    #1482, #1498, #1501, #1502, #1510).
  - BYOK keys and URL query strings are scrubbed from Sentry (#922, #1580).
- Row-level security is enabled, not forced, on the public tables. Data API
  grants are revoked where those roles exist (#806, #1015, #1381).
- Dependency advisories (#1007, #1064, #1218, #1314, #1329, #1337, #1347,
  #1394, #1504, #1522, #1606).

### Migrations to watch
- Most migrations only add tables, columns or indexes.
- `20261104120000_drop_openrouter_key` drops `User.openRouterApiKey` (#1615).
- `20261010030000_enable_rls_remaining_tables` takes ACCESS EXCLUSIVE locks.
  See `docs/rls-rollout.md` (#1381).
- `20261019010000_data_wipe_fence` adds the `DataWipe` table and BEFORE INSERT
  triggers on user-data tables (#1501).
- `20261016010000_email_attachment_part_key` adds a unique index on
  `EmailAttachment(emailId, partKey)`. If it fails on `lock_timeout`, run
  `prisma migrate resolve --rolled-back 20261016010000_email_attachment_part_key`
  and redeploy (#1462).
- #800 clears outstanding password-reset and verify tokens, so users have to
  request new links.
- #803 and #1484 build indexes with a plain `CREATE INDEX`. On very large
  tables, build them out of band.

### Desktop and mobile (own tags; not part of the server images)
- macOS:
  - A native SwiftUI app replaced the Electron shell (#569).
  - It opens a standard main window with Today, Mail, Calendar, Files and
    Assistant (#1366, #1371, #1382, #1384, #1385, #1431).
  - PUSH mail and imminent meetings arrive as macOS banners; the floating pill
    was removed (#1439, #1639).
  - Universal build in a DMG, with in-app updates (#969, #982, #1445).
- Windows: a Tauri shell with OS banners, a tray and catch-up of missed
  banners (#972, #973, #1509, #1638, #1644).
- Mobile: a Capacitor shell for iOS and Android with native push and
  system-browser OAuth (#595, #699). It now bundles the app instead of loading
  a WebView (#1463).

## [0.3.0] — 2026-06-09

First release after the firewall doctrine work and the production incident
recovery. Brings versioning back into lockstep across `@klorn/api`,
`@klorn/web`, and `@klorn/core`, all on `0.3.0`.

### Added — Attention Firewall doctrine
- **PR #468** — Content-hash binding on every `AttentionItem`. The classifier
  bytes (from, subject, snippet, labels) are hashed at decision time and
  re-verified at read time, so any post-decision mutation surfaces as
  `AttentionHashMismatchError` instead of silently being trusted.
- **PR #472** — Read-path integration for the hash. Stale tiers are flagged
  via a `hashStale` field, captured to Sentry, and surfaced to the firewall
  view.
- **PR #480** — Deterministic-floor doctrine. `FLOOR_ACTIONS` const +
  `ActionReceipt` schema + sha256 payload-hash helpers for every action whose
  effect cannot be undone with a single user click. Doctrine documented at
  [`docs/doctrine/deterministic-floor.md`](docs/doctrine/deterministic-floor.md).
- **PR #481** — Floor enforcement. `send_email` now throws
  `FloorReceiptRequiredError` without a verified receipt and
  `ActionReceiptMismatchError` if the bytes mutated between approve and
  execute. Receipt is minted at `/approve` time and stored on the
  `PendingAction` row.

### Added — Calendar
- **PR #476** — `formatTime` reads the user's stored IANA timezone instead of
  the browser default; 24-hour rendering throughout.
- **PR #477** — Compact agenda-style layout with inline delete per event.
- **PR #479** — Google-Calendar-style month grid view.
- **PR #482** — `createEvent` returns canonical times from Google's response;
  `tool-executor` writes those (not the raw LLM input). Eliminates the +13h
  shift seen in 2026-06-04 dogfood.

### Added — POC measurement infra
- **PR #470** — Calibration CLI (`pnpm --filter @klorn/api calibration`) for
  Day 14+7 retention measurement. Reads `AttentionItem` rows + `FeedbackEvent`
  overrides and emits per-tier confidence stats, override rate, ground-truth
  accuracy, and a drift signal. No LLM calls; safe to schedule.

### Added — Cron + provider hygiene
- **PR #467** — External cron entrypoint (`/api/cron/briefing-tick`) with
  timing-safe `BRIEFING_CRON_SECRET` so Render Free dynos can be woken by
  cron-job.org without violating Render's keepalive policy.
- **PR #471** — Vision-model default ends in `:free`; startup warns loud when
  any of `CHAT_MODEL` / `AGENT_MODEL` / `VISION_MODEL` is set to a
  vendor-prefixed paid ID.
- **PR #485 / PR #486** — Failover walks the free-model chain on OpenRouter
  before giving up the provider.

### Fixed
- **PR #466** — Guard `invalidateGoogleToken` against non-prod env writes
  after a script run wiped the founder's prod token row.
- **PR #487** — Emergency `BACKGROUND_AGENTS_DISABLED` kill switch +
  removed duplicate `preDeployCommand` that doubled the Render deploy hang
  window. Shipped during the 2026-06-05 Google Cloud billing incident.

### Changed
- `/api/health` now reports `version` from `packages/api/package.json` so
  operators can identify which release a container is running without
  decoding the commit hash.

### Known follow-ups (tracked, not in this release)
- Cost-gate gap for system calls (`createCompletion` callers that omit
  `userId`) — the 2026-06-05 incident root cause. Tracked separately.
- Issue #488 — read-refusal class as anti-surveillance gate. Marker only
  until the first triggering tool ships.

## Older history

Pre-0.3.0 history is captured in git tags `v0.1.4` … `v0.2.1` and in the
merged PR list. Versioning fell out of sync with `package.json` files during
the 2026-04 → 2026-06 sprint; this release re-aligns them.
