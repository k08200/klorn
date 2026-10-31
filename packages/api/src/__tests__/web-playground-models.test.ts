/**
 * Playground redesign (2026-10-30) — the pure rules behind the page:
 *   - the model menu is exactly the founder-approved list (option A, LOCKED),
 *     no dead ids, one measured claim, native ids that the API's own provider
 *     adapters accept;
 *   - a key is stored only with consent and stale auto-saved keys are dropped;
 *   - "decided the lane" comes from the server's rule name, never a guess.
 */

import { describe, expect, it } from "vitest";
import { explainDecision } from "../../../web/src/app/playground/decided";
import {
  dropUnconsentedKeys,
  forgetKey,
  keyStorageFor,
  LEGACY_KEY_STORAGE,
  loadRememberedKey,
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
  OPENROUTER_MODELS,
  toNativeModelId,
} from "../../../web/src/app/playground/models";
import { toAnthropicModelId } from "../providers/anthropic-config.js";
import { PLAYGROUND_MODEL_ID_PATTERN } from "../routes/playground.js";

describe("playground model list", () => {
  it("is exactly the approved OpenRouter list, in order", () => {
    expect(OPENROUTER_MODELS.map((m) => m.id)).toEqual([
      "google/gemini-2.5-flash",
      "anthropic/claude-fable-5.1",
      "anthropic/claude-opus-5.5",
      "anthropic/claude-sonnet-5.5",
      "anthropic/claude-haiku-5.5",
      "google/gemini-4-argon",
      "google/gemini-3.8-flash",
      "openai/gpt-6.1-terra",
      "openai/gpt-6.1-sol",
      "openai/gpt-6-luna",
      "x-ai/grok-4.7",
    ]);
  });

  it("carries no retired or :free ids", () => {
    const ids = [
      ...OPENROUTER_MODELS.map((m) => m.id),
      ...["anthropic", "openai", "gemini"].flatMap((p) =>
        modelsFor(p as "openai").map((m) => m.id),
      ),
    ];
    for (const id of ids) {
      expect(id).not.toMatch(/:free|llama|qwen|gpt-oss|nemotron|claude-3|gpt-4o/);
    }
  });

  it("makes exactly one measured claim: the model Klorn uses, 54/56", () => {
    const measured = OPENROUTER_MODELS.filter((m) => m.measured);
    expect(measured).toEqual([
      expect.objectContaining({ id: KLORN_MODEL_ID, measured: { correct: 54, total: 56 } }),
    ]);
  });

  it("defaults to the Klorn model where the tab can run it", () => {
    expect(defaultModelFor("openrouter")).toBe("google/gemini-2.5-flash");
    expect(defaultModelFor("gemini")).toBe("gemini-2.5-flash");
    expect(defaultModelFor("anthropic")).toBe("claude-haiku-5-5");
    expect(defaultModelFor("openai")).toBe("gpt-6-luna");
  });

  it("native Anthropic ids are what the API's own adapter produces", () => {
    const native = modelsFor("anthropic").map((m) => m.id);
    expect(native).toEqual([
      "claude-fable-5-1",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
    ]);
    for (const m of OPENROUTER_MODELS.filter((x) => x.group === "anthropic")) {
      expect(toNativeModelId("anthropic", m.id)).toBe(toAnthropicModelId(m.id, "fallback"));
    }
  });

  it("native OpenAI and Google ids drop the vendor prefix like buildOpenAI/buildGemini", () => {
    expect(modelsFor("openai").map((m) => m.id)).toEqual([
      "gpt-6.1-terra",
      "gpt-6.1-sol",
      "gpt-6-luna",
    ]);
    expect(modelsFor("gemini").map((m) => m.id)).toEqual([
      "gemini-2.5-flash",
      "gemini-4-argon",
      "gemini-3.8-flash",
    ]);
  });

  it("every listed id passes the same shape the API enforces", () => {
    const api = new RegExp(PLAYGROUND_MODEL_ID_PATTERN);
    for (const p of ["openrouter", "anthropic", "openai", "gemini"] as const) {
      for (const m of modelsFor(p)) {
        expect(isValidModelId(m.id)).toBe(true);
        expect(api.test(m.id)).toBe(true);
      }
    }
    for (const bad of ["bad id", "google/..", "a..b", "x?y=1"]) {
      expect(isValidModelId(bad)).toBe(false);
      expect(api.test(bad)).toBe(false);
    }
  });

  it("native tabs only accept their own family (no silent substitution)", () => {
    expect(modelFitsProvider("anthropic", "claude-opus-5-5")).toBe(true);
    expect(modelFitsProvider("anthropic", "google/gemini-2.5-flash")).toBe(false);
    expect(modelFitsProvider("gemini", "gemini-4-argon")).toBe(true);
    expect(modelFitsProvider("gemini", "claude-haiku-5-5")).toBe(false);
    expect(modelFitsProvider("openrouter", "x-ai/grok-4.7")).toBe(true);
    for (const p of ["anthropic", "openai", "gemini"] as const) {
      for (const m of modelsFor(p)) expect(modelFitsProvider(p, m.id)).toBe(true);
    }
  });

  it("formats list prices per 1M tokens", () => {
    const by = (id: string) => OPENROUTER_MODELS.find((m) => m.id === id)!;
    expect(formatPrice(by("google/gemini-2.5-flash"))).toBe("$0.30 / $2.50");
    expect(formatPrice(by("google/gemini-3.8-flash"))).toBe("$0.83 / $4.13");
    expect(formatPrice(by("anthropic/claude-fable-5.1"))).toBe("$10 / $50");
    expect(formatPrice(by("openai/gpt-6-luna"))).toBe("$0.10 / $0.50");
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
    store.setItem(keyStorageFor("openrouter"), "auto-saved");
    store.setItem(LEGACY_KEY_STORAGE, "older-auto-saved");
    expect(loadRememberedKey(store, "openrouter")).toBeNull();
    expect(store.map.size).toBe(0);
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
