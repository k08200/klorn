/**
 * Playground model menu and storage rules — the pure rules behind the page:
 *   - the model menu is exactly the founder-approved list (option A, LOCKED,
 *     2026-10-30), per native provider tab since the Claude-only switch
 *     (2026-11-01): no proxy tab, no proxy-only models, one measured claim on
 *     the model Klorn's judge runs, native ids the API's own provider adapters
 *     pass through unchanged;
 *   - a key is stored only with consent, stale auto-saved keys are dropped,
 *     and a retired provider's key is dropped even with consent;
 *   - "decided the lane" comes from the server's rule name, never a guess.
 */

import { describe, expect, it } from "vitest";
import { explainDecision } from "../../../web/src/app/playground/decided";
import {
  dropUnconsentedKeys,
  forgetKey,
  keyStorageFor,
  LEGACY_KEY_STORAGE,
  loadProvider,
  loadRememberedKey,
  RETIRED_PROVIDER_SLOTS,
  rememberKey,
  rememberMarkerFor,
} from "../../../web/src/app/playground/key-storage";
import {
  defaultModelFor,
  formatPrice,
  isValidModelId,
  KLORN_MODEL_ID,
  modelFitsProvider,
  modelsFor,
  PLAYGROUND_MODELS,
  PLAYGROUND_PROVIDERS,
} from "../../../web/src/app/playground/models";
import { RECOMMENDED_JUDGE_MODEL } from "../llm/judge-model-gate.js";
import { toAnthropicModelId } from "../providers/anthropic-config.js";
import { PLAYGROUND_MODEL_ID_PATTERN } from "../routes/playground.js";

const allModels = () => PLAYGROUND_PROVIDERS.flatMap((p) => modelsFor(p));

describe("playground model list", () => {
  it("offers exactly the native provider tabs, Anthropic first", () => {
    expect(PLAYGROUND_PROVIDERS).toEqual(["anthropic", "openai", "gemini"]);
  });

  it("is exactly the approved list per tab, in order", () => {
    expect(modelsFor("anthropic").map((m) => m.id)).toEqual([
      "claude-haiku-5-5",
      "claude-fable-5-1",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
    ]);
    expect(modelsFor("openai").map((m) => m.id)).toEqual([
      "gpt-6.1-terra",
      "gpt-6.1-sol",
      "gpt-6-luna",
    ]);
    expect(modelsFor("gemini").map((m) => m.id)).toEqual(["gemini-4-argon", "gemini-3.8-flash"]);
  });

  it("carries no retired, :free or proxy-only ids", () => {
    for (const { id } of allModels()) {
      expect(id).not.toMatch(/:free|llama|qwen|gpt-oss|nemotron|claude-3|gpt-4o|grok|x-ai|\//);
    }
  });

  it("makes exactly one measured claim: the model Klorn's judge runs, 52–55/56 over 5 runs", () => {
    expect(KLORN_MODEL_ID).toBe("claude-haiku-5-5");
    expect(KLORN_MODEL_ID).toBe(RECOMMENDED_JUDGE_MODEL);
    const measured = allModels().filter((m) => m.measured);
    expect(measured).toEqual([
      expect.objectContaining({
        id: KLORN_MODEL_ID,
        measured: { low: 52, high: 55, total: 56, runs: 5 },
      }),
    ]);
  });

  it("defaults to the Klorn model on its tab, the cheapest listed model elsewhere", () => {
    expect(defaultModelFor("anthropic")).toBe("claude-haiku-5-5");
    expect(defaultModelFor("openai")).toBe("gpt-6-luna");
    expect(defaultModelFor("gemini")).toBe("gemini-3.8-flash");
  });

  it("native Anthropic ids pass through the API's own adapter unchanged", () => {
    for (const m of modelsFor("anthropic")) {
      expect(toAnthropicModelId(m.id, "fallback")).toBe(m.id);
    }
  });

  it("every listed id passes the same shape the API enforces", () => {
    const api = new RegExp(PLAYGROUND_MODEL_ID_PATTERN);
    for (const m of allModels()) {
      expect(isValidModelId(m.id)).toBe(true);
      expect(api.test(m.id)).toBe(true);
    }
    for (const bad of ["bad id", "google/..", "a..b", "x?y=1"]) {
      expect(isValidModelId(bad)).toBe(false);
      expect(api.test(bad)).toBe(false);
    }
  });

  it("native tabs only accept their own family (no silent substitution)", () => {
    expect(modelFitsProvider("anthropic", "claude-opus-5-5")).toBe(true);
    expect(modelFitsProvider("anthropic", "gemini-3.8-flash")).toBe(false);
    expect(modelFitsProvider("gemini", "gemini-4-argon")).toBe(true);
    expect(modelFitsProvider("gemini", "claude-haiku-5-5")).toBe(false);
    for (const p of PLAYGROUND_PROVIDERS) {
      for (const m of modelsFor(p)) expect(modelFitsProvider(p, m.id)).toBe(true);
    }
  });

  it("formats list prices per 1M tokens", () => {
    const by = (id: string) => allModels().find((m) => m.id === id)!;
    expect(formatPrice(by("claude-haiku-5-5"))).toBe("$0.10 / $0.50");
    expect(formatPrice(by("gemini-3.8-flash"))).toBe("$0.83 / $4.13");
    expect(formatPrice(by("claude-fable-5-1"))).toBe("$10 / $50");
    expect(formatPrice(by("gpt-6-luna"))).toBe("$0.10 / $0.50");
  });

  it("modelsFor is the per-tab catalog", () => {
    for (const p of PLAYGROUND_PROVIDERS) expect(modelsFor(p)).toBe(PLAYGROUND_MODELS[p]);
  });
});

function memoryStore() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe("playground key storage (opt-in only)", () => {
  it("stores nothing until remembered, and forgets on untick", () => {
    const store = memoryStore();
    expect(loadRememberedKey(store, "anthropic")).toBeNull();
    rememberKey(store, "anthropic", "placeholder-key");
    expect(store.map.get(keyStorageFor("anthropic"))).toBe("placeholder-key");
    expect(loadRememberedKey(store, "anthropic")).toBe("placeholder-key");
    forgetKey(store, "anthropic");
    expect(store.map.size).toBe(0);
  });

  it("drops a key the old page auto-saved without consent", () => {
    const store = memoryStore();
    store.setItem(keyStorageFor("openai"), "auto-saved");
    store.setItem(LEGACY_KEY_STORAGE, "older-auto-saved");
    expect(loadRememberedKey(store, "openai")).toBeNull();
    expect(store.map.size).toBe(0);
  });

  it("drops a retired provider's key on load even when it was remembered", () => {
    const store = memoryStore();
    for (const retired of RETIRED_PROVIDER_SLOTS) {
      store.setItem(keyStorageFor(retired), "remembered-by-an-older-build");
      store.setItem(rememberMarkerFor(retired), "1");
    }
    dropUnconsentedKeys(store);
    expect(store.map.size).toBe(0);
  });

  it("restores a saved provider tab, and falls back to Anthropic for anything else", () => {
    const store = memoryStore();
    expect(loadProvider(store)).toBe("anthropic");
    store.setItem("klorn-playground-provider", "gemini");
    expect(loadProvider(store)).toBe("gemini");
    store.setItem("klorn-playground-provider", RETIRED_PROVIDER_SLOTS[0] ?? "retired");
    expect(loadProvider(store)).toBe("anthropic");
  });

  it("remembering an empty key stores nothing", () => {
    const store = memoryStore();
    store.setItem(rememberMarkerFor("openai"), "1");
    expect(rememberKey(store, "openai", "")).toBe(false);
    expect(store.map.size).toBe(0);
  });

  it("sweeps every provider's unconsented key on load, keeps consented ones", () => {
    const store = memoryStore();
    store.setItem(keyStorageFor("openai"), "auto-saved");
    store.setItem(keyStorageFor("gemini"), "auto-saved");
    rememberKey(store, "anthropic", "kept");
    dropUnconsentedKeys(store);
    expect([...store.map.keys()].sort()).toEqual([
      keyStorageFor("anthropic"),
      rememberMarkerFor("anthropic"),
    ]);
  });

  it("survives storage that throws", () => {
    const boom = () => {
      throw new Error("blocked");
    };
    const store = { getItem: boom, setItem: boom, removeItem: boom };
    expect(loadRememberedKey(store, "gemini")).toBeNull();
    expect(rememberKey(store, "gemini", "x")).toBe(false);
    expect(() => forgetKey(store, "gemini")).not.toThrow();
  });
});

describe("playground 'decided the lane'", () => {
  it("marks urgency and confidence for PUSH", () => {
    expect(explainDecision("urgent").drivers).toEqual(["urgency", "confidence"]);
  });
  it("marks sender trust and urgency for SILENT", () => {
    expect(explainDecision("promotional").drivers).toEqual([
      "senderTrust",
      "urgency",
      "reversibility",
    ]);
  });
  it("uses a sentence, not a score, for MEETING", () => {
    expect(explainDecision("scheduling")).toEqual({
      drivers: [],
      noteKey: "playground.why.scheduling",
    });
  });
  it("shows no marker when the server didn't say", () => {
    expect(explainDecision(undefined)).toEqual({ drivers: [], noteKey: null });
    expect(explainDecision("toString")).toEqual({ drivers: [], noteKey: null });
  });
});
