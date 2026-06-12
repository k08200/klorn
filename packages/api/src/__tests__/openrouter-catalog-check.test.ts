import { describe, expect, it } from "vitest";
import { diffChainAgainstCatalog, parseCatalogIds } from "../openrouter-catalog-check.js";

describe("parseCatalogIds", () => {
  it("extracts model ids from the OpenRouter /models response shape", () => {
    const body = {
      data: [
        { id: "meta-llama/llama-3.3-70b-instruct:free", name: "Llama 3.3 70B (free)" },
        { id: "deepseek/deepseek-r1", name: "DeepSeek R1" },
      ],
    };
    expect(parseCatalogIds(body)).toEqual(
      new Set(["meta-llama/llama-3.3-70b-instruct:free", "deepseek/deepseek-r1"]),
    );
  });

  it("returns an empty set for malformed bodies instead of throwing", () => {
    expect(parseCatalogIds(null)).toEqual(new Set());
    expect(parseCatalogIds({})).toEqual(new Set());
    expect(parseCatalogIds({ data: "not-an-array" })).toEqual(new Set());
    expect(parseCatalogIds({ data: [{ noId: true }, 42, null] })).toEqual(new Set());
  });
});

describe("diffChainAgainstCatalog", () => {
  const catalog = new Set([
    "meta-llama/llama-3.3-70b-instruct:free",
    "qwen/qwen-2.5-72b-instruct:free",
    "google/gemma-4-31b-it:free",
  ]);

  it("returns empty when every chain model exists in the catalog", () => {
    const chain = ["meta-llama/llama-3.3-70b-instruct:free", "google/gemma-4-31b-it:free"];
    expect(diffChainAgainstCatalog(chain, catalog)).toEqual([]);
  });

  it("returns models that are missing from the catalog", () => {
    const chain = [
      "meta-llama/llama-3.3-70b-instruct:free",
      "deepseek/deepseek-r1:free", // not in catalog
      "mistralai/mistral-small:free", // not in catalog
    ];
    expect(diffChainAgainstCatalog(chain, catalog)).toEqual([
      "deepseek/deepseek-r1:free",
      "mistralai/mistral-small:free",
    ]);
  });

  it("treats an empty catalog as 'unknown' and reports nothing (avoids false alarms)", () => {
    // An empty catalog almost certainly means the fetch failed upstream;
    // warning that EVERY model vanished would be noise, not signal.
    const chain = ["meta-llama/llama-3.3-70b-instruct:free"];
    expect(diffChainAgainstCatalog(chain, new Set())).toEqual([]);
  });

  it("dedupes repeated chain entries in the report", () => {
    const chain = ["gone/model:free", "gone/model:free"];
    expect(diffChainAgainstCatalog(chain, catalog)).toEqual(["gone/model:free"]);
  });
});
