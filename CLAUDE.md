# CLAUDE.md

Guidance for AI coding agents (and humans) working in this repo.

## What this is

Klorn — an AI email chief-of-staff. Emails are triaged into exactly **4 tiers: PUSH / QUEUE / SILENT / AUTO** (AUTO = classification only — never invent a 5th tier). pnpm-workspaces monorepo:

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
(cd packages/api && npx tsc --noEmit)            # repeat for packages/web
(cd packages/api && npx vitest run)
pnpm -r build
```

Gotchas:
- Fresh clone/worktree: typecheck fails until `prisma generate` has run.
- Warnings don't block the lint gate; errors do.
- CI jobs run in parallel with a warm pnpm cache — the local gate above is the sum
  of them; a green local run means a green CI.
- Touching `apps/desktop-mac/**`? CI runs `swift run KlornMac --self-check` on a
  macOS runner. Run it locally before pushing (the Swift `--self-check` harness).

## Branch & PR rules

- `main` is the active integration branch and deploys prod. Never wholesale-merge old divergent branches (e.g. legacy `feat/mobile-app`) — cherry-pick only.
- Squash-merge. Branch protection requires the head branch to be up to date with `main`.
- Conventional commits. PR body must include all 4 template sections — `## Summary`, `## Type`, `## Checklist`, `## Test plan` — or a pre-push hook blocks `gh pr create`. Test plan = commands actually run and their results.
- English for commits, PRs, code comments, and docs.

## Engineering doctrine

- **Deterministic floor**: the 3 real-world actions (send / delete / forward) always produce an `ActionReceipt` with a payload hash. Everything else goes through the classifier.
- New features ship behind OFF-by-default env flags; flipping a flag is a separate, deliberate decision.
- Multi-inbox: every Gmail action must thread the linked inbox account id end-to-end — never assume the primary account.
- All user-facing surfaces meet WCAG 2.2 AA (contrast, reduced-motion, focus states, ≥44px touch targets).
- Security baseline: no secrets in code, parameterized queries, validate all external input at boundaries. OAuth tokens are already encrypted at rest — do not "discover" them as plaintext.
