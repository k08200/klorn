# @klorn/core-shim — temporary Render build shim

**This is NOT the old `@klorn/core` package** (the dead EVE-era eval CLI removed in #821).
It is an empty package whose only job is to make `cd packages/core && pnpm build` a no-op.

## Why it exists

The Render service `klorn-api` lost its GitHub connection (deploy logs show
`It looks like we don't have access to your repo`), so Blueprint sync stopped
applying `render.yaml` changes. The service is frozen on a buildCommand last
synced around 2026-07-09 (#770), which still contains:

```
cd packages/core && pnpm build &&
```

After #821 deleted `packages/core`, every deploy fails with
`ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND` before the api even builds — prod has
been stuck on an old commit since. This shim makes the stale command succeed
so deploys are unblocked without dashboard access. (The other stale-command
gap — the missing #807 heap pin — is already covered because
`packages/api` pins `NODE_OPTIONS=--max-old-space-size=4096` in its own
`build` script.)

## How to remove it

1. Fix the Render ↔ GitHub connection (re-link the repo / reinstall the
   Render GitHub App on `k08200/klorn` in the Render dashboard), so Blueprint
   sync resumes and the current `render.yaml` buildCommand (which does not
   reference `packages/core`) takes effect. Alternatively, paste the current
   `render.yaml` buildCommand into the service's build settings manually.
2. Verify one deploy succeeds with a build log that no longer contains
   `cd packages/core`.
3. Delete `packages/core/` entirely and run `pnpm install` to update the
   lockfile.
