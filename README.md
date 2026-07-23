# Klorn

> **An attention firewall for your inbox. Not a suggestion engine.**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Self-hosted](https://img.shields.io/badge/deploy-self--hosted-success.svg)](docs/self-hosting.md)
[![Version](https://img.shields.io/badge/version-v0.3.0-blue.svg)](CHANGELOG.md)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

Every other AI inbox tool *adds* a surface — a suggestion card next to each email, a badge that says "AI thinks you should reply," a draft waiting for review. The inbox gets louder, not quieter.

Klorn does the opposite. Each inbound email gets exactly **one** classification — `SILENT` / `QUEUE` / `PUSH` / `AUTO` — bound to the exact bytes that produced it. No chat surface. No suggestion cards. No 60-tool agent. The output is a single decision, and most of the time that decision is "you don't need to see this."

**[Read the doctrine](docs/doctrine/deterministic-floor.md) before the code — that's the actual product.**

[![Klorn — 31-second demo](website/media/klorn-demo-poster.jpg)](website/media/klorn-demo.mp4)

▶️ **[31-second demo](website/media/klorn-demo.mp4)** · 🎬 **[14-second promo](website/media/klorn-promo.mp4)** · 🌐 **[Live demo on klorn.ai](https://klorn.ai)** · 📖 **[Editions](docs/EDITIONS.md)** · 📋 **[CHANGELOG](CHANGELOG.md)**

## The four tiers

| Tier | What it means | What happens |
| --- | --- | --- |
| **`SILENT`** | Recorded, never rendered | The row exists for ground-truth feedback; you never see it. (marketing, receipts, FYI) |
| **`QUEUE`** | Review on your own schedule | Visible in the queue. No push, no notification. *This is the default.* |
| **`PUSH`** | Worth interrupting you | A notification fires. Optionally Telegram or one phone call. |
| **`AUTO`** | Reversible, hands-off | Classified today; the action side sits behind a deterministic floor (below). |

## How it decides — and why a cheap model runs it

The LLM does **not** pick the tier. On every email it scores four features between 0 and 1 — `confidence`, `senderTrust`, `reversibility`, `urgency` — and a deterministic rule in [`tier-policy.ts`](packages/api/src/judge/tier-policy.ts) maps those four numbers to a tier. The model perceives; a rule you can read and unit-test decides. The policy is auditable without the model in the loop.

Two consequences fall out of that split:

- **A cheap model wins.** When the model only has to read four signals consistently, you don't need a frontier model's reasoning depth. On the committed 50-email gate set ([`eval/judge-eval-set.json`](packages/api/eval/judge-eval-set.json)), `gemini-2.5-flash` scores **88%** with 100% recall on urgent mail — beating `gpt-4o` and `gemini-2.5-pro` (both 82%) at a fraction of the cost. Run it yourself: `pnpm eval:judge`.
- **Measured on real mail, not just synthetic.** A second committed set ([`eval/real-eval-set.json`](packages/api/eval/real-eval-set.json)) holds 53 real, hand-labeled, PII-scrubbed emails with per-sender context snapshots from the production learning loop. Current score: **50/53 (94.3%) overall, 95.5% precision on silenced mail** — when Klorn hides something, it is almost never something you wanted. (Honest caveats: one inbox's ground truth so far, and the urgent tier has only 4 labeled samples, so its floor stays report-only until support grows. Full measurement history: [`eval/README.md`](packages/api/eval/README.md).)
- **It fails open, safely — and heals.** If the LLM is down or rate-limited, a keyword fallback produces the same four features with zero model calls, so urgent mail still gets through. When the provider recovers, a bounded background sweep re-judges the degraded verdicts through the real pipeline — decisions you already touched are never rewritten.

Every classification is **content-hash-bound**: the exact bytes the scorer read (`from`, `subject`, `snippet`, `labels`) are sha256'd at decision time and stored with the row. The read path re-hashes and throws `AttentionHashMismatchError` on mismatch, so a later enrichment can't silently invalidate a tier ([PR #468](https://github.com/k08200/klorn/pull/468)).

### It learns from what you do — not what you say

- **Two identical corrections make a rule.** Move the same sender to the same tier twice and that sender becomes deterministic — the LLM is skipped. Deliberately asymmetric: a learned pattern may promote mail to `PUSH`/`QUEUE`, but nothing learned can ever auto-`SILENT` a sender — a stale pattern must never mute someone where you can't see it to correct it.
- **Reading is a signal.** Klorn measures your per-sender read rate straight from Gmail read state — no in-app clicks required. A sender you open every time stops getting buried as "marketing"; one you open 4% of the time stops cluttering your queue. On the real-mail set, this single signal recovered every wrongly-silenced sender the labeler actually reads.
- **Every correction is ground truth.** Tier moves land in an append-only decision ledger (shown tier, feature vector, your correction) that regenerates the eval set — so the accuracy above is re-measured against real behavior, not a frozen benchmark.

## The deterministic floor

Three actions can't be undone with one user click — `send_email`, `permanent_delete`, `forward_external`. These don't ride on classifier confidence. They require an `ActionReceipt` minted at `/approve` time that pins the payload bytes (a sha256 over the canonical recipient/subject/body), verified at execute time — any drift throws and the action is refused ([PR #480](https://github.com/k08200/klorn/pull/480), [#481](https://github.com/k08200/klorn/pull/481), [doctrine](docs/doctrine/deterministic-floor.md)).

It's enforced, not aspirational: a central guard in `executeToolCall` fails closed on any floor action that arrives without a verified receipt, so even the autonomous path can't side-step approval to send, forward, or hard-delete. Today `send_email` is the wired callable case; the other two are guarded fail-closed until their cases land. The autonomous agent itself defaults to **SUGGEST** mode — read-only tools plus propose-only — and only gets mutating power when you explicitly opt into AUTO.

## Read the thinking

Three writeups walk through the architecture, with the tradeoffs and the honest edges:

1. [I let GPT-4o and a cheaper model fight over my inbox. GPT-4o lost.](https://dev.to/k08200/i-let-gpt-4o-and-a-cheaper-model-fight-over-my-inbox-gpt-4o-lost-fkj) — the model bake-off
2. [I don't trust the LLM to classify my email. So I don't let it.](https://dev.to/k08200/i-dont-trust-the-llm-to-classify-my-email-so-i-dont-let-it-55d9) — feature-scorer vs. decider
3. [Confidence is enough to decide. It's not enough to do.](https://dev.to/k08200/confidence-is-enough-to-decide-its-not-enough-to-do-8ck) — the deterministic floor

## What it's NOT

- **Not finished.** This is an early PoC with one real user (me); ICP retention measurement is what's happening now. The [CHANGELOG](CHANGELOG.md) is honest about what's solid vs. what's stitched.
- **Not a "chat with your inbox" thing.** There is no chat surface.
- **Not multi-tenant cloud.** Self-host is the only path right now.
- **Not feature-gated against open source.** [`docs/EDITIONS.md`](docs/EDITIONS.md) lists what Cloud will sell on top (managed hosting, verified Gmail scope, team workspaces) — the firewall doctrine and code stay in the repo on both editions.

> **Why is a CI check red?** `Scope Budget` fails *on purpose*. It's a self-imposed ratchet that trips when a change grows the route / page / schema surface past a fixed budget, forcing a conscious "yes, this scope is worth it" instead of silent sprawl. A red Scope Budget is by design, not a broken build — every other check (lint, types, tests, build, security, eval) is green.

## Trying the hosted demo (klorn.ai)

The hosted demo runs in **Google OAuth testing mode** while we hold off on CASA Tier 2 verification (Klorn uses Gmail's restricted `gmail.modify` scope). To try it without self-hosting, you have to be added as a test user first. Three paths, fastest first:

- **Open an issue** with the Google email you want to use: [new oauth-tester issue](https://github.com/k08200/klorn/issues/new?title=oauth-tester&labels=oauth-tester) — we add you, comment "added", you log in.
- **Email** `k0820086@gmail.com` with the same info.
- **Or skip the gating entirely** and [self-host](#local-development) — full feature parity, you bring your own Google OAuth credentials, no verification needed.

Google caps test-user slots at 100 in this mode. Once CASA verification ships (gated on PoC retention measurement), the OAuth screen flips to production and the gating goes away. **For most people landing here, self-host is the fastest way in.**

## What we're building

Klorn's first screen is not a chat or an inbox — it's a decision queue. Scattered signals are collected and presented as cards that answer three questions: **what to look at**, **why it matters**, and **what action is ready**.

- **Decision queue** — pending approvals, the commitment ledger, today's risks
- **Mail** — priority, reply-needed flags, attachment and candidate signals
- **Calendar** — meeting readiness, conflicts, context for what's next
- **Briefing** — a daily summary of top signals and recommended actions
- **Settings** — Google connections, notifications, execution boundaries, model and data controls

## Product principles

- **Approval before action** — sending mail, changing the calendar, or pushing externally requires a clear confirmation step.
- **Evidence-based automation** — every suggestion shows the signal, the reasoning, and the staged action.
- **Progressive trust** — Klorn starts in observe-and-suggest mode and earns more autonomy through your feedback.
- **The empty state is the product** — even before any connection, the next step should be obvious.
- **One clear signal** — the name *Klorn* comes from the Germanic *klar* (clear) and the Old English *horn* (a signal worth answering).

## Tech stack

| Layer | Stack |
| --- | --- |
| Web | Next.js 15, React 19, TypeScript, Tailwind CSS |
| API | Fastify, TypeScript, Prisma |
| DB | PostgreSQL |
| Auth | JWT, bcrypt, Google OAuth |
| AI | OpenAI-compatible (local-first), OpenRouter / Gemini failover |
| Realtime | WebSocket, Web Push |
| Billing | Stripe |
| Monorepo | pnpm workspaces |

```text
packages/
  api/          Fastify API, Prisma schema, agent/tool orchestration
  web/          Next.js app: decision queue, mail, calendar, briefing, settings
  core/         shared utilities and CLI-facing primitives
apps/
  desktop-mac/  native macOS app — the always-on top-bar firewall (SwiftUI)
  mobile/       Capacitor shell (iOS / Android)
docs/           doctrine, screenshots, operational notes
```

## Native macOS app

A real native SwiftUI client that lives as a **custom always-on bar pinned to the
top of your screen** — a slim pill that expands into the firewall and never
steals focus from what you're working in. Real-time over the existing WebSocket
hub. What it does today:

- **Ambient by default** — the pill hides behind a menu-bar icon with one click
  and comes back on a global shortcut you record yourself (default `⌥⌘K`); a
  `PUSH` card is the only thing allowed to surface on its own.
- **Act without the browser** — read the full email inline, Open / Snooze /
  Dismiss, and **one-click tier corrections** that teach the firewall from
  exactly where you live.
- **A day at a glance** — TODAY calendar column beside the queue, Klorn's
  summary on every push card, and a daily AI-usage gauge in ACCOUNT.
- Launch-at-login, in-app update check, and a Gatekeeper-verified release
  pipeline.

```bash
cd apps/desktop-mac
KLORN_API_URL=https://klorn-api.onrender.com swift run KlornMac   # or plain `swift run KlornMac` for local dev
```

See [`apps/desktop-mac/README.md`](apps/desktop-mac/README.md) for the full guide
(sign-in, hotkey, packaging a double-clickable `Klorn.app`, tests).

## Self-hosting

Self-host is the primary way to run Klorn today: full feature parity, your own Google OAuth client (no test-user cap, no verification needed — it's your account on your client), your own Postgres, your own LLM keys or a fully local model. Two paths:

- **Deploy to Render** — the repo's [`render.yaml`](render.yaml) blueprint deploys the API; pair it with a free Postgres and a Vercel web deploy.

  [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/k08200/klorn)

- **Docker Compose** — [`docker-compose.selfhost.yml`](docker-compose.selfhost.yml) runs postgres + api + web on one box, migrations included.

The complete guide (OAuth client setup, env reference, real-time Gmail push, updating) is **[docs/self-hosting.md](docs/self-hosting.md)**.

## Local development

### Requirements

- Node.js 22+
- pnpm
- PostgreSQL 16 (recommended)

### Install

```bash
git clone https://github.com/k08200/klorn.git
cd klorn
pnpm install
```

### Environment files

Klorn reads **two** env files in local dev. Both need to exist before the database container will even start.

**1. Root `.env`** — used by docker-compose to interpolate required vars into the postgres + api services. Without it, `docker compose up -d postgres` fails with `required variable JWT_SECRET is missing a value`.

```bash
cp .env.example .env
```

Generate a 32-byte base64 key for `TOKEN_ENCRYPTION_KEY` and paste it into the root `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**2. API `.env`** — the actual runtime env for the Fastify server.

```bash
cp packages/api/.env.example packages/api/.env
```

Open `packages/api/.env` and at minimum set:

```bash
DATABASE_URL="postgresql://klorn:klorn-local-dev@localhost:5432/klorn"
OPENROUTER_API_KEY=""  # https://openrouter.ai/keys — a free key works (or go fully local, below)
WEB_URL="http://localhost:8001"
PORT=8000
```

`JWT_SECRET` and `TOKEN_ENCRYPTION_KEY` are optional in dev — the server falls back to insecure defaults with a warning. Set them if you want the same dev cookies/tokens across restarts.

#### Google OAuth (Gmail + Calendar)

To sync mail you bring your own OAuth client — no Google verification or CASA needed for self-host, since you stay the app's owner and sole user.

1. [Google Cloud Console](https://console.cloud.google.com/) → create (or pick) a project.
2. **APIs & Services → Library** → enable **Gmail API** and **Google Calendar API**.
3. **OAuth consent screen** → User type **External** → fill the basics → under **Test users**, add the Google account you'll log in with. (Unverified apps only work for accounts on the test-user list — that's the 100-slot cap, and it's why self-host has no verification step: it's *your* account on *your* client.)
4. **Scopes**: add `gmail.modify` and `calendar` (Klorn reads mail and writes tier labels; see [`scope-justification.md`](docs/google-oauth-verification/scope-justification.md)).
5. **Credentials → Create credentials → OAuth client ID → Web application.** Set the **Authorized redirect URI** to `http://localhost:8000/api/auth/google/callback` (match your API port and `GOOGLE_REDIRECT_URI`).
6. Copy the client ID and secret into `packages/api/.env`:

```bash
GOOGLE_CLIENT_ID="...apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="..."
GOOGLE_REDIRECT_URI="http://localhost:8000/api/auth/google/callback"
```

### Local LLM (keep your email on your machine)

Klorn speaks to any OpenAI-compatible endpoint. Point it at a local server (Ollama, LM Studio, vLLM, llama.cpp) and email classification runs against it **first** — cloud keys, if configured at all, are failover only:

```bash
OPENAI_COMPAT_BASE_URL="http://localhost:11434/v1"  # Ollama default
OPENAI_COMPAT_MODEL="qwen3:8b"
```

With no cloud keys set, Klorn is fully local. See `.env.example` for `OPENAI_COMPAT_PRIORITY` and the other knobs.

### Database

The bundled docker-compose ships a Postgres 16 with the credentials the default `DATABASE_URL` expects. If you have a Postgres already on `5432`, either stop it or change the port mapping in `docker-compose.yml` and update `DATABASE_URL`.

```bash
docker compose up -d postgres
pnpm --filter @klorn/api exec prisma migrate deploy
pnpm --filter @klorn/api exec prisma generate
```

`migrate deploy` is the non-interactive path. `migrate dev` would prompt for a migration name on first run, which is friction in a smoke test.

### Dev servers

Terminal 1 — API:

```bash
pnpm --filter @klorn/api dev
```

Wait for `Server listening at http://127.0.0.1:8000` (can take 5–10s while background imports load — silence in between is normal). Verify in another terminal:

```bash
curl http://localhost:8000/api/health
# → {"status":"ok","db":"connected","version":"0.3.0",...}
```

Terminal 2 — Web:

```bash
NEXT_PUBLIC_API_URL=http://localhost:8000 pnpm --filter @klorn/web dev
```

Default ports: API `8000`, Web `8001`. If either is taken — common collision is another Postgres on `5432`, or a Docker gateway on `8000` — override:

```bash
# API on 8002
PORT=8002 pnpm --filter @klorn/api dev

# Web on 8003 pointing at the moved API
NEXT_PUBLIC_API_URL=http://localhost:8002 \
  pnpm --filter @klorn/web exec next dev --port 8003
```

Open `http://localhost:8001` (or your override) — you should see the Klorn landing page.

### Telegram notifications (optional)

PUSH-tier interrupts can also be delivered to Telegram — useful when you self-host without web-push (VAPID) configured. Bring your own bot:

1. Open [@BotFather](https://t.me/BotFather), send `/newbot`, and follow the prompts. Note the **bot token** and **bot username**.
2. Set the env vars on the API:

```bash
TELEGRAM_BOT_TOKEN="123456:your-botfather-token"
TELEGRAM_BOT_USERNAME="your_bot_username"   # without the @
TELEGRAM_WEBHOOK_SECRET="$(openssl rand -hex 32)"
```

3. Register the webhook (the API must be reachable over HTTPS):

```bash
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=https://your-api-host/api/telegram/webhook" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

4. Link your account: call `POST /api/telegram/link` with your Klorn bearer token — it returns a one-time code (10-minute expiry) and a `https://t.me/<bot>?start=<code>` deep link. Open the link and hit Start.

PUSH-tier messages arrive with **Move to Queue** / **Silence** buttons (the same manual tier override as the firewall UI, so your taps feed the classifier's ground truth) plus an **Open Klorn** link. `DELETE /api/telegram/link` unlinks. The webhook rejects requests that don't carry the `X-Telegram-Bot-Api-Secret-Token` header matching your secret.

## Docker

Run the full stack with the required secrets in the root `.env`:

```bash
docker compose up --build
```

Docker Compose ports: Web `3000`, API `3001`, PostgreSQL `5432`.

## Common commands

```bash
pnpm --filter @klorn/web build
pnpm --filter @klorn/api build
pnpm --filter @klorn/api test
pnpm eval:judge   # run the 4-tier classifier against the committed gate set
packages/api/node_modules/.bin/biome check packages/
```

## Phone escalation (optional, off by default)

If a PUSH-tier notification sits unacknowledged for 5 minutes, Klorn can place **one** plain text-to-speech phone call (press 1 to repeat, press 2 to acknowledge). No AI on the line — it's the PagerDuty/GoAlert escalation pattern applied to your inbox. Bring your own Twilio account:

```bash
PHONE_ESCALATION_ENABLED=true
TWILIO_ACCOUNT_SID="ACxxxxxxxx"
TWILIO_AUTH_TOKEN="..."
TWILIO_FROM_NUMBER="+15555550000"   # a voice-capable Twilio number you own
PUBLIC_URL="https://your-api.example.com"  # Twilio must reach /api/phone/gather
```

Each user must additionally opt in (`AutomationConfig.phoneEscalationEnabled`) and have a phone number on file. Hard rails, none configurable away: at most **one call per notification ever**, a per-user daily cap (default 3, `PHONE_ESCALATION_DAILY_CAP`), a 10-minute cooldown, and **quiet hours always win — there is no urgency bypass.** Klorn will never ring you at 3 a.m.; that's the whole point of an attention firewall.

Cost reality: every escalation call costs real money — roughly **$0.02–0.06 per call** depending on destination (US ≈ $0.014/min, Korea and most of Asia/EU more). The daily cap bounds worst-case spend. Korean numbers: Twilio outbound to +82 may display an international caller ID and can be filtered by carrier spam apps — test with your own number first.

## Deployment notes

- **Vercel Web**: set `NEXT_PUBLIC_API_URL` to the deployed API URL.
- **API**: set `DATABASE_URL`, `JWT_SECRET`, `TOKEN_ENCRYPTION_KEY`, `WEB_URL`, and `CORS_ORIGINS` for the target environment.
- The Google OAuth redirect URI must point to the API's `/api/auth/google/callback`.
- For Neon or other serverless Postgres, use the PgBouncer connection options from `.env.example`.

## QA flows

When touching core UX, verify at least:

- **Founder** — see a pending approval card in the decision queue and accept/reject it through to completion.
- **Sales** — mail list, mail detail, reply draft, and attachment signals render correctly.
- **Ops** — calendar readiness and briefing surface the right context.
- **Mobile** — the decision queue, mail, and top/bottom nav work at 390px width.
- **New user** — pre-connection state, initial learning hint, and the first settings screen are clear.

## Contributing

Issues and pull requests are welcome. For anything non-trivial, open an issue first to discuss the approach. Run `pnpm -r test` and `biome check packages/` before submitting.

## Security

Klorn treats email as hostile input — prompt injection is in scope, and the deterministic floor keeps irreversible actions out of the LLM's reach entirely: see [SECURITY.md](SECURITY.md) for the trust model and how to report a vulnerability.

## License

[AGPL-3.0](LICENSE). You are free to use, self-host, and modify Klorn. If you run a modified version as a network service, the AGPL requires you to offer your modified source to that service's users. Copyright (C) 2026 k08200.
