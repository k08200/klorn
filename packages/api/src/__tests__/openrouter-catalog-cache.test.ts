import { afterEach, describe, expect, it } from "vitest";
import {
  __resetCatalogCache,
  getCachedCatalogIds,
  isModelKnownAbsent,
  setCachedCatalogIds,
} from "../llm/openrouter-catalog-cache.js";

afterEach(() => {
  __resetCatalogCache();
});

describe("setCachedCatalogIds / getCachedCatalogIds", () => {
  it("stores a non-empty snapshot", () => {
    setCachedCatalogIds(new Set(["a/x", "b/y"]));
    expect(getCachedCatalogIds()).toEqual(new Set(["a/x", "b/y"]));
  });

  it("never caches an empty set (a failed fetch must not look like 'all gone')", () => {
    setCachedCatalogIds(new Set(["a/x"]));
    setCachedCatalogIds(new Set());
    expect(getCachedCatalogIds()).toEqual(new Set(["a/x"]));
  });
});

describe("isModelKnownAbsent", () => {
  it("fails open when the cache is cold (unknown must never pre-empt)", () => {
    expect(isModelKnownAbsent("a/x")).toBe(false);
  });

  it("returns true only for an OpenRouter-namespaced id genuinely absent from a real catalog", () => {
    setCachedCatalogIds(new Set(["a/x", "b/y"]));
    expect(isModelKnownAbsent("gone/model")).toBe(true);
    expect(isModelKnownAbsent("a/x")).toBe(false);
  });

  it("fails open for non-namespaced ids (e.g. a Gemini-direct route not in the OpenRouter catalog)", () => {
    setCachedCatalogIds(new Set(["a/x"]));
    expect(isModelKnownAbsent("gemini-2.5-flash")).toBe(false);
  });
});
