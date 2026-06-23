# @klorn/desktop

The Klorn desktop shell — a personal command center that wraps the Klorn web app
in a native window and reads the same shared ontology the firewall runs on.

v0 is a thin Electron frame. It is the seam where the command center grows: one
local window that holds the email firewall now, and additional surfaces (Ripple,
AutoView) later — all reading one shared deterministic core.

## Why Electron, not Tauri

The repo's stack is locked to **TypeScript only** (CLAUDE.md). Tauri pulls in a
Rust toolchain; Electron stays all-TS. So Electron.

## Run

The shell renders the web app and talks to the API — start both first:

```bash
# from the repo root
pnpm dev            # api on :3001, web on :8001

# then, in another terminal
pnpm --filter @klorn/desktop dev
```

Override the targets without a rebuild:

```bash
KLORN_DESKTOP_URL=https://app.klorn.ai \
KLORN_API_URL=https://api.klorn.ai \
  pnpm --filter @klorn/desktop start
```

## The ontology bridge

`preload.ts` exposes a read-only `window.klorn`:

- `window.klorn.getOntology()` — fetches `/api/admin/ontology`, the JSON
  snapshot of the tier rule, sender priors, keyword patterns, and model dial the
  classifier currently runs on (`ontology.ts:describePolicy`). Throws on a
  non-2xx response or invalid JSON — callers must handle the rejection.

The preload runs sandboxed; the API base is injected by the main process via
`additionalArguments`, not read from `process.env`.

This makes the desktop the first non-API consumer of the shared brain — the
read side of "every surface reads/writes one ontology".

## Layout

| File | Role |
|------|------|
| `src/main.ts` | Electron main process — window, external-link routing |
| `src/preload.ts` | `window.klorn` bridge (read-only) |
| `src/config.ts` | env-overridable web + API URLs |
