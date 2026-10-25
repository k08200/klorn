# Contributing to Klorn

Thanks for considering a contribution. Klorn is an **attention firewall**: an
opinionated product with a doctrine, not a general-purpose inbox toolkit. The
fastest way to get a PR merged is to work *with* that doctrine. The fastest way
to get one closed is to add a surface it deliberately refuses.

**Read [`docs/doctrine/deterministic-floor.md`](docs/doctrine/deterministic-floor.md)
first.** It is the actual product; the code is downstream of it.

## Where to start

- **Newcomer-sized work** is labelled
  [`good first issue`](https://github.com/k08200/klorn/issues?q=is%3Aopen+is%3Aissue+label%3A%22good+first+issue%22).
  Each one names the files to touch, the acceptance criteria, and the command
  that proves it works.
- **Bigger pieces** where outside help is welcome are labelled
  [`help wanted`](https://github.com/k08200/klorn/issues?q=is%3Aopen+is%3Aissue+label%3A%22help+wanted%22).
- **Skip issues labelled `maintainer-only`.** They need production access or a
  product decision, so an outside PR cannot land them.
- **Say you're on it.** Comment on the issue before you start so two people
  don't do the same work. If the issue goes quiet for two weeks, someone else
  may pick it up.
- **Questions** go to [Discussions → Q&A](https://github.com/k08200/klorn/discussions/categories/q-a).
  Ideas that aren't a concrete issue yet go to
  [Discussions → Ideas](https://github.com/k08200/klorn/discussions/categories/ideas).
- **Security problems never go in a public issue.** See [`SECURITY.md`](SECURITY.md).

### Labels

| Label | Meaning |
|---|---|
| `good first issue` | Small, well-scoped, no production access needed |
| `help wanted` | Larger work where outside help is welcome |
| `maintainer-only` | Needs production access or a product decision; not open for outside PRs |
| `area/api`, `area/web`, `area/desktop-mac`, `area/desktop-win`, `area/mobile`, `area/website` | Which part of the repo |
| `area/i18n`, `area/a11y`, `area/providers`, `area/self-host`, `area/docs`, `area/engine`, `area/ci` | Cross-cutting topic |
| `size/S` | A few hours; one or two files |
| `size/M` | About a day; several files |
| `size/L` | Several days; discuss the approach in the issue first |

## Before you open a PR

- **Non-trivial change? Open an issue first.** Describe the problem before the
  patch. A 20-line fix to a real bug merges fast; a 200-line feature nobody
  agreed to does not.
- **Check it fits the doctrine.** Klorn emits exactly one of five lanes
  (`PUSH` / `MEETING` / `QUEUE` / `INFO` / `SILENT`) and surfaces nothing else: no
  suggestion cards, no autonomous send, no agentic tool sprawl. Automation is
  deliberately *not* a lane: `AUTO` and `CALL` are retired v1 values that
  `normalizeTier` folds away on read. A PR that adds a new surface, a sixth lane,
  or an "AI thinks you should…" prompt is a non-starter regardless of code
  quality. The canonical wording is in
  [`docs/product-vocabulary.md`](docs/product-vocabulary.md). When in doubt, ask
  in an issue.
- **Irreversible actions need a receipt.** Anything that sends, permanently
  deletes, or forwards externally must carry an `ActionReceipt` + `payloadHash`.
  Classification/labeling alone is content-hash-bound (see
  [PR #468](https://github.com/k08200/klorn/pull/468)). Don't loosen this.
- **No unmeasured claims.** Docs, copy and PR descriptions state what was
  measured and how. Don't add accuracy numbers you didn't measure.

## Repository layout

| Path | What it is | Toolchain |
|---|---|---|
| `packages/api` | Fastify + Prisma API | Node 22, pnpm |
| `packages/web` | Next.js web app | Node 22, pnpm |
| `packages/contract` | Type-only API wire contract | Node 22, pnpm |
| `apps/desktop-mac` | Native macOS app (SwiftUI, Swift Package) | Xcode / Swift toolchain |
| `apps/desktop-win` | Windows wrapper (Tauri) | Rust, cargo |
| `apps/mobile` | Mobile app (React + Capacitor), **not** part of the pnpm workspace | npm |
| `website/` | Static marketing site | none (plain HTML) |
| `docs/` | Doctrine, self-hosting, providers, design notes | none |

## Local setup (no Google account needed)

You can run the API and the web app, sign in, and work on most of the product
without a Google Cloud project, an OAuth client or any LLM key.

**Requirements:** Node 22 (CI uses 22), pnpm 10.28.2 (pinned via
`packageManager`; `corepack enable` picks it up), and Docker for Postgres 16
(or a Postgres 16 you already run).

```bash
git clone https://github.com/k08200/klorn.git
cd klorn
corepack enable
pnpm install
```

### 1. Environment files

Klorn reads **two** env files in local dev.

```bash
cp .env.example .env                              # used by docker compose
cp packages/api/.env.example packages/api/.env    # used by the API dev server
```

In the root `.env`, set `JWT_SECRET` (any long random string) and
`TOKEN_ENCRYPTION_KEY` (32 random bytes, base64). Compose refuses to start even
the database container without them:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

In `packages/api/.env`, add one line so you can sign in without Google:

```bash
ENABLE_DEMO_USER=true
```

This seeds a local demo account. It only works when `NODE_ENV` is `development`
or `test` (the `dev` script sets `development`); in any other environment the
API refuses it (`isDemoAccessEnabled` in
[`packages/api/src/auth.ts`](packages/api/src/auth.ts)). Leave the Google, LLM
and billing keys empty.

### 2. Database

```bash
docker compose up -d postgres
pnpm --filter @klorn/api exec prisma migrate deploy
pnpm --filter @klorn/api exec prisma generate
```

If something else already listens on `5432`, stop it or change the port mapping
in `docker-compose.yml` and `DATABASE_URL` in `packages/api/.env`.

### 3. Run the API and the web app

```bash
# Terminal 1: API on :8000
pnpm --filter @klorn/api dev
curl http://localhost:8000/api/health    # → {"status":"ok","db":"connected",...}

# Terminal 2: web on :8001
NEXT_PUBLIC_API_URL=http://localhost:8000 pnpm --filter @klorn/web dev
```

Open <http://localhost:8001/login> and sign in with **`demo@klorn.ai`** /
**`demo`**. A fresh account lands on onboarding; mail views stay empty until a
mailbox is connected.

Each page compiles on first visit in dev (5–20 s). If the login button seems to
do nothing, the next page is still compiling: wait, or open
<http://localhost:8001/onboarding> directly.

### Ports

| Setup | Web | API | Postgres |
|---|---|---|---|
| Local dev (`pnpm … dev`) | 8001 | 8000 | 5432 |
| Full stack in Docker (`docker compose up --build`) | 3000 | 3001 | 5432 |

### Optional: a model for classification

With no LLM key, classification uses the deterministic keyword path. To try the
model path without a cloud account, point the API at any OpenAI-compatible
server, for example Ollama:

```bash
# packages/api/.env
OPENAI_COMPAT_BASE_URL="http://localhost:11434/v1"
OPENAI_COMPAT_MODEL="qwen3:8b"
```

See the README's "Local LLM" section and
[`docs/self-hosting.md`](docs/self-hosting.md) for the other knobs.

### Optional: real Gmail

Syncing Gmail needs your own Google OAuth client. The steps are in the README
under "Google OAuth (Gmail + Calendar)". Most contributions don't need it.

### Desktop and mobile apps

```bash
# macOS app (needs Xcode / a Swift toolchain)
cd apps/desktop-mac
swift build
swift run KlornMac --self-check              # what CI runs, includes string-table checks
KLORN_API_URL=http://localhost:8000 swift run KlornMac   # against your local API
swift run KlornMac --render-previews /tmp/klorn-previews # renders fixture screens, no server needed

# Windows wrapper (cargo check / test compile on any OS)
cd apps/desktop-win/src-tauri
cargo check
cargo test

# Mobile app (npm, not pnpm)
cd apps/mobile
npm ci
npm run typecheck
npm test
npm run build
```

## Checks (CI runs all of these)

Run the ones that cover what you touched before you push. Paste the commands
you ran and their results into the PR's Test plan.

```bash
# Lint + format (CI pins Biome 2.4.12; use the repo's copy, not a global biome)
packages/api/node_modules/.bin/biome check --diagnostic-level=error packages/

# Types (run `prisma generate` once first, see Database above)
pnpm --filter @klorn/api typecheck
pnpm --filter @klorn/web typecheck

# API unit tests: no database or network needed; the full run takes several minutes
cd packages/api && pnpm exec vitest run
cd packages/api && pnpm exec vitest run src/__tests__/<name>.test.ts   # one file

# Everything builds (what the CI Build job runs)
pnpm -r build
```

**Postgres integration tests** (`*-pg.test.ts`) are skipped unless
`KLORN_TEST_PG_URL` is set. Run them against a throwaway database, never one
you care about:

```bash
docker compose exec postgres psql -U klorn -d klorn -c "CREATE DATABASE klorn_test"
cd packages/api
export DATABASE_URL=postgresql://klorn:klorn-local-dev@localhost:5432/klorn_test
export KLORN_TEST_PG_URL=$DATABASE_URL
pnpm exec prisma migrate deploy
pnpm exec vitest run pg.test.ts
```

**Repo guards.** CI also runs these scripts. Run the relevant ones when you
touch UI copy, the website, lane names, colors or prices:

```bash
node .github/scripts/check-i18n-parity.mjs        # web: every key in all 7 locales
node .github/scripts/check-lane-vocabulary.mjs    # web: lane lists name all five lanes
node .github/scripts/check-lane-identity.mjs      # lane colors stay distinct
bash .github/scripts/check-website-lockstep.sh    # website: translated landings stay in step
node .github/scripts/check-website-lanes.mjs      # website: lane lists consistent
node .github/scripts/check-design-tokens.mjs      # no new off-system styling
node .github/scripts/check-price-consistency.mjs  # one price everywhere
node .github/scripts/check-sitemap.mjs            # sitemap matches published pages
```

**Timing-sensitive tests.** A few tests measure elapsed time and can fail on a
heavily loaded machine. If a test fails locally but passes when you rerun that
one file on an idle machine, say so in the PR; don't loosen the budget.

## Tests

- TDD is expected: write the failing test, then the implementation.
- Pure functions get unit tests; see `packages/api/src/__tests__/` for the
  house style (descriptive `it(...)` names that state the behavior under test,
  Arrange / Act / Assert).
- `packages/web` has no unit-test runner (Playwright e2e only). Pure web
  helpers in `packages/web/src/lib/` are tested from the API suite as
  `packages/api/src/__tests__/web-<name>.test.ts`, importing
  `../../../web/src/lib/<name>`; see `web-meeting-link.test.ts`.
- New behavior without a test will be asked to add one.
- Never put real email addresses, message content, tokens or production
  numbers in fixtures. Use `example.com` addresses and invented content.

## Localization

| Surface | Strings | Check |
|---|---|---|
| Web (`packages/web`) | `packages/web/src/lib/locales/*.ts`, 7 locales (de, en, es, fr, ja, ko, zh), read through `t()` | `node .github/scripts/check-i18n-parity.mjs` |
| Mobile (`apps/mobile`) | `apps/mobile/src/i18n/locales/*.ts`, same 7 locales | `cd apps/mobile && npm test` |
| macOS (`apps/desktop-mac`) | `Sources/KlornMac/Resources/*.lproj/Localizable.strings`, read through `L()` | `swift run KlornMac --self-check` |
| Website (`website/`) | One HTML file per language | `bash .github/scripts/check-website-lockstep.sh` |

- Add a new key to **every** locale in the same PR; the checks fail otherwise.
- The non-English web locales are machine-translated. Native-speaker review is
  very welcome: say which locale you reviewed in the PR.
- Lane names (`PUSH`, `MEETING`, `QUEUE`, `INFO`, `SILENT`) are never translated.
- macOS format strings: integer arguments use `%d`, never `%@` (a mismatch
  crashes at runtime).

## Commits & PRs

- **Conventional commits:** `feat|fix|refactor|docs|test|chore|perf|ci(scope): description`,
  for example `fix(web): route compose confirm strings through t()`.
- Fork, branch, and keep each PR to one concern. Reference the issue in the
  description (`Closes #123`).
- Changes after review go in **new commits**. Never force-push a branch that is
  under review.
- Fill in the PR template's four sections: **Summary**, **Type**,
  **Checklist**, **Test plan**. The Test plan lists the commands you actually
  ran and what they printed (for example `Test Files 705 passed`), plus any
  manual check you did. "Tested locally" alone is not a test plan.
- Never commit `.env` files or secrets (`.env` is gitignored). CI runs secret
  detection.

## Security

Do not open a public issue, PR or discussion for a vulnerability, and don't put
exploit details, crash-triggering inputs, tokens or real user data anywhere
public. Report privately as described in [`SECURITY.md`](SECURITY.md).

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).

## License

Klorn is licensed under **AGPL-3.0-only**. By contributing you agree your work
is licensed under the same license (inbound = outbound). There is no CLA and no
DCO sign-off requirement today. If you run a modified Klorn as a network
service, AGPL requires you to offer your modified source to that service's
users. The open-core boundary (what's AGPLv3 vs. Cloud-only) is documented in
[`docs/EDITIONS.md`](docs/EDITIONS.md). The line is *operational, not
behavioural*: nothing in the classifier or the trust path is feature-gated.
