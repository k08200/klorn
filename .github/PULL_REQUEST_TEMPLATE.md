## Summary
<!-- What changed and why, in a few sentences. Link the issue: "Closes #123". -->


## Type
- [ ] Feature
- [ ] Bug fix
- [ ] Refactor
- [ ] Tests
- [ ] i18n
- [ ] Docs
- [ ] CI/Config

## Checklist
- [ ] `packages/api/node_modules/.bin/biome check --diagnostic-level=error packages/` passes
- [ ] Typecheck passes for the packages I touched (`pnpm --filter @klorn/api typecheck`, `pnpm --filter @klorn/web typecheck`)
- [ ] Tests added or updated, and `cd packages/api && pnpm exec vitest run` passes (or the relevant app's tests)
- [ ] New UI strings exist in every locale (`node .github/scripts/check-i18n-parity.mjs`)
- [ ] Lanes are only PUSH / MEETING / QUEUE / INFO / SILENT
- [ ] No `.env`, secrets, or real user data (email addresses, message content, tokens, production numbers) in code, fixtures, screenshots or this description

## Test plan
<!--
List the commands you actually ran and what they printed, plus any manual check.
Example:
- `cd packages/api && pnpm exec vitest run src/__tests__/text.test.ts` → 12 passed
- `pnpm --filter @klorn/web typecheck` → no errors
- Opened /settings at 390px wide; the new toggle is reachable by keyboard
-->

