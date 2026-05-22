# Klorn

> **The clear signal worth acting on.**

Klorn is the approval layer for AI agents. It filters mail, calendar, and work signals into one clear decision queue — with evidence and approval before any action leaves your hands.

Other AI agents act. Klorn helps you decide what's worth acting on.

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

### API environment

```bash
cp packages/api/.env.example packages/api/.env
```

Minimum values:

```bash
DATABASE_URL="postgresql://user:password@localhost:5432/klorn"
JWT_SECRET="local-dev-secret"
TOKEN_ENCRYPTION_KEY="" # generate via the command below (32-byte base64)
OPENROUTER_API_KEY=""
WEB_URL="http://localhost:8001"
PORT=8000
```

Generate a `TOKEN_ENCRYPTION_KEY`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

For Google integration also set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI`.

### Database

Run a local PostgreSQL or use the Postgres in Docker Compose.

```bash
docker compose up -d postgres
pnpm --filter @klorn/api exec prisma migrate dev
```

### Dev servers

Terminal 1:

```bash
pnpm --filter @klorn/api dev
```

Terminal 2:

```bash
NEXT_PUBLIC_API_URL=http://localhost:8000 pnpm --filter @klorn/web dev
```

Default ports: API `8000`, Web `8001`.

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

## License

MIT
