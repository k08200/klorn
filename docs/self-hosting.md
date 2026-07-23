# Self-hosting Klorn

Klorn is AGPL-3.0 open source, and self-hosting is a first-class path — not a
degraded one. Full feature parity with the hosted product.

## Why self-host

- **Your data stays yours.** Mail bodies, classifications, and OAuth tokens
  live in *your* Postgres, encrypted with *your* key. With a local LLM
  configured (below), email content never leaves your machine at all.
- **No Google test-user cap.** The hosted demo runs in OAuth testing mode and
  Google caps it at 100 test users. When you self-host, **you create your own
  Google OAuth client** — you are the app's owner and (usually) its only
  user, so no verification, no CASA audit, and no cap applies to you.
- **AGPL keeps it honest.** You are free to run, modify, and redistribute. If
  you run a modified Klorn as a service for others, the AGPL requires
  offering them your modified source.

## Prerequisites

### 1. Your own Google OAuth client (Gmail + Calendar)

1. [Google Cloud Console](https://console.cloud.google.com/) → create (or
   pick) a project.
2. **APIs & Services → Library** → enable **Gmail API** and **Google
   Calendar API**.
3. **OAuth consent screen** → User type **External** → fill the basics →
   under **Test users**, add the Google account(s) you'll log in with.
4. **Scopes** — Klorn's login flow requests exactly these 8 (why each one is
   needed: [`docs/oauth-verification/scope-justifications.md`](oauth-verification/scope-justifications.md);
   the authoritative scope arrays are in
   [`packages/api/src/mail/gmail.ts`](../packages/api/src/mail/gmail.ts)):

   | Scope | Used for |
   | --- | --- |
   | `openid` | Sign-in |
   | `.../auth/userinfo.email` | Account identity |
   | `.../auth/userinfo.profile` | Account display |
   | `.../auth/gmail.readonly` | Reading mail to classify it |
   | `.../auth/gmail.send` | Sending only user-approved replies |
   | `.../auth/gmail.modify` | Tier labels, read-state, archive, reversible trash |
   | `.../auth/calendar.events` | Approved event create/update + meeting context |
   | `.../auth/calendar.readonly` | Free/busy conflict detection across all calendars |

5. **Credentials → Create credentials → OAuth client ID → Web
   application.** Authorized redirect URI = your API origin +
   `/api/auth/google/callback` (e.g. `http://localhost:3001/api/auth/google/callback`).
6. Keep the client ID + secret for the env config below.

### 2. An LLM provider (one of three)

- **OpenRouter key** — [openrouter.ai/keys](https://openrouter.ai/keys); a
  free key works with the default free-model configuration.
- **Gemini API key** — used as failover (or standalone).
- **Fully local** — any OpenAI-compatible endpoint (Ollama, LM Studio,
  vLLM): set `OPENAI_COMPAT_BASE_URL` + `OPENAI_COMPAT_MODEL` and no email
  content leaves your machine.

## Path 1 — Deploy to Render (managed, free tier)

The repo's [`render.yaml`](../render.yaml) is a Render Blueprint for the API:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/k08200/klorn)

The blueprint defines the **API service only** — you bring a Postgres and
deploy the web app separately (Vercel free tier is the tested path, via the
repo's [`vercel.json`](../vercel.json)).

1. **Create a Postgres first** (Render Postgres free tier, or
   [Neon](https://neon.tech) — for Neon use the PgBouncer options shown in
   [`.env.example`](../.env.example)). Copy its connection string.
2. Click the button. Render prompts for every `sync: false` env var; the
   table below says what to enter. Vars you don't use can be left empty.
3. Deploy the web app on Vercel with `NEXT_PUBLIC_API_URL` set to the
   Render API URL, then set `WEB_URL` / `CORS_ORIGINS` /
   `GOOGLE_REDIRECT_URI` on the API to match.

Migrations run automatically on boot
([`packages/api/scripts/start.sh`](../packages/api/scripts/start.sh) runs
`prisma migrate deploy` with cold-start retry before starting the server).

### Environment variables (names verified against the API source)

Required — the API won't boot, or won't log in, without these:

| Env var | Purpose | Read in |
| --- | --- | --- |
| `DATABASE_URL` | Postgres connection string | `packages/api/src/db.ts` |
| `JWT_SECRET` | Session JWT signing; boot **fails closed** if unset outside dev/test | `packages/api/src/auth.ts` |
| `TOKEN_ENCRYPTION_KEY` | AES-256-GCM key (base64, exactly 32 bytes) for OAuth tokens at rest; boot **fails closed** if unset outside dev/test | `packages/api/src/crypto-tokens.ts` |
| `GOOGLE_CLIENT_ID` | Your OAuth client | `packages/api/src/mail/gmail.ts` |
| `GOOGLE_CLIENT_SECRET` | Your OAuth client | `packages/api/src/mail/gmail.ts` |
| `GOOGLE_REDIRECT_URI` | Must exactly match the OAuth client's redirect URI | `packages/api/src/mail/gmail.ts` |
| `WEB_URL` | Where OAuth redirects send the browser back | `packages/api/src/routes/auth.ts` |
| `CORS_ORIGINS` | Allowed browser origins (comma-separated). Production **fails closed** to klorn.ai origins only when unset — your web origin must be listed | `packages/api/src/index.ts` |
| one of `OPENROUTER_API_KEY` / `GEMINI_API_KEY` / `OPENAI_COMPAT_BASE_URL` | LLM provider for the classifier | `packages/api/src/providers/index.ts` |
| `NEXT_PUBLIC_API_URL` | *(web app, build-time)* URL browsers use to reach the API | `packages/web` build |

Useful optional vars (full tuning catalog with defaults:
[`packages/api/src/config.ts`](../packages/api/src/config.ts) and
[`.env.example`](../.env.example)):

| Env var | Purpose |
| --- | --- |
| `GMAIL_PUBSUB_TOPIC` | Real-time Gmail push (see below). Unset = polling fallback |
| `GMAIL_PUSH_OIDC_EMAIL` or `GMAIL_PUSH_TOKEN` | Auth for the Pub/Sub push endpoint (OIDC preferred) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_EMAIL` | Web Push notifications |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_BOT_USERNAME` / `TELEGRAM_WEBHOOK_SECRET` | PUSH-tier delivery to Telegram |
| `ADMIN_EMAILS` | Comma-separated operator emails with admin access |
| `JUDGE_MODEL` / `CHAT_MODEL` / `AGENT_MODEL` | Model pins (defaults stay on free models for keyless/cheap operation) |
| `DAILY_COST_CAP_CENTS` | Per-user daily LLM spend cap (default 100 = $1/day) |
| `KEEPALIVE_URL` | Free-dyno keepalive ping target (Render free tier sleeps) |

## Path 2 — Docker Compose (one box, everything included)

[`docker-compose.selfhost.yml`](../docker-compose.selfhost.yml) runs the full
stack: Postgres 16, the API (Fastify + Prisma), and the web app (Next.js).

```bash
git clone https://github.com/k08200/klorn.git
cd klorn
cp .env.selfhost.example .env.selfhost
# Fill in .env.selfhost: postgres password, JWT secret, encryption key,
# your Google OAuth client, and one LLM provider.
docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml up -d --build
```

Open `http://localhost:3000`. The API is on `:3001`; Postgres stays internal
to the compose network (not published to the host).

Notes:

- **Schema is automatic.** The API entrypoint runs `prisma migrate deploy`
  (with retry) before serving; `prisma generate` happens at image build.
- **Serving beyond localhost?** Change `WEB_URL`, `CORS_ORIGINS`,
  `NEXT_PUBLIC_API_URL`, and `GOOGLE_REDIRECT_URI` together, put a TLS
  reverse proxy (Caddy/nginx) in front, and re-run with `--build` —
  `NEXT_PUBLIC_API_URL` is baked into the web bundle at build time.
- **Local LLM from inside Docker:** use
  `OPENAI_COMPAT_BASE_URL=http://host.docker.internal:11434/v1`, not
  `localhost`.

## Real-time Gmail push (optional)

By default the scheduler **polls Gmail about once a minute**
(`SCHEDULER_EMAIL_SYNC_INTERVAL_MS`, `packages/api/src/config.ts`) — that is
the fallback path and it works with zero extra setup. For sub-second
delivery, configure Google Pub/Sub push:

1. In the *same* GCP project as your OAuth client, create a Pub/Sub topic
   and grant `roles/pubsub.publisher` to
   `gmail-api-push@system.gserviceaccount.com`.
2. Create a **push subscription** targeting
   `https://<your-api>/api/gmail/push`, with authentication enabled
   (service-account OIDC) — set `GMAIL_PUSH_OIDC_EMAIL` to that service
   account. (Fallback: a shared secret via `GMAIL_PUSH_TOKEN`, sent as
   `Authorization: Bearer`.)
3. Set `GMAIL_PUBSUB_TOPIC=projects/<project>/topics/<topic>` on the API.
   Watch registration and renewal are automatic
   (`packages/api/src/mail/gmail.ts`).

If any of this is missing, nothing breaks — Klorn logs that push is not
configured and keeps polling.

## Updating

```bash
git pull
docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml up -d --build
```

Database migrations apply automatically on the next API boot (additive,
checked into `packages/api/prisma/migrations/`). For the Render path, pushes
to your fork's `main` (or a manual deploy) rebuild the service the same way.
Back up the `klorn-selfhost-pgdata` volume before major version jumps —
[`CHANGELOG.md`](../CHANGELOG.md) flags anything that needs attention.

## Security model

See [`SECURITY.md`](../SECURITY.md) — in particular the deterministic floor
(why the LLM cannot send/delete/forward on its own) and what "prompt
injection is in scope" means for an email product.
