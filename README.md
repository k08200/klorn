# hireEVE

**Decision OS for work signals, approvals, and memory.**

EVE is a Decision OS for work. It reads email, calendar, tasks, and memory, connects the hidden context between them, and turns scattered signals into decisions you can inspect, approve, and trust.

## Why EVE?

Every team checks five apps every morning and none of them answer the question that matters: **"What decision needs my attention now?"**

EVE connects Gmail, Calendar, Slack, and Notion, then cross-references everything to surface decisions — not just summaries.

| Tool | What it does | What EVE does |
|------|-------------|---------------|
| Gmail | "30 unread emails" | "Investor reply needed within 48h — draft ready" |
| Calendar | "3 meetings today" | "2pm meeting — prep pack ready, no conflicts" |
| Tasks | "12 tasks open" | "These 2 are overdue and blocking others" |
| ChatGPT | Answers when asked | EVE acts before you ask |
| Zapier | Rule-based automation | LLM-powered judgment with approval gates |

## How It Works

1. **Connect** — Link Gmail and Calendar in one click
2. **EVE connects context** — Ingests email, events, and tasks; extracts people, promises, deadlines, and risks
3. **Command Center** — Your home screen shows what to act on now, what needs approval, what was handled
4. **Morning briefing** — Prioritized day-plan delivered before you open your laptop
5. **Trust ladder** — EVE earns scope gradually: observe → suggest → draft → execute with approval → report exceptions

### Command Center (the home screen)

Not a chat. Not an inbox. An **operations console**:

- Top 3 things to act on now
- Pending approvals
- Today's commitments and risks
- What EVE prepared quietly
- What's likely to bite you tomorrow

### Commitment Ledger

EVE extracts implicit promises from your conversations — *"I'll send it by Friday"*, *"Let's revisit next week"* — and tracks them so they don't fall through the cracks.

### Work Graph

People, companies, projects, and threads linked together. *"Min-soo Kim = ABC Ventures investor → linked to pitch deck task → due before Friday meeting."*

### Shadow Mode

EVE doesn't auto-execute on day one. She watches for two weeks, learns your patterns, and asks for permission:
> "I noticed you always prep meeting notes the night before. Want me to start drafting them automatically?"

Trust is earned, not toggled.

### Trust Ladder

Not AUTO/OFF. Five stages:

| Level | Behavior |
|-------|----------|
| L0 | Observe only |
| L1 | Suggest |
| L2 | Draft |
| L3 | Execute on approval |
| L4 | Auto within pre-approved scope |
| L5 | Report exceptions only |

### Other Autonomous Behaviors
- **Meeting prep pack** — Briefing doc auto-generated before each event
- **Feedback policy learning** — Your approvals and rejections shape future judgments
- **Team risk radar** — For teams: detects cross-member conflicts (release delayed, launch scheduled)
- **Playbooks** — Reusable patterns: investor follow-up, customer ticket triage, launch week, hiring pipeline

## For Teams

The bigger the team, the more powerful the cross-context decisions:

> "Dev team's release is delayed but marketing scheduled the launch announcement for tomorrow. Should I flag this?"

One person's email + another's calendar + the team's tasks = decisions no single tool can make.

| Plan | For | Price |
|------|-----|-------|
| Free | Try it out | $0/mo (50 messages) |
| Pro | Individuals | $29/mo |
| Team | Small teams | $99/mo |
| Enterprise | Organizations | Custom |

## Features

### Core
- **Command Center** — Attention queue, not a notification feed
- **Morning briefing** — Prioritized daily plan
- **Commitment Ledger** — Tracks implicit promises across email and chat
- **Work Graph** — People, projects, and threads connected
- **Shadow mode** — Trust-earning observation period
- **Trust ladder** — Five autonomy levels per action class
- **Meeting prep pack** — Auto-generated briefings before events
- **Feedback learning** — Policy that adapts to your approvals
- **Team risk radar** — Cross-member conflict detection
- **Playbooks** — Reusable workflow templates

### Tools (60+)

| Category | Tools |
|----------|-------|
| Email | List, read, send, classify, draft, auto-reply rules |
| Calendar | List, create, delete events, conflict check, prep packs |
| Tasks | Create, update, delete, prioritize, deadline tracking |
| Notes | Create, update, delete, search |
| Reminders | Create, dismiss, snooze, bulk delete |
| Contacts | Manage, tag, auto-populate from email |
| Memory | Remember, recall, forget across conversations |
| Knowledge | Web search, news, weather |
| Documents | Write, translate |

### Integrations
- Gmail + Google Calendar (OAuth)
- Slack (send/read messages, webhooks)
- Web Push notifications (works with tab closed)
- WebSocket real-time updates
- Notion *(coming soon)*

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 15, Tailwind CSS, TypeScript |
| Backend | Fastify, Prisma ORM, PostgreSQL |
| Desktop | Tauri v2 |
| AI | OpenRouter (primary) + Gemini (fallback) |
| Auth | JWT + Google OAuth2 + bcrypt |
| Real-time | WebSocket + Server-Sent Events |
| Push | VAPID Web Push |
| Billing | Stripe |
| Monorepo | pnpm workspaces |

## Project Structure

```
packages/
  api/    Fastify server, autonomous agent, 60+ tools, attention queue
  web/    Next.js frontend (Command Center, Briefing, Inbox)
  core/   Shared utilities and types
apps/
  desktop/  Tauri v2 desktop app
```

## Setup

### Prerequisites

- Node.js 22+
- PostgreSQL
- pnpm

### Quick Start

```bash
git clone https://github.com/k08200/hireEVE.git
cd hireEVE
pnpm install

# API
cd packages/api
cp .env.example .env    # Edit with your credentials
npx prisma migrate dev
pnpm dev                # API on :8000

# Web (in another terminal)
cd packages/web
pnpm dev                # Web on :8001
```

### Environment Variables

#### Backend (`packages/api/.env`)

```bash
# Required
DATABASE_URL=postgresql://user:password@localhost:5433/hireeve
JWT_SECRET=your-secret
OPENROUTER_API_KEY=your-key
TOKEN_ENCRYPTION_KEY=             # Generate: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# Google OAuth (Gmail + Calendar)
GOOGLE_CLIENT_ID=your-id
GOOGLE_CLIENT_SECRET=your-secret
GOOGLE_REDIRECT_URI=http://localhost:8000/api/auth/google/callback
WEB_URL=http://localhost:8001

# Optional
GEMINI_API_KEY=                   # Fallback when OpenRouter quota exhausted
STRIPE_SECRET_KEY=
SLACK_BOT_TOKEN=
SLACK_WEBHOOK_URL=
SLACK_SIGNING_SECRET=
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
CORS_ORIGINS=http://localhost:8001
```

#### Frontend (`packages/web/.env.local`)

```bash
NEXT_PUBLIC_API_URL=http://localhost:8000
```

### Google OAuth Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials
2. Create an OAuth 2.0 Client ID (Web application)
3. Add authorized redirect URI: `http://localhost:8000/api/auth/google/callback`
4. Copy Client ID and Secret to your `.env`
5. Enable Gmail API and Google Calendar API

### Docker

```bash
docker compose up
# API on :3001, Web on :3000, PostgreSQL on :5432
```

## Deployment

**Backend** (Render, Railway, etc.):
```bash
cd packages/core && pnpm build
cd ../api && npx prisma generate && pnpm build
cd packages/api && npx prisma migrate deploy && node dist/index.js
```

**Frontend** (Vercel):
- Set `NEXT_PUBLIC_API_URL` to your backend URL

**Production env vars**:
- `CORS_ORIGINS=https://your-frontend.vercel.app`
- `WEB_URL=https://your-frontend.vercel.app`
- `GOOGLE_REDIRECT_URI=https://your-api.onrender.com/api/auth/google/callback`

## Language Support

EVE works in both Korean and English. She mirrors the language you use.

## License

MIT
