# Per-user LLM model selection (BYOK-gated) + prod model-default fix

Date: 2026-06-25
Status: design approved, pending implementation plan

## Problem

The LLM model is configured through env vars (`CHAT_MODEL`, `JUDGE_MODEL`, ...).
render.yaml pins these to `google/gemini-2.5-flash` with `value:`, but Render
does not apply those `value:` env vars to the running service (the dashboard has
none). So prod falls back to the in-code default and runs the **free**
`google/gemma-4-31b-it:free` for the `MODEL` (chat/summarize/reply) surfaces.

Two things are wrong:
1. **Prod degradation.** Keyless users' secondary surfaces (summarize, reply,
   meeting, commitment, voice, skill) run on a weak free model. The classifier
   (`JUDGE_MODEL`) is unaffected — it defaults to flash in code and runs at
   temperature 0 (deterministic, #577). So the core firewall is fine; only the
   secondary surfaces are degraded.
2. **Wrong layer.** Model choice lives in ops/env, not product. The founder
   wants users to pick their model in the web, with usage-tiered plans later.

## Verified facts (checked against origin/main before this design)

- `User.chatModel String @default("google/gemma-4-31b-it:free")` and
  `User.agentModel String?` **already exist** in the Prisma schema. They are
  legacy: `PATCH /api/billing/models` still accepts `chatModel`/`agentModel` but
  the code **ignores** them ("model is no longer user-selectable" comment). This
  feature **re-activates** the existing field, not a new one.
- `NODE_ENV=production` **is** set in prod render.yaml — usable as the
  funded-vs-self-host discriminator.
- `createCompletion(params, options)` already receives `options.userId` at the
  call sites, so the per-user model can ride in `options` and be applied
  **centrally** in createCompletion — no need to thread a model into the ~12
  deep call sites that hardcode `model: MODEL`/`JUDGE_MODEL`.
- Curated models confirmed live on the OpenRouter catalog (339 models):
  `google/gemini-2.5-flash`, `openai/gpt-4o`, `anthropic/claude-sonnet-4`,
  `google/gemini-2.5-pro`. (`anthropic/claude-3.7-sonnet` does **not** exist —
  use `claude-sonnet-4`.)

## Design

### Part A — prod model-default fix (small, separable)

Replace the `:free` literal default for the chat/agent surfaces with a
deploy-aware default, keeping self-host free (the open-source story, a locked
decision):

```ts
// openai.ts
const FREE_DEFAULT = "google/gemma-4-31b-it:free";
const PAID_DEFAULT = "google/gemini-2.5-flash";
// Funded deploys (NODE_ENV=production, set on Render) default to the paid,
// capable model so secondary surfaces aren't on a free model when no env
// override is set; self-host / dev keeps :free. Still env-overridable.
const SHARED_DEFAULT =
  process.env.NODE_ENV === "production" ? PAID_DEFAULT : FREE_DEFAULT;

export const MODEL = process.env.CHAT_MODEL || SHARED_DEFAULT;
export const AGENT_MODEL = process.env.AGENT_MODEL || MODEL;
// JUDGE_MODEL already defaults to flash; VISION_MODEL stays flash:free.
```

This alone fixes prod (no Render env), respects self-host, and is ~1 file. It
can ship first/independently if desired.

### Part B — curated model list

A code constant — the single source of truth for what users may pick. Every
entry is multimodal-capable and clears the firewall gates (PUSH recall ≥ 90%,
SILENT precision ≥ 90%), so no choice can silently degrade the firewall:

```ts
// e.g. model-catalog.ts
export const CURATED_MODELS = [
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", note: "Fast + cheap (recommended)" },
  { id: "openai/gpt-4o", label: "GPT-4o", note: "OpenAI" },
  { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4", note: "Anthropic" },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", note: "Google, stronger/pricier" },
] as const;
```

### Part C — per-user model resolution

```
resolveUserModel(user) -> string | null:
  if user.chatModel ∈ CURATED_MODELS.ids AND user has a BYOK key:
      return user.chatModel
  return null   // no override — let the per-surface params.model default apply
```

Returning `null` (not a model) for keyless/unselected users is deliberate: it
leaves the per-surface defaults intact (`JUDGE_MODEL` flash, `MODEL`
`SHARED_DEFAULT`, `VISION_MODEL` flash:free). If it returned a single model, a
keyless user's vision call would silently flip from flash:free to paid flash.

Two guards, both load-bearing:
- **Curated whitelist** — a user can never select an off-list (weak/expensive)
  model, so the firewall can't be silently broken.
- **BYOK gate** — only a user with their own provider key may steer the model,
  because their model runs on their key and quota. Shared-key (free) users keep
  the founder-controlled per-surface defaults, protecting cost and firewall
  quality.

When a model IS returned (BYOK + curated), it applies to **all** of that user's
LLM surfaces (one model per user — classifier, summarize, reply, vision). All
curated models are multimodal, so vision is safe.

### Part D — threading (central, via options)

- Resolve the model where the user is already loaded (the entry points that call
  `getUserLlmCredentials(userId)`): extend that one DB read to also return the
  resolved model (one fetch, not two), and pass it in `options` to
  `createCompletion`.
- `createCompletion` applies it centrally: `const model = options.userModel ??
  params.model`, then uses `model` for the provider call, `enforceCostGates`,
  and `estimatePrebillCents` (both non-streaming and streaming overloads).
- The ~12 deep call sites that hardcode `model: MODEL`/`JUDGE_MODEL` are
  **unchanged**: their constant becomes the fallback used when no per-user model
  is supplied (keyless users, system jobs).

Net change: `openai.ts` (Part A default + central override), the credential
resolver (also return the model), the ~6 user-scoped entry points (pass the
model in options, alongside credentials they already thread). No 12-site churn.

### Part E — API

`packages/api/src/routes/billing.ts`, the existing `/api/billing/models`:
- `GET` adds `availableModels: CURATED_MODELS` and `selectedModel: user.chatModel`.
- `PATCH` **stops ignoring** `chatModel`: validate it is in `CURATED_MODELS`
  (reject otherwise with 400), then store. (Optionally also honor a "reset to
  default" by clearing it.)

### Part F — UI

Extend the just-shipped `ByokKeysSection` (`packages/web/src/components`):
- A model `<select>` populated from `availableModels`, value `selectedModel`.
- **BYOK-gated**: enabled only when the user has at least one key; otherwise
  disabled with helper text "Add a key to choose a model".
- On change → `PATCH /api/billing/models { chatModel }` → reload status.

## Out of scope (YAGNI / deferred)

- **Token-based plans / pricing tiers.** Deferred until there are real users —
  building pricing pre-distribution is premature (this session's recurring
  conclusion: the engine is at its signal ceiling; the bottleneck is
  distribution, not features). Keep the implicit split simple: free (shared key,
  existing cost caps) vs BYOK (your key/model/quota).
- **Per-surface model choice** (different model for judge vs chat). One model
  per user for v1.
- **Free-text any-model entry.** Curated list only.

## Testing

- `resolveUserModel`: curated-whitelist enforcement, BYOK gate, `SHARED_DEFAULT`
  for keyless, prod-vs-self-host default (NODE_ENV).
- `createCompletion`: `options.userModel` overrides `params.model` for the
  provider call + cost gates; absent → `params.model` fallback unchanged.
- `PATCH /api/billing/models`: accepts a curated `chatModel`, rejects an
  off-list one (400), persists.
- Web has no test framework — UI verified by `next build` + manual dogfood
  (consistent with `ByokKeysSection`).

## Rollout

Part A (prod default fix) is independent and low-risk — it can merge first to
stop the live degradation immediately. Parts B–F (per-user selection) follow as
the product feature.
