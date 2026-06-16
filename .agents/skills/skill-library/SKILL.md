---
name: skill-library
description: Klorn repo skill/agent router — which DAILY surfaces to reach for, and where the LIBRARY (off-stack) surfaces live. Use at the start of a Klorn session to pick the right tool.
---

# Klorn Skill Library (router)

This repo is a **TypeScript pnpm monorepo** (`api` = Fastify 5 + Prisma 6 + OpenAI,
`web` = Next.js 15, `core` = shared). Test = Vitest, lint = Biome, errors = Sentry,
CI = lint/tsc/test/build + `eval.yml`/`judge-canary.yml` (LLM judge ≥80%).

Two buckets:

- **DAILY** — matched to this repo's stack/workflow. Reach for these first.
- **LIBRARY** — off-stack (other languages, domains, launch/marketing). Kept globally,
  invoke only by explicit search. Do **not** load by default.

The authoritative situation→tool mapping lives in the repo root [`CLAUDE.md`](../../../CLAUDE.md).
This file is the quick index.

## DAILY — grouped triggers

| Trigger | Skill / Agent |
|---------|---------------|
| review TS code | `typescript-reviewer`, `code-reviewer` |
| reliability / swallowed errors / Sentry | `silent-failure-hunter` |
| build or tsc fails | `build-error-resolver` |
| explore the monorepo | `code-explorer`, `Explore`, `code-architect` |
| tests / coverage | `tdd-guide`, `test-coverage`, `pr-test-analyzer` |
| classifier accuracy / evals | `ai-regression-testing`, `eval`, `eval-harness` |
| LLM routing / prompts / cost | `claude-api`, `cost-aware-llm-pipeline`, `regex-vs-llm-structured-text`, `prompt-optimizer` |
| gateway / provider / MCP | `mcp-server-patterns`, `api-connector-builder` |
| Prisma / Postgres | `database-reviewer`, `postgres-patterns`, `database-migrations` |
| security / CASA / OSS public repo | `security-reviewer`, `cso`, `security-review`, `opensource-sanitizer` |
| Next.js web | `frontend-patterns` |
| PR → CI → merge | `code-review`, `verify`, `quality-gate`, `github-ops`, `ship` |
| dogfood the live app | `browse` / `gstack`, `e2e`, `design-review` |
| Klorn-specific stale-finding sweep | `klorn-grounded-rereview` |
| save / resume long sprints | `context-save`, `context-restore`, `save-session`, `resume-session` |

## LIBRARY — off-stack (search to invoke)

- **Other languages** (zero source in repo): python / go / rust / java / kotlin /
  swift / cpp / laravel / spring / flutter / dart / perl — patterns, testing, build, security.
- **Domain packs** (unrelated): logistics, healthcare/HIPAA, finance/DeFi, manufacturing/QA.
- **Launch / marketing** (only during a launch push, not coding): investor-*, market-research,
  content-engine, crosspost, x-api, connections-optimizer, seo.
- **Heavy multi-agent** (explicit call only): devfleet, dmux, gan-*, orchestrate, multi-*.
- **Media / docgen**: fal-ai, manim, remotion, videodb, make-pdf.

These stay installed globally — reach them with a normal skill search when genuinely needed.
