# Self-hosting Klorn

Klorn is AGPL-3.0 open source, and self-hosting is a first-class path — not a
degraded one. Full feature parity with the hosted product.

## Why self-host

- **Your data stays yours.** Mail bodies, classifications, and OAuth tokens
  live in *your* Postgres, encrypted with *your* key. With a local LLM
  configured (below), email content never leaves your machine at all.
- **No 100-account cap.** The hosted app is limited to 100 lifetime accounts
  until CASA Tier 2 verification lands. When you self-host, **you create your
  own Google OAuth client** — you are the app's owner and (usually) its only
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
The api and web images are prebuilt and published to
[ghcr.io](https://github.com/k08200?tab=packages) — no local toolchain, no
source build.

```bash
git clone https://github.com/k08200/klorn.git
cd klorn
cp .env.selfhost.example .env.selfhost
# Fill in .env.selfhost: postgres password, JWT secret, encryption key,
# your Google OAuth client, and one LLM provider.
docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml up -d
```

Open `http://localhost:3000`. The API is on `:3001`; Postgres stays internal
to the compose network (not published to the host).

Notes:

- **Schema is automatic.** The API entrypoint runs `prisma migrate deploy`
  (with retry) before serving; `prisma generate` happens at image build.
- **Serving beyond localhost?** This is the one case that still needs a
  source build, because `NEXT_PUBLIC_API_URL` is baked into the web bundle.
  See [Reverse proxy](#reverse-proxy) for the four values that change together
  and a working config for Caddy, nginx and Traefik.
- **Local LLM from inside Docker:** `host.docker.internal`, not `localhost` —
  see [Fully local LLM (Ollama)](#fully-local-llm-ollama) for the whole path,
  including the Linux `extra_hosts` line.
- **Healthchecks.** `api` and `web` both have one, and `depends_on` uses
  `condition: service_healthy`, so `up -d` returns once the stack actually
  serves rather than once the containers exist. Check with:
  ```bash
  docker inspect --format='{{.Name}} {{.State.Health.Status}}' \
    $(docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml ps -q)
  ```
  An api stuck at `unhealthy` with the container running is almost always
  Postgres: `/api/health` answers 503 with `status: "degraded"` while the
  database is unreachable, and the probe reads that field.

## Fully local LLM (Ollama)

No email content leaves the box. This is the reason most people self-host, so
here is the whole path rather than the two env vars.

```bash
# 1. Pull the model the API defaults to when OPENAI_COMPAT_MODEL is unset
#    (packages/api/src/providers/index.ts:161).
ollama pull qwen3:8b

# 2. Ollama has to listen on more than loopback, or the container cannot reach
#    it — `host.docker.internal` arrives from outside the host's 127.0.0.1.
#    Set OLLAMA_HOST=0.0.0.0 (Linux: systemctl edit ollama.service; macOS and
#    Windows: the app's environment) and restart it.
curl -s http://localhost:11434/v1/models | head -c 200
```

Then in `.env.selfhost`:

```dotenv
# host.docker.internal, NOT localhost — inside the container localhost is the
# container. On Linux this hostname needs the extra_hosts line below; on
# Docker Desktop it resolves already.
OPENAI_COMPAT_BASE_URL=http://host.docker.internal:11434/v1
OPENAI_COMPAT_MODEL=qwen3:8b
# Optional. Local servers usually ignore auth and the API already substitutes
# "local" when this is unset (providers/index.ts:160) — set it only if your
# endpoint checks it.
OPENAI_COMPAT_API_KEY=

# This is the line that makes it local-ONLY. A configured local endpoint runs
# FIRST, but hosted providers stay as failover, so leaving a key here means
# mail can still leave the box when the local model errors or times out.
OPENROUTER_API_KEY=
GEMINI_API_KEY=
```

On **Linux**, `host.docker.internal` is not automatic. Add it to the api
service with a compose override (`docker-compose.override.yml`, picked up
automatically):

```yaml
services:
  api:
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

Verify the API is actually using it, not silently failing over:

```bash
docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml \
  logs api | grep -i "openai-compat\|provider"
```

A model this size is slower than the hosted default and the classifier is
tuned against larger models — expect lower accuracy, not a different product.
Bigger local models work the same way: pull it, change `OPENAI_COMPAT_MODEL`.

## Reverse proxy

Serving beyond `localhost` means one extra thing beyond TLS: **rebuilding
web.** `NEXT_PUBLIC_API_URL` is inlined into the client bundle at build time,
so the published image only works when browsers reach the API at
`http://localhost:3001`. Four values change together:

```dotenv
WEB_URL=https://klorn.example.com
CORS_ORIGINS=https://klorn.example.com
NEXT_PUBLIC_API_URL=https://klorn.example.com
GOOGLE_REDIRECT_URI=https://klorn.example.com/api/auth/google/callback
```

Then swap the web service's `image:` line for the commented `build:` block and
re-run with `--build`. The api image needs no rebuild — it is configured
entirely at runtime. The Google redirect URI must also be added to your OAuth
client's authorised list, or sign-in fails after consent.

**What to route.** Every HTTP route the API serves is under `/api`, plus a
WebSocket at `/ws`. Everything else is web. So one hostname is enough, and
same-origin means no CORS preflight at all.

### Caddy

```caddyfile
klorn.example.com {
	@api path /api/* /ws
	reverse_proxy @api api:3001
	reverse_proxy web:3000
}
```

Automatic HTTPS, and Caddy forwards WebSocket upgrades without extra config.
Run Caddy on the same compose network as the stack, or replace `api:3001` /
`web:3000` with host ports.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name klorn.example.com;
    # certbot --nginx writes ssl_certificate / ssl_certificate_key here.

    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # The WebSocket. Without Upgrade/Connection here the app still loads and
    # then silently stops updating in real time — the failure looks like
    # "nothing arrives", not like an error.
    location /ws {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host       $host;
        proxy_read_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

TLS: `certbot --nginx -d klorn.example.com` — see
[certbot.eff.org](https://certbot.eff.org/) for the rest.

### Traefik

Assumes a Traefik instance already running with a `websecure` entrypoint and a
Let's Encrypt resolver — this adds labels to the existing services rather than
a Traefik service to our compose. Put it in `docker-compose.override.yml`:

```yaml
services:
  api:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.klorn-api.rule=Host(`klorn.example.com`) && (PathPrefix(`/api`) || Path(`/ws`))"
      - "traefik.http.routers.klorn-api.entrypoints=websecure"
      - "traefik.http.routers.klorn-api.tls.certresolver=letsencrypt"
      - "traefik.http.services.klorn-api.loadbalancer.server.port=3001"
  web:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.klorn-web.rule=Host(`klorn.example.com`)"
      - "traefik.http.routers.klorn-web.entrypoints=websecure"
      - "traefik.http.routers.klorn-web.tls.certresolver=letsencrypt"
      - "traefik.http.services.klorn-web.loadbalancer.server.port=3000"
```

Traefik passes WebSocket upgrades through by default, so `/ws` needs nothing
beyond being matched by the api router above. The api router's rule is more
specific than web's, so Traefik prefers it — no priority needed.

Traefik must share a network with the stack; add its network to both services
in the same override.

## Backup & restore

Two things, and the second is the one people lose.

1. **The Postgres volume** — `klorn-selfhost-pgdata`. All mail metadata,
   classifications and learned rules.
2. **`.env.selfhost`** — it holds `TOKEN_ENCRYPTION_KEY`. Stored OAuth tokens
   are AES-256-GCM encrypted with it, so a database restored without the
   original key is a database whose Google connections cannot be decrypted.
   Not recoverable by design. Back it up separately from the dump, and not in
   the same place.

### Dump

```bash
docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml \
  exec -T postgres pg_dump -U klorn -Fc klorn > klorn-$(date +%F).dump
```

`-Fc` is the custom format — compressed, and `pg_restore` can use it. `-T`
matters in cron: without it Docker allocates a TTY and corrupts the stream.

### Restore into a fresh stack

```bash
# 1. Put the ORIGINAL .env.selfhost back first, TOKEN_ENCRYPTION_KEY included.
docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml up -d postgres

# 2. Restore. The api entrypoint runs `prisma migrate deploy` on boot, so let
#    the dump define the schema and start the api afterwards.
docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml \
  exec -T postgres pg_restore -U klorn -d klorn --clean --if-exists < klorn-2026-08-26.dump

# 3. Bring the rest up.
docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml up -d
```

Restoring into a stack whose `TOKEN_ENCRYPTION_KEY` differs from the one the
dump was taken under leaves every Google connection unusable; each account has
to be reconnected. Nothing warns you at restore time — it surfaces later as
sync failures.

Test the restore path once before you need it.

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
git pull   # picks up compose/doc changes
docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml pull
docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml up -d
```

(If you switched a service to the source-build path, use `up -d --build`
instead of `pull`.)

Database migrations apply automatically on the next API boot (additive,
checked into `packages/api/prisma/migrations/`). For the Render path, pushes
to your fork's `main` (or a manual deploy) rebuild the service the same way.
Take a dump before major version jumps — see
[Backup & restore](#backup--restore); [`CHANGELOG.md`](../CHANGELOG.md) flags
anything that needs attention.

## Security model

See [`SECURITY.md`](../SECURITY.md) — in particular the deterministic floor
(why the LLM cannot send/delete/forward on its own) and what "prompt
injection is in scope" means for an email product.
