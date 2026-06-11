# Klorn

> **An attention firewall for your inbox. Not a suggestion engine.**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Self-hosted](https://img.shields.io/badge/deploy-self--hosted-success.svg)](#docker)
[![Version](https://img.shields.io/badge/version-v0.3.0-blue.svg)](CHANGELOG.md)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

Most AI assistants surface more — another card, another badge, another "AI thinks you should…" Klorn ships the opposite: a **single classification output** (`SILENT` / `QUEUE` / `PUSH` / `AUTO`) bound to the exact bytes that produced it. No suggestion surface. No autonomous send. No 60-tool agentic spread.

**Read the [doctrine](docs/doctrine/deterministic-floor.md) before the code.** That's the actual product.

![Klorn decision queue](packages/web/public/klorn-demo-poster.jpg)

▶️ **[60-second walkthrough](packages/web/public/klorn-walkthrough.mp4)** · 📖 **[Editions / open-core boundary](docs/EDITIONS.md)** · 📋 **[CHANGELOG v0.3.0](CHANGELOG.md)**

## Why this exists

The pattern almost every AI inbox tool ships into: a new surface on top of the old surface. A suggestion card next to every email. A badge that says "AI thinks you should reply." A draft waiting for your review. The inbox got louder, not quieter — the work of judging got moved from the mail itself to the mail-plus-AI-suggestions.

Klorn refuses to surface. The classifier emits exactly one of four tiers:

- **`SILENT`** — the row exists but is not rendered. Recorded for ground-truth feedback, not displayed.
- **`QUEUE`** — visible in the inbox queue. No push, no notification.
- **`PUSH`** — wake the user. Send a notification. Limited.
- **`AUTO`** — classification only today; the action side is gated behind a deterministic floor (see below).

Every classification is **content-hash-bound**: the exact bytes the scorer read (`from`, `subject`, `snippet`, `labels`) are sha256'd at decision time and stored with the row. The read path re-hashes and throws `AttentionHashMismatchError` on mismatch. A future enrichment PR cannot silently invalidate trust in a tier ([PR #468](https://github.com/k08200/klorn/pull/468)).

Three actions cross the **deterministic floor** — anything that can't be undone with one user click: `send_email`, `permanent_delete`, `forward_external`. These require an `ActionReceipt` minted at `/approve` time, pinning the payload bytes. Verify-or-throw at execute. The autonomous agent's direct invocation path fails closed. ([PR #480](https://github.com/k08200/klorn/pull/480), [PR #481](https://github.com/k08200/klorn/pull/481), [doctrine doc](docs/doctrine/deterministic-floor.md)).

## What it's NOT

- Not finished. POC sprint just hit Day 14; ICP retention measurement starts now. The [CHANGELOG](CHANGELOG.md) is honest about what's solid vs what's stitched.
- Not a "chat with your inbox" thing. There is no chat surface.
- Not multi-tenant cloud. Self-host is the only path right now.
- Not feature-gated against open source. See [`docs/EDITIONS.md`](docs/EDITIONS.md) for what Cloud will sell on top (managed hosting, verified Gmail scope, team workspaces) — the firewall doctrine and code stay in the repo on both editions.

## Trying the hosted demo (klorn.ai)

The hosted demo is **in Google OAuth testing mode** while we hold off on CASA Tier 2 verification (we use Gmail's restricted `gmail.modify` scope). To try it without self-hosting, you need to be added as a test user first.

Three paths, fastest first:

- **Open an issue** with the Google email you want to use: [github.com/k08200/klorn/issues/new?title=oauth-tester](https://github.com/k08200/klorn/issues/new?title=oauth-tester&labels=oauth-tester) — we add you, comment "added", you log in.
- **Email** `k0820086@gmail.com` with the same info.
- **Or skip the gating entirely** and [self-host](#quick-start) — full feature parity, you bring your own Google OAuth credentials, no verification needed.

Google caps test-user slots at 100 in this mode. Once we ship CASA verification (gated on POC retention measurement), the OAuth screen flips to production and the gating goes away.

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

## Core flow

1. Sign in with email or connect Google.
2. The API ingests signals from Gmail, Calendar, and work context.
3. Classifiers and agents extract reply-needed mail, commitments, risks, and people signals.
4. The web app surfaces only the next action you need in the decision queue, mail, calendar, and briefing.
5. Your approvals, rejections, and feedback feed back into the policy that decides what to surface next.

## Tech stack

| Layer | Stack |
| --- | --- |
| Web | Next.js 15, React 19, TypeScript, Tailwind CSS |
| API | Fastify, TypeScript, Prisma |
| DB | PostgreSQL |
| Auth | JWT, bcrypt, Google OAuth |
| AI | OpenRouter, Gemini fallback |
| Realtime | WebSocket, Web Push |
| Billing | Stripe |
| Monorepo | pnpm workspaces |

## Structure

```text
packages/
  api/   Fastify API, Prisma schema, agent/tool orchestration
  web/   Next.js app: decision queue, mail, calendar, briefing, settings
  core/  shared utilities and CLI-facing primitives
docs/    screenshots and operational notes
```

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

**1. Root `.env`** — only used by docker-compose to interpolate required vars
into the postgres + api services. Without it, `docker compose up -d postgres`
fails with `required variable JWT_SECRET is missing a value`.

```bash
cp .env.example .env
```

Generate a 32-byte base64 key for `TOKEN_ENCRYPTION_KEY` and paste it into
the root `.env`:

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
OPENROUTER_API_KEY=""  # https://openrouter.ai/keys — free key works
WEB_URL="http://localhost:8001"
PORT=8000
```

`JWT_SECRET` and `TOKEN_ENCRYPTION_KEY` are optional in dev — the server
falls back to insecure defaults with a warning. Set them if you want
the same dev cookies/tokens across restarts.

For Google integration also set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI`.

### Local LLM (keep your email on your machine)

Klorn speaks to any OpenAI-compatible endpoint. Point it at a local
server (Ollama, LM Studio, vLLM, llama.cpp) and email classification
runs against it **first** — cloud keys, if configured at all, are
failover only:

```bash
OPENAI_COMPAT_BASE_URL="http://localhost:11434/v1"  # Ollama default
OPENAI_COMPAT_MODEL="qwen3:8b"
```

With no cloud keys set, Klorn is fully local. See `.env.example` for
`OPENAI_COMPAT_PRIORITY` and the other knobs.

### Database

The bundled docker-compose ships a Postgres 16 with the credentials the
default `DATABASE_URL` expects. If you have a Postgres already listening
on `5432`, either stop it or change the port mapping in
`docker-compose.yml` and update `DATABASE_URL` accordingly.

```bash
docker compose up -d postgres
pnpm --filter @klorn/api exec prisma migrate deploy
pnpm --filter @klorn/api exec prisma generate
```

`migrate deploy` is the non-interactive path. `migrate dev` would prompt
for a migration name on first run, which is friction in a smoke test.

### Dev servers

Terminal 1 — API:

```bash
pnpm --filter @klorn/api dev
```

Wait for `Server listening at http://127.0.0.1:8000` (can take 5–10s
while background imports load — silence in between is normal). Verify
the server is alive in a third terminal:

```bash
curl http://localhost:8000/api/health
# → {"status":"ok","db":"connected","version":"0.3.0",...}
```

Terminal 2 — Web:

```bash
NEXT_PUBLIC_API_URL=http://localhost:8000 pnpm --filter @klorn/web dev
```

Default ports: API `8000`, Web `8001`. If either is taken on your
machine — common collision is another Postgres on `5432`, or a Docker
gateway on `8000` — override:

```bash
# API on 8002
PORT=8002 pnpm --filter @klorn/api dev

# Web on 8003 pointing at the moved API
NEXT_PUBLIC_API_URL=http://localhost:8002 \
  pnpm --filter @klorn/web exec next dev --port 8003
```

Open `http://localhost:8001` (or your override) — you should see the
Klorn landing page.

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
packages/api/node_modules/.bin/biome format packages/
packages/api/node_modules/.bin/biome check packages/
```

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

Issues and pull requests are welcome. For anything non-trivial, open an issue first
to discuss the approach. Run `pnpm -r test` and `biome check packages/` before
submitting.

## License

[AGPL-3.0](LICENSE). You are free to use, self-host, and modify Klorn. If you run a
modified version as a network service, the AGPL requires you to offer your modified
source to that service's users. Copyright (C) 2026 k08200.
