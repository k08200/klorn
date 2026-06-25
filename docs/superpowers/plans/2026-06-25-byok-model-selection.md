# Per-user BYOK Model Selection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a BYOK user pick their LLM model from a curated list in Settings, and fix prod's secondary surfaces falling back to the free model.

**Architecture:** The per-user model rides on the `ProviderCredentials` object already resolved by `getUserLlmCredentials(userId)` and already threaded into `createCompletion(params, options)` at every user-scoped call site — so `createCompletion` applies it centrally (`options.credentials?.userModel ?? params.model`) with **zero new threading**. A deploy-aware `SHARED_DEFAULT` fixes the prod free-model fallback. Selection is gated by a curated whitelist (no firewall degradation) and BYOK (their key, their cost).

**Tech Stack:** TypeScript, Fastify 5, Prisma 6, Next.js 15 / React 19, Vitest, Biome.

**Worktree:** `/tmp/klorn-model-select` on `feat/byok-model-selection` off `origin/main` (#582). Spec: `docs/superpowers/specs/2026-06-25-byok-model-selection-design.md`.

**Ship rule:** Run the CI mirror locally before each PR — `cd packages/api && npx tsc --noEmit`, `npx biome check --diagnostic-level=error packages/` (from repo root, covers scripts/), `npx vitest run`, and for web `cd packages/web && pnpm build`. Pre-merge hook needs `KLORN_SKIP_SEC_REVIEW=1` after review. Never force-push.

---

## File Structure

- `packages/api/src/openai.ts` — MODIFY: `SHARED_DEFAULT` (Task 1); apply `options.credentials.userModel` override in both createCompletion paths (Task 4).
- `packages/api/src/model-catalog.ts` — CREATE: `CURATED_MODELS` constant + `isCuratedModel()` (Task 2).
- `packages/api/src/providers/index.ts` — MODIFY: add `userModel?: string` to `ProviderCredentials` (Task 3).
- `packages/api/src/llm-credentials.ts` — MODIFY: fetch `chatModel`, resolve `userModel` (Task 3).
- `packages/api/src/routes/billing.ts` — MODIFY: GET `/models` returns `availableModels`+`selectedModel`; PATCH un-ignores + whitelists `chatModel` (Task 5).
- `packages/web/src/components/byok-keys-section.tsx` — MODIFY: model `<select>`, BYOK-gated (Task 6).
- Tests: `packages/api/src/__tests__/model-catalog.test.ts`, `llm-credentials.test.ts` (extend), `byok-model-override.test.ts`, `routes-billing-models.test.ts` (new or extend).

---

## Task 1: Part A — deploy-aware shared default (separable, ship first)

**Files:**
- Modify: `packages/api/src/openai.ts:42-43`
- Test: `packages/api/src/__tests__/shared-default-model.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/api/src/__tests__/shared-default-model.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";

describe("shared default model", () => {
  const orig = process.env.NODE_ENV;
  const origChat = process.env.CHAT_MODEL;
  afterEach(() => {
    process.env.NODE_ENV = orig;
    if (origChat === undefined) delete process.env.CHAT_MODEL;
    else process.env.CHAT_MODEL = origChat;
    vi.resetModules();
  });

  it("defaults MODEL to paid flash on a funded deploy (NODE_ENV=production)", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.CHAT_MODEL;
    vi.resetModules();
    const { MODEL } = await import("../openai.js");
    expect(MODEL).toBe("google/gemini-2.5-flash");
  });

  it("keeps the :free default off prod (self-host)", async () => {
    process.env.NODE_ENV = "test";
    delete process.env.CHAT_MODEL;
    vi.resetModules();
    const { MODEL } = await import("../openai.js");
    expect(MODEL).toBe("google/gemma-4-31b-it:free");
  });

  it("still honors an explicit CHAT_MODEL override", async () => {
    process.env.NODE_ENV = "production";
    process.env.CHAT_MODEL = "openai/gpt-4o";
    vi.resetModules();
    const { MODEL } = await import("../openai.js");
    expect(MODEL).toBe("openai/gpt-4o");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run src/__tests__/shared-default-model.test.ts`
Expected: FAIL — prod case returns `gemma-4-31b-it:free`, not flash.

- [ ] **Step 3: Implement**

Replace `packages/api/src/openai.ts:42-43`:

```ts
// Funded deploys (NODE_ENV=production, set on Render) default the chat/agent
// surfaces to the paid, capable model so they aren't on a free model when no
// env override is set; self-host / dev keeps :free (open-source default).
// Per-surface envs (CHAT_MODEL/AGENT_MODEL) still override.
const FREE_DEFAULT = "google/gemma-4-31b-it:free";
const PAID_DEFAULT = "google/gemini-2.5-flash";
const SHARED_DEFAULT = process.env.NODE_ENV === "production" ? PAID_DEFAULT : FREE_DEFAULT;

export const MODEL = process.env.CHAT_MODEL || SHARED_DEFAULT;
export const AGENT_MODEL = process.env.AGENT_MODEL || MODEL;
```

(Leave JUDGE_MODEL/DRAFT_MODEL/VISION_MODEL unchanged — JUDGE already defaults to flash.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/api && npx vitest run src/__tests__/shared-default-model.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Full suite + tsc (guard against a test that asserted the old default)**

Run: `cd packages/api && npx vitest run && npx tsc --noEmit`
Expected: all green. If any test hardcoded `MODEL === "...gemma...:free"`, update it to the env-dependent value.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/openai.ts packages/api/src/__tests__/shared-default-model.test.ts
KLORN_SKIP_SEC_REVIEW=1 git commit -m "fix(llm): default chat/agent model to flash on funded deploys (NODE_ENV)"
```

> Task 1 is independently shippable. If stopping the live degradation is urgent, open a PR with just this commit before continuing.

---

## Task 2: Curated model catalog

**Files:**
- Create: `packages/api/src/model-catalog.ts`
- Test: `packages/api/src/__tests__/model-catalog.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/api/src/__tests__/model-catalog.test.ts
import { describe, expect, it } from "vitest";
import { CURATED_MODELS, CURATED_MODEL_IDS, isCuratedModel } from "../model-catalog.js";

describe("model catalog", () => {
  it("lists only multimodal, firewall-capable models with flash recommended first", () => {
    expect(CURATED_MODELS[0].id).toBe("google/gemini-2.5-flash");
    expect(CURATED_MODEL_IDS).toContain("openai/gpt-4o");
    expect(CURATED_MODEL_IDS).toContain("anthropic/claude-sonnet-4");
    expect(CURATED_MODEL_IDS).toContain("google/gemini-2.5-pro");
  });

  it("accepts a curated id and rejects anything else", () => {
    expect(isCuratedModel("openai/gpt-4o")).toBe(true);
    expect(isCuratedModel("google/gemma-4-31b-it:free")).toBe(false); // weak — not selectable
    expect(isCuratedModel("anthropic/claude-3.7-sonnet")).toBe(false); // not live
    expect(isCuratedModel("")).toBe(false);
    expect(isCuratedModel(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run src/__tests__/model-catalog.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/api/src/model-catalog.ts
/**
 * The only models a user may select. Single source of truth for the UI list
 * and the PATCH whitelist. Every entry is verified live on OpenRouter, is
 * multimodal (vision-safe), and clears the firewall gates (PUSH recall >= 90%,
 * SILENT precision >= 90%) — so no selectable model can silently degrade the
 * firewall. Order matters: index 0 is the recommended default shown first.
 */
export interface CuratedModel {
  id: string;
  label: string;
  note: string;
}

export const CURATED_MODELS: ReadonlyArray<CuratedModel> = [
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", note: "Fast + cheap (recommended)" },
  { id: "openai/gpt-4o", label: "GPT-4o", note: "OpenAI" },
  { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4", note: "Anthropic" },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", note: "Google, stronger/pricier" },
] as const;

export const CURATED_MODEL_IDS: ReadonlyArray<string> = CURATED_MODELS.map((m) => m.id);

export function isCuratedModel(id: string | null | undefined): boolean {
  return typeof id === "string" && CURATED_MODEL_IDS.includes(id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/api && npx vitest run src/__tests__/model-catalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/model-catalog.ts packages/api/src/__tests__/model-catalog.test.ts
KLORN_SKIP_SEC_REVIEW=1 git commit -m "feat(llm): curated model catalog (single source for UI + whitelist)"
```

---

## Task 3: Resolve the per-user model onto the credentials object

**Files:**
- Modify: `packages/api/src/providers/index.ts` (`ProviderCredentials` interface)
- Modify: `packages/api/src/llm-credentials.ts`
- Test: `packages/api/src/__tests__/llm-credentials.test.ts` (extend)

- [ ] **Step 1: Add the field to the interface**

In `packages/api/src/providers/index.ts`, add to `interface ProviderCredentials`:

```ts
  /**
   * Per-user model override, resolved by getUserLlmCredentials: the user's
   * chosen model ONLY when it is curated AND they have a BYOK key, else
   * undefined. Rides with the credentials so createCompletion can apply it
   * centrally without new threading. undefined => keep the per-surface default.
   */
  userModel?: string;
```

- [ ] **Step 2: Write the failing test (extend existing llm-credentials.test.ts)**

The existing test mocks `prisma.user.findUnique`, `decryptOptional`, `captureError`. Add cases. Note `getUserLlmCredentials` must now `select` `chatModel` too.

```ts
  it("sets userModel when the user has a BYOK key and a curated chatModel", async () => {
    findUnique.mockResolvedValue({
      openRouterApiKey: "cipher:sk-or",
      geminiApiKey: null,
      chatModel: "openai/gpt-4o",
    });
    const creds = await getUserLlmCredentials("u1");
    expect(creds.userModel).toBe("openai/gpt-4o");
  });

  it("leaves userModel undefined when the user has no key (keyless keeps defaults)", async () => {
    findUnique.mockResolvedValue({
      openRouterApiKey: null,
      geminiApiKey: null,
      chatModel: "openai/gpt-4o",
    });
    const creds = await getUserLlmCredentials("u1");
    expect(creds.userModel).toBeUndefined();
  });

  it("leaves userModel undefined when chatModel is not curated", async () => {
    findUnique.mockResolvedValue({
      openRouterApiKey: "cipher:sk-or",
      geminiApiKey: null,
      chatModel: "google/gemma-4-31b-it:free",
    });
    const creds = await getUserLlmCredentials("u1");
    expect(creds.userModel).toBeUndefined();
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/api && npx vitest run src/__tests__/llm-credentials.test.ts`
Expected: FAIL — `userModel` is undefined in the first case (resolution not implemented).

- [ ] **Step 4: Implement**

In `packages/api/src/llm-credentials.ts`:
1. Import: `import { isCuratedModel } from "./model-catalog.js";`
2. Add `chatModel: true` to the `prisma.user.findUnique` `select`.
3. After resolving the decrypted keys, compute and include `userModel`:

```ts
  const openRouterApiKey = safeDecrypt(user.openRouterApiKey, "openRouterApiKey", userId);
  const geminiApiKey = safeDecrypt(user.geminiApiKey, "geminiApiKey", userId);
  const hasKey = Boolean(openRouterApiKey) || Boolean(geminiApiKey);
  const chatModel = (user as { chatModel?: string | null }).chatModel;
  // Only steer the model for BYOK users picking a curated model — otherwise the
  // per-surface defaults stand (a keyless user's vision stays flash:free).
  const userModel = hasKey && isCuratedModel(chatModel) ? (chatModel as string) : undefined;

  return { openRouterApiKey, geminiApiKey, quotaScope: userId, userModel };
```

(The DB-error/decrypt-error degrade paths return `{}` as before — `userModel` is naturally undefined there.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/api && npx vitest run src/__tests__/llm-credentials.test.ts`
Expected: PASS (existing + 3 new).

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/providers/index.ts packages/api/src/llm-credentials.ts packages/api/src/__tests__/llm-credentials.test.ts
KLORN_SKIP_SEC_REVIEW=1 git commit -m "feat(llm): resolve per-user model (BYOK + curated) onto credentials"
```

---

## Task 4: Apply the per-user model centrally in createCompletion

**Files:**
- Modify: `packages/api/src/openai.ts` (both createCompletion code paths — near `const userKeyAvailable = ...` at ~271 and ~485)
- Test: `packages/api/src/__tests__/byok-model-override.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/api/src/__tests__/byok-model-override.test.ts
import { describe, expect, it, vi } from "vitest";

// Mock the provider chain so createCompletion calls a fake client we can inspect.
const create = vi.hoisted(() => vi.fn(async () => ({ choices: [{ message: { content: "{}" } }], usage: null })));
vi.mock("../providers/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers/index.js")>();
  return {
    ...actual,
    getProviderChain: () => [
      { name: "openrouter", quotaKey: "openrouter:env", client: { chat: { completions: { create } } },
        supportsTools: true, resolveModel: (m: string) => m },
    ],
  };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { createCompletion } from "../openai.js";

describe("createCompletion — per-user model override", () => {
  it("uses options.credentials.userModel for the provider call when set", async () => {
    create.mockClear();
    await createCompletion(
      { model: "google/gemma-4-31b-it:free", messages: [{ role: "user", content: "hi" }] },
      { userId: "u1", credentials: { userModel: "openai/gpt-4o" } },
    );
    expect(create.mock.calls[0]?.[0]?.model).toBe("openai/gpt-4o");
  });

  it("falls back to params.model when no userModel", async () => {
    create.mockClear();
    await createCompletion(
      { model: "google/gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] },
      { userId: "u1", credentials: {} },
    );
    expect(create.mock.calls[0]?.[0]?.model).toBe("google/gemini-2.5-flash");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run src/__tests__/byok-model-override.test.ts`
Expected: FAIL — first test sees `gemma...:free` (override not applied). (If the provider-chain mock shape needs tweaking to match the real `Provider` type, adjust it — the assertion on `create.mock.calls[0][0].model` is the contract.)

- [ ] **Step 3: Implement**

In `packages/api/src/openai.ts`, in BOTH createCompletion paths, immediately after the line `const userKeyAvailable = hasUserOwnedProvider(chain, playgroundOnly);` (~271 and ~485), reassign `params` so every downstream `params.model` use (provider call, `enforceCostGates`, `estimatePrebillCents`, `trueUpCostLedgers`) picks it up:

```ts
  // BYOK users may steer the model (curated only — resolved in llm-credentials).
  // Reassign once so the provider call + cost ledgers all use the chosen model.
  if (options.credentials?.userModel) {
    params = { ...params, model: options.credentials.userModel };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/api && npx vitest run src/__tests__/byok-model-override.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + tsc**

Run: `cd packages/api && npx vitest run && npx tsc --noEmit`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/openai.ts packages/api/src/__tests__/byok-model-override.test.ts
KLORN_SKIP_SEC_REVIEW=1 git commit -m "feat(llm): apply per-user model override centrally in createCompletion"
```

---

## Task 5: API — expose the catalog + re-activate PATCH chatModel

**Files:**
- Modify: `packages/api/src/routes/billing.ts` (the `GET /models` and `PATCH /models` handlers)
- Test: `packages/api/src/__tests__/routes-billing-models.test.ts`

- [ ] **Step 1: Write the failing test**

Mock prisma + auth as the existing billing tests do. Assert:

```ts
  it("GET /models returns the curated list and the user's selected model", async () => {
    // mock user.findUnique -> { plan, chatModel: "openai/gpt-4o", openRouterApiKey: "x" }
    const res = await app.inject({ method: "GET", url: "/api/billing/models", headers: auth });
    const body = res.json();
    expect(body.availableModels.map((m: any) => m.id)).toContain("google/gemini-2.5-flash");
    expect(body.selectedModel).toBe("openai/gpt-4o");
  });

  it("PATCH /models persists a curated chatModel", async () => {
    const res = await app.inject({ method: "PATCH", url: "/api/billing/models",
      headers: auth, payload: { chatModel: "anthropic/claude-sonnet-4" } });
    expect(res.statusCode).toBe(200);
    // assert prisma.user.update called with data.chatModel === "anthropic/claude-sonnet-4"
  });

  it("PATCH /models rejects an off-catalog chatModel with 400", async () => {
    const res = await app.inject({ method: "PATCH", url: "/api/billing/models",
      headers: auth, payload: { chatModel: "some/unknown-model" } });
    expect(res.statusCode).toBe(400);
  });
```

(If the existing billing test file already builds an app harness, extend it instead of creating a new one.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run src/__tests__/routes-billing-models.test.ts`
Expected: FAIL — `availableModels` missing; off-catalog model is accepted (currently ignored, returns 200).

- [ ] **Step 3: Implement**

In `packages/api/src/routes/billing.ts`:
1. Import `import { CURATED_MODELS, isCuratedModel } from "../model-catalog.js";`
2. In `GET /models`, add to the returned object: `availableModels: CURATED_MODELS,` and `selectedModel: (user as { chatModel?: string | null }).chatModel ?? null,`.
3. In `PATCH /models`: it currently accepts `chatModel` in the body schema but ignores it. Replace the ignore with:

```ts
    if (typeof chatModel === "string") {
      if (!isCuratedModel(chatModel)) {
        return reply.code(400).send({ error: "Unsupported model" });
      }
      updateData.chatModel = chatModel;
    }
```

(`updateData` is the object already passed to `prisma.user.update`. Keep the existing key-handling untouched.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/api && npx vitest run src/__tests__/routes-billing-models.test.ts`
Expected: PASS (3).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/billing.ts packages/api/src/__tests__/routes-billing-models.test.ts
KLORN_SKIP_SEC_REVIEW=1 git commit -m "feat(api): expose curated models + persist a whitelisted chatModel"
```

---

## Task 6: UI — model dropdown in ByokKeysSection (BYOK-gated)

**Files:**
- Modify: `packages/web/src/components/byok-keys-section.tsx`

No web test framework — verify via `next build` + manual dogfood (matches the section's existing pattern).

- [ ] **Step 1: Extend the status type + state**

In `byok-keys-section.tsx`, extend `ModelStatus`:

```ts
interface CuratedModelOption { id: string; label: string; note: string }
interface ModelStatus {
  activeModel: string;
  hasOpenRouterApiKey: boolean;
  hasGeminiApiKey: boolean;
  availableModels: CuratedModelOption[];
  selectedModel: string | null;
}
```

Add state for the in-flight model save and read `status.availableModels` / `status.selectedModel`.

- [ ] **Step 2: Add the dropdown (BYOK-gated)**

Inside the section, above or below the provider rows, render — enabled only when a key is set:

```tsx
{(() => {
  const anyKey = !!status?.hasOpenRouterApiKey || !!status?.hasGeminiApiKey;
  const options = status?.availableModels ?? [];
  return (
    <div className="rounded-md border border-stone-800 bg-stone-900/40 p-3">
      <label htmlFor="byok-model" className="mb-1 block text-xs text-stone-400">
        Model
      </label>
      <select
        id="byok-model"
        disabled={!anyKey || savingModel}
        value={status?.selectedModel ?? options[0]?.id ?? ""}
        onChange={(e) => void saveModel(e.target.value)}
        className="w-full rounded-md border border-stone-700 bg-stone-900/60 px-3 py-2 text-sm text-stone-100 focus:border-amber-500/60 focus:outline-none disabled:opacity-50"
      >
        {options.map((m) => (
          <option key={m.id} value={m.id}>{m.label} — {m.note}</option>
        ))}
      </select>
      {!anyKey && (
        <p className="mt-1 text-[11px] text-stone-500">Add a key above to choose a model.</p>
      )}
    </div>
  );
})()}
```

- [ ] **Step 3: Add the save handler**

```ts
const [savingModel, setSavingModel] = useState(false);
const saveModel = async (chatModel: string) => {
  if (savingModel) return;
  setSavingModel(true);
  setError(null);
  try {
    await apiFetch("/api/billing/models", { method: "PATCH", body: JSON.stringify({ chatModel }) });
    await loadStatus();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    captureClientError(err, { scope: "byok.model" });
    setError(msg || "Could not change the model.");
  } finally {
    setSavingModel(false);
  }
};
```

- [ ] **Step 4: Verify build + lint**

Run from repo root: `npx biome check --diagnostic-level=error packages/web/src/components/byok-keys-section.tsx`
Run: `cd packages/web && pnpm build`
Expected: biome EXIT 0; build "Compiled successfully" + /settings static page generated.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/byok-keys-section.tsx
KLORN_SKIP_SEC_REVIEW=1 git commit -m "feat(web): model dropdown in BYOK settings (gated, curated)"
```

---

## Task 7: Full CI mirror + ship

- [ ] **Step 1: Run the complete CI mirror**

```bash
cd packages/api && npx tsc --noEmit && cd ../core && npx tsc --noEmit
cd /tmp/klorn-model-select && npx biome check --diagnostic-level=error packages/
cd packages/api && npx vitest run
cd ../web && pnpm build
```
Expected: all green. (Watch biome import-sort + any CodeQL surface — no new fs/path or temp-file code here, so CodeQL should stay clean.)

- [ ] **Step 2: Push + PR**

```bash
cd /tmp/klorn-model-select
git push -u origin feat/byok-model-selection
gh pr create --base main --title "feat: per-user BYOK model selection + prod model-default fix" --body "<4-section body: Summary / Type / Checklist / Test plan>"
```

- [ ] **Step 3: Watch CI -> fix-loop (max 3, root-cause each) -> confirm -> squash-merge**

- [ ] **Step 4: Post-merge cleanup**

```bash
cd /Users/yongrean/Downloads/klorn
git worktree remove /tmp/klorn-model-select
git branch -D feat/byok-model-selection
git push origin --delete feat/byok-model-selection
```

- [ ] **Step 5: Dogfood prod after deploy**

Verify in live Settings: BYOK key set -> Model dropdown enabled -> pick GPT-4o -> "Active model" reflects it; keyless user -> dropdown disabled; prod "Active model" no longer gemma:free.
