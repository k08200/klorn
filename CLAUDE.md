# CLAUDE.md

Guidance for AI coding agents (and humans) working in this repo.

## What this is

Klorn — an AI email chief-of-staff. Emails are triaged into exactly **5 lanes: PUSH / MEETING / QUEUE / INFO / SILENT** (QUEUE is the default; canonical source is `AttentionItem.tier` in `packages/api/prisma/schema.prisma`). `AUTO` and `CALL` are **retired v1 values** that `normalizeTier` folds on read — never emit them, never show them in copy, never invent a 6th lane. pnpm-workspaces monorepo:

- `packages/api` — Fastify 5 + Prisma backend (deployed on Render)
- `packages/contract` — type-only API wire contract shared by api and its clients
- `packages/web` — Next.js 15 app (Vercel; prod deploys from `main`)
- `apps/mobile` — Capacitor shell wrapping the hosted web app
- `apps/desktop-mac` — native SwiftUI macOS app
- `website/` — static landing (GitHub Pages)

## Gate (CI mirrors this — run before every PR)

```bash
pnpm install --frozen-lockfile
(cd packages/api && npx prisma generate)         # ALWAYS before typecheck/tests; re-run after every rebase
biome check --diagnostic-level=error packages/   # lint gate is errors-only
pnpm --filter @klorn/api typecheck               # and @klorn/web — CI runs these same scripts
(cd packages/api && npx vitest run)
pnpm -r build
```

Gotchas:
- Fresh clone/worktree: typecheck fails until `prisma generate` has run.
- Typecheck via the package script, not a bare `npx tsc --noEmit`: api's `typecheck`
  carries `--max-old-space-size=4096` (as its `build` does) because a bare run peaks
  just over 2 GB and aborts with SIGABRT wherever node's default heap is 2 GB.
- Warnings don't block the lint gate; errors do.
- CI jobs run in parallel with a warm pnpm cache — the local gate above is the sum
  of them; a green local run means a green CI.
- Touching `apps/desktop-mac/**`? CI runs `swift run KlornMac --self-check` on a
  macOS runner. Run it locally before pushing (the Swift `--self-check` harness).
- Touching `website/`? The EN (`website/index.html`) and KO (`website/ko/index.html`)
  landings are parallel copies — edit both in lockstep. CI enforces structural
  parity (`.github/scripts/check-website-lockstep.sh`; run it locally to check).
- Docs/website/media-only changes: the heavy CI jobs (TypeScript/Test/Build) and
  Migrations self-skip via the `Scope` probe — skipped required checks still pass
  branch protection, so these PRs merge in seconds.

## Branch & PR rules

- `main` is the active integration branch and deploys prod. Never wholesale-merge old divergent branches (e.g. legacy `feat/mobile-app`) — cherry-pick only.
- Squash-merge. Branch protection requires the head branch to be up to date with `main`.
- Conventional commits. PR body must include all 4 template sections — `## Summary`, `## Type`, `## Checklist`, `## Test plan` — or a pre-push hook blocks `gh pr create`. Test plan = commands actually run and their results.
- English for commits, PRs, code comments, and docs.

## Production database

Supabase (`ap-northeast-2`), reached through the **session pooler** on port
5432 — the mode Prisma migrations need. `DATABASE_URL` is `sync: false` in
`render.yaml`, i.e. it lives in the Render dashboard, not the blueprint.

**Rotating that password has a required order** — Suspend the Render service
first, or the outgoing container keeps auth-failing, arms Supabase's
connection circuit breaker, and locks every replacement out. That is what
took production down for 40 minutes on 2026-08-04. Full procedure, plus the
manual backup/restore drill (the free tier has no automated backups):
`docs/launch/db-credential-runbook.md`.

## Product vocabulary

`docs/product-vocabulary.md` is the canonical word list — read it before naming
a surface or writing user-facing copy. The load-bearing ones: **"inbox" means a
connected mail account, never a screen**; home is **Today**; the approval
surface is **Approvals** under **Assistant** (formerly "Decision queue"); lanes
are Mail's primary filter (the "Firewall board" screen is retired as a
user-facing term). The old names persist in code until the migration ships
behind `UNIFIED_HOME`. A lane is a
classification and never an action — delegation is the separate agent mode
(`SHADOW` / `SUGGEST` / `AUTO`), which is not the same thing as the retired
`AUTO` lane. App language / notification language / reply language are three
different things.

## Engineering doctrine

- **Deterministic floor**: the 3 real-world actions (send / delete / forward) always produce an `ActionReceipt` with a payload hash. Everything else goes through the classifier.
- New features ship behind OFF-by-default env flags; flipping a flag is a separate, deliberate decision.
- Multi-inbox: every Gmail action must thread the linked inbox account id end-to-end — never assume the primary account.
- All user-facing surfaces meet WCAG 2.2 AA (contrast, reduced-motion, focus states, ≥44px touch targets).
- Security baseline: no secrets in code, parameterized queries, validate all external input at boundaries. OAuth tokens are already encrypted at rest — do not "discover" them as plaintext.
