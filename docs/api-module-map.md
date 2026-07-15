# `packages/api/src` module map

Working plan for decomposing the flat api package (~180 top-level files,
94K lines including routes/tests) into domain modules, one slice per PR.
Motivation: navigability, reviewable boundaries, and build pressure — the
flat package already OOM'd `tsc` on Render (#807). Grounded in the actual
import graph (564 intra-src edges, measured 2026-07-15), not filename vibes.

`index.ts` stays at the src root as the composition root. `routes/`,
`providers/`, `prompts/`, `agent/`, `scripts/`, `__tests__/`, `__fixtures__/`
keep their existing homes.

## Target modules

| module | files | LOC | what lives there |
|---|---|---|---|
| `notify/` ✅ (this PR) | 21 | ~3.0K | push (web/APNs/FCM), telegram, sms, phone escalation, quiet hours, notification policy/prefs/format, welcome email, urgent dedup |
| `judge/` | ~23 | ~6.1K | poc-judge, tier-policy, keyword-policy, tiers, judge-context/cache/dial/health, email-firewall, attention-*, decision-*, calibration*, selective-threshold |
| `mail/` | ~25 | ~9.4K | gmail*, email-sync, email-* IO, attachments + file-conversion*, naver-imap*, github-* source connectors |
| `agentcore/` | ~23 | ~6.3K | autonomous-agent*, agent-*, tool-executor, chat-engine, skill-*, playbooks, proactive-actions, action-*, auto-reply-send, email-action-trigger |
| `learning/` | ~26 | ~5.2K | pattern-learner, learned-rule*, sender-trait*, sender-policy, contact-engagement, interaction-graph, ontology*, feedback*, trust-score, memory |
| `billing/` | ~9 | ~1.3K | stripe, paddle, quota-limiter, cost-guard, cents, token-usage, llm-usage, tier-override-token |
| `pim/` | ~22 | ~6.4K | commitments*, tasks, notes, reminders, calendar, briefing*, contacts, work-graph, operating-plan, meeting-*, inbox-summary |
| `llm/` | ~10 | ~2.1K | openai, model-fallback, openrouter-*, llm-coerce/json, parse helpers |
| `infra/` | ~20 | ~3.7K | db*, config, auth, crypto-tokens, sentry, websocket, semaphore, with-timeout, timing-safe-equal, untrusted, perf-monitor, timezone helpers |

Boundary calls made from the graph (not names): `tiers.ts`/`tier-policy.ts`
belong to **judge** (classification vocabulary, not billing); `github-*` are
**mail** source connectors like naver-imap; `memory.ts` sits in **learning**
(majority importer); `automation-scheduler.ts` is a 9-module straddler — leave
it at the src root next to `index.ts` until last.

## Slice order (each slice = one PR, full gate)

1. **notify/** ✅ #808 (21 files)
2. **billing/** ✅ #810 (9)
3. **llm/** ✅ #812 (9)
4. **pim/** ✅ #813 (20) · **learning/** ✅ #815 (24) · **agentcore/** ✅ #816 (24)
5. **judge/** ✅ #817 (22 — all R100 byte-identical; eval.yml trigger replaced
   with `src/judge/**`) · **mail/** ✅ (26; `search.ts` deleted — dead code, its
   two stale defensive `vi.mock` lines removed with it)
6. `infra/` — **deliberately skipped**: what remains at the src root is the
   composition root (`index.ts`), cross-cutting infra (db*, config, auth,
   websocket, sentry, crypto-tokens, error-handler, small utils), scheduler
   straddlers (`automation-scheduler`, `background`, `scheduler-heartbeat`),
   and root eval infra (`eval-context`, `eval-floors`,
   `email-classification-eval`, `canary-compare` — the eval track's active
   work area). Moving these is maximal churn (100+ importer files) for the
   least semantic gain; revisit only if the root grows again.

## Move checklist (learned on slice 1)

- Rewrite BOTH `from "./x.js"` and dynamic `import("./x.js")` — 56 literal
  dynamic imports exist; preserve the ESM `.js` suffix.
- `packages/api/scripts/` is OUTSIDE `tsconfig.include` — `tsc` will not catch
  stale `"../src/<moved>.js"` imports there; grep it explicitly.
- ⚠️ `.github/workflows/eval.yml` hardcodes `packages/api/src/poc-judge.ts`,
  `email-classifier.ts`, `tiers.ts` as path triggers — the **judge/** slice
  MUST update these paths or the eval-floor CI silently stops running.
- Run the repo-pinned biome (`packages/api/node_modules/.bin/biome`), not
  `npx` (which pulls a newer version with false positives); path rewrites
  break `organizeImports` ordering — auto-fixable.
- `search.ts` is dead code (zero importers) — delete during the mail/ slice
  instead of moving it.
- Gate per slice: `prisma generate` → `tsc --noEmit` → full `vitest run` →
  pinned biome → `pnpm build` → grep for stale specifiers outside `dist/`.
