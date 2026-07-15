# Contributing to Klorn

Thanks for considering a contribution. Klorn is an **attention firewall** — an
opinionated product with a doctrine, not a general-purpose inbox toolkit. The
fastest way to get a PR merged is to work *with* that doctrine. The fastest way
to get one closed is to add a surface it deliberately refuses.

**Read [`docs/doctrine/deterministic-floor.md`](docs/doctrine/deterministic-floor.md)
first.** It is the actual product; the code is downstream of it.

## Before you open a PR

- **Non-trivial change? Open an issue first.** Describe the problem before the
  patch. A 20-line fix to a real bug merges fast; a 200-line feature nobody
  agreed to does not.
- **Check it fits the doctrine.** Klorn emits exactly one of four tiers
  (`SILENT` / `QUEUE` / `PUSH` / `AUTO`) and surfaces nothing else — no
  suggestion cards, no autonomous send, no agentic tool sprawl. A PR that adds
  a new surface, a fifth tier, or an "AI thinks you should…" prompt is a
  non-starter regardless of code quality. When in doubt, ask in an issue.
- **Irreversible actions need a receipt.** Anything that sends, permanently
  deletes, or forwards externally must carry an `ActionReceipt` + `payloadHash`.
  Classification/labeling alone is content-hash-bound (see
  [PR #468](https://github.com/k08200/klorn/pull/468)). Don't loosen this.

## Development setup

Requires Node 20+ and **pnpm 10.28.2** (pinned via `packageManager`).

```bash
pnpm install
cp .env.example .env          # fill JWT_SECRET + TOKEN_ENCRYPTION_KEY at minimum
pnpm dev                      # api (:3001) + web (:3000) in parallel
```

Or run the full stack in Docker:

```bash
docker compose up --build     # web :3000, api :3001, postgres :5432
```

The workspace has three packages: `packages/api` (Fastify + Prisma backend),
`packages/web` (Next.js frontend), `packages/contract` (type-only API wire contract).

## Quality gates (CI enforces all of these)

Run them locally before pushing — CI runs the exact same checks:

```bash
pnpm -r test                                      # vitest, all packages
packages/api/node_modules/.bin/biome check packages/    # lint
packages/api/node_modules/.bin/biome format packages/   # format (CI fails on a diff)
pnpm --filter @klorn/api build                    # tsc --noEmit equivalent
pnpm --filter @klorn/web build
```

Note: use the **repo-pinned** biome binary above, not a global `biome` —
a version mismatch produces a different format and a red `Format Check` in CI.

## Tests

- TDD is expected: write the failing test, then the implementation.
- Pure functions get unit tests; see `packages/api/src/__tests__/` for the
  house style (descriptive `it(...)` names that state the behavior under test).
- New behavior without a test will be asked to add one.

## Commits & PRs

- **Conventional commits:** `feat|fix|refactor|docs|test|chore|perf|ci: …`
- Keep PRs focused — one concern per PR. Additional review changes go in a
  **new commit**, not a force-push (history is never rewritten on shared branches).
- Fill in the PR template (Summary / Type / Checklist / Test plan). Describe how
  you verified the change actually works, not just that it compiles.
- Never commit `.env` or secrets. CI runs secret detection; it will catch you.

## License

By contributing you agree your work is licensed under **AGPL-3.0**, the same
license as the project. If you run a modified Klorn as a network service, AGPL
requires you to offer your modified source to that service's users. The
open-core boundary (what's AGPLv3 vs. Cloud-only) is documented in
[`docs/EDITIONS.md`](docs/EDITIONS.md) — the line is *operational, not
behavioural*: nothing in the classifier or the trust path is feature-gated.
