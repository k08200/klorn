# Klorn — Agent Operating Guide

Klorn is an **AI email firewall/router**: it classifies inbound mail into 4 tiers
(PUSH / QUEUE / SILENT / AUTO) and only interrupts the user for what matters.

This file tells an agent **which skill or agent to use for each situation** in this
repo. It is the authoritative situation→tool map; [`skills/skill-library`](skills/skill-library/SKILL.md)
is the quick index. Reach for DAILY surfaces; do not pull in off-stack LIBRARY ones.

## Stack (verified)

| Area | Tech |
|------|------|
| Language | **TypeScript only** (~454 files; no Python/Go/Rust) |
| Packages | pnpm 10 monorepo — `api`, `core`, `web` |
| API | Fastify 5 · Prisma 6 (Postgres) · OpenAI · imapflow (IMAP) · web-push · Sentry |
| Web | Next.js 15 · React 19 · TanStack Query |
| Test / Lint | **Vitest** · **Biome** |
| CI | lint · tsc (api+core) · vitest · build · `eval.yml` · `judge-canary.yml` (LLM judge ≥80%) · `security.yml` · `dogfood.yml` (Playwright) |

Because the repo is TypeScript-only, **never** invoke another language's
reviewer/build/test skill. Use the TS surfaces below.

## Situation → use this

### Writing / changing code
- **Before building a feature / changing behavior** → `/brainstorming` first
  (refine intent + requirements before any code).
- **Any TS/JS change** → review with the `typescript-reviewer` agent (proactively, before PR).
- **General correctness pass** → `code-reviewer` agent.
- **Reliability / error handling** (Sentry, fallbacks, fire-and-forget, swallowed errors)
  → `silent-failure-hunter` agent. This is the core engine concern — run it on any
  change to `email-sync`, `proactive-actions`, `automation-scheduler`, routes.
- **Any bug / test failure / unexpected behavior** → `/systematic-debugging`
  (root-cause before patching) — pair with `silent-failure-hunter` for the reliability angle.
- **Build or `tsc` fails** → `build-error-resolver` agent (minimal diff, no architecture edits).
- **Understand an existing feature / trace a path** → `code-explorer` or `Explore` agent.
- **Design a new feature across packages** → `code-architect` agent.
- **Simplify recently-written code (quality only, no bug hunt)** → `/simplify`.

### Tests & the classifier quality gate
- **New feature / bug fix** → `tdd-guide` agent (RED→GREEN→IMPROVE, 80%+ coverage).
- **Check PR test coverage** → `pr-test-analyzer` agent or `/test-coverage`.
- **Classifier accuracy / regressions** (the 4-tier model, PoC ≥80% gate)
  → `ai-regression-testing` + `/eval` / `eval-harness`. CI mirrors this in
  `eval.yml` and `judge-canary.yml` — keep them green before merge.

### LLM / email engine
- **Model routing, prompt changes, cost** → `claude-api`, `cost-aware-llm-pipeline`,
  `prompt-optimizer`.
- **Structured extraction from email text** → `regex-vs-llm-structured-text`
  (decide deterministic vs LLM before adding a model call).
- **New gateway / provider / MCP surface** → `mcp-server-patterns`, `api-connector-builder`
  (match the existing integration pattern — do not invent a second architecture).

### Data
- **Prisma schema / query / migration** → `database-reviewer`, `postgres-patterns`,
  `database-migrations`.

### Web (secondary — touch less often)
- **Next.js / React UI** → `frontend-patterns`. Keep UI copy **English** (project policy).

### Security & open source
- **Auth / tokens / user data / crypto / IMAP / push** → `security-reviewer` agent
  (this repo is **public** + targets CASA Tier 2 — every new surface must clear that baseline).
- **Repo-wide audit** → `cso` or `/security-review`.
- **Before any public release / fork** → `opensource-sanitizer` (scan for leaked secrets/PII).

### Klorn-specific
- **Re-review the codebase without stale findings** → `/klorn-grounded-rereview`
  (9 domain finders, each verified against current HEAD + git history — kills
  already-fixed/stale issues; use this instead of a generic review when auditing).

### Ship workflow
1. Make the change → run the relevant reviewer agent above.
2. **Reproduce CI locally before pushing**: `biome check`, `tsc --noEmit` (api+core),
   `vitest run`, `pnpm -r build`. Gate with `/verify` or `/quality-gate`.
3. **Before claiming done / committing** → `/verification-before-completion`
   (run the commands, confirm the output — evidence before assertions; no "should pass").
4. PR/CI/merge helpers: `github-ops`, `/code-review`, `/ship`.
5. **Dogfood the live app** when behavior changes: `browse` / `gstack`, `/e2e`,
   `/design-review`.

### Long / multi-session work
- `context-save` / `context-restore`, `save-session` / `resume-session` to hand off
  across sessions without losing state.

## Workflow rules (hard)

- **Commits & PRs in English.** Conventional commits: `feat|fix|refactor|docs|test|chore|perf|ci:`.
- **No `Co-Authored-By` lines. No "Generated with Claude Code".**
- **Never force-push** (`--force` / `--force-with-lease`) on any branch. Extra PR
  changes go in a **new commit**, not an amend.
- The user opens PRs / pushes themselves unless they explicitly ask.
- **Handle errors explicitly** — never swallow. Log a signal even on non-fatal paths
  (console + `captureError`); `captureError` alone is silent when Sentry is off.
- **Immutable data** — new objects, no mutation. Functions < 50 lines, early returns.

## Don't

- Don't run other-language skills (no Python/Go/Rust/etc. — not in this stack).
- Don't add a 5th tier or "Call" — the model is **4-tier** (PUSH/QUEUE/SILENT/AUTO), locked.
- Don't pull LIBRARY surfaces (marketing, domain packs, media gen) into a coding session.
