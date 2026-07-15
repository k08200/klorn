import { describe, expect, it } from "vitest";
import { JUDGE_MODEL, VISION_MODEL } from "../llm/openai.js";
import {
  classifyCatalogDrift,
  classifyFingerprintDrift,
  dependedModels,
  dependedModelsExpiringSoon,
  diffChainAgainstCatalog,
  parseCatalogExpirations,
  parseCatalogFingerprints,
  parseCatalogIds,
} from "../llm/openrouter-catalog-check.js";

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

describe("dependedModels", () => {
  it("watches the firewall's tier-judge model (its silent retirement kills PUSH)", () => {
    // JUDGE_MODEL defaults to a vendor-prefixed OpenRouter id, so the daily
    // catalog check must cover it — it's the highest-consequence drift.
    expect(JUDGE_MODEL).toContain("/");
    expect(dependedModels()).toContain(JUDGE_MODEL);
  });

  it("watches the vision model so a multimodal SKU retirement is caught", () => {
    expect(VISION_MODEL).toContain("/");
    expect(dependedModels()).toContain(VISION_MODEL);
  });
});

describe("parseCatalogExpirations", () => {
  it("collects id -> expiration_date only for entries with a non-null sunset date", () => {
    const body = {
      data: [
        { id: "z-ai/glm-4.5", expiration_date: "2026-06-19" },
        { id: "google/gemini-2.5-flash", expiration_date: null },
        { id: "openai/gpt-5.2-chat", expiration_date: "2026-08-10" },
        { id: "no-date/model" },
      ],
    };
    expect(parseCatalogExpirations(body)).toEqual(
      new Map([
        ["z-ai/glm-4.5", "2026-06-19"],
        ["openai/gpt-5.2-chat", "2026-08-10"],
      ]),
    );
  });

  it("returns an empty map for malformed bodies instead of throwing", () => {
    expect(parseCatalogExpirations(null)).toEqual(new Map());
    expect(parseCatalogExpirations({ data: "nope" })).toEqual(new Map());
    expect(parseCatalogExpirations({ data: [{ id: 42, expiration_date: "x" }] })).toEqual(
      new Map(),
    );
  });
});

describe("dependedModelsExpiringSoon", () => {
  const now = new Date("2026-06-14T00:00:00Z");

  it("flags a depended model whose sunset date is inside the window", () => {
    const expirations = new Map([["z-ai/glm-4.5", "2026-06-19"]]);
    expect(dependedModelsExpiringSoon(expirations, ["z-ai/glm-4.5"], now, 14)).toEqual([
      { model: "z-ai/glm-4.5", expirationDate: "2026-06-19", daysLeft: 5 },
    ]);
  });

  it("ignores a sunset date beyond the window", () => {
    const expirations = new Map([["openai/gpt-5.2-chat", "2026-08-10"]]);
    expect(dependedModelsExpiringSoon(expirations, ["openai/gpt-5.2-chat"], now, 14)).toEqual([]);
  });

  it("includes an already-expired-but-still-listed model (negative daysLeft)", () => {
    const expirations = new Map([["gone/soon", "2026-06-10"]]);
    expect(dependedModelsExpiringSoon(expirations, ["gone/soon"], now, 14)).toEqual([
      { model: "gone/soon", expirationDate: "2026-06-10", daysLeft: -4 },
    ]);
  });

  it("ignores models we don't depend on, and skips unparseable dates", () => {
    const expirations = new Map([
      ["not/depended", "2026-06-15"],
      ["bad/date", "not-a-date"],
    ]);
    expect(dependedModelsExpiringSoon(expirations, ["bad/date"], now, 14)).toEqual([]);
  });

  it("sorts soonest-first", () => {
    const expirations = new Map([
      ["a/x", "2026-06-20"],
      ["b/y", "2026-06-16"],
    ]);
    const result = dependedModelsExpiringSoon(expirations, ["a/x", "b/y"], now, 14);
    expect(result.map((r) => r.model)).toEqual(["b/y", "a/x"]);
  });
});

describe("classifyCatalogDrift", () => {
  it("reports everything as newly missing when there is no prior run", () => {
    expect(classifyCatalogDrift(null, ["a/x", "b/y"])).toEqual({
      newlyMissing: ["a/x", "b/y"],
      recovered: [],
      unchanged: [],
    });
  });

  it("flags only the model that vanished since the previous run", () => {
    const previous = new Set(["a/x"]);
    expect(classifyCatalogDrift(previous, ["a/x", "b/y"])).toEqual({
      newlyMissing: ["b/y"],
      recovered: [],
      unchanged: ["a/x"],
    });
  });

  it("flags a model that returned to the catalog as recovered", () => {
    const previous = new Set(["a/x", "b/y"]);
    expect(classifyCatalogDrift(previous, ["a/x"])).toEqual({
      newlyMissing: [],
      recovered: ["b/y"],
      unchanged: ["a/x"],
    });
  });

  it("suppresses repeat noise: a standing breakage is unchanged, not newly missing", () => {
    const previous = new Set(["a/x"]);
    expect(classifyCatalogDrift(previous, ["a/x"])).toEqual({
      newlyMissing: [],
      recovered: [],
      unchanged: ["a/x"],
    });
  });

  it("reports a full recovery when nothing is missing now", () => {
    const previous = new Set(["a/x", "b/y"]);
    expect(classifyCatalogDrift(previous, [])).toEqual({
      newlyMissing: [],
      recovered: ["a/x", "b/y"],
      unchanged: [],
    });
  });
});

describe("parseCatalogFingerprints", () => {
  it("fingerprints the identity-bearing fields (created/context_length/pricing)", () => {
    const body = {
      data: [
        {
          id: "openai/gpt-5.2-chat",
          name: "GPT-5.2 Chat",
          created: 1735000000,
          context_length: 200000,
          pricing: { prompt: "0.0000005", completion: "0.0000015" },
        },
      ],
    };
    const fps = parseCatalogFingerprints(body);
    expect(fps.has("openai/gpt-5.2-chat")).toBe(true);
  });

  it("ignores a cosmetic display-name change (no false repoint)", () => {
    const before = parseCatalogFingerprints({
      data: [
        { id: "a/x", name: "Model X", created: 1, context_length: 8000, pricing: { prompt: "1" } },
      ],
    });
    const renamedLabel = parseCatalogFingerprints({
      data: [
        {
          id: "a/x",
          name: "Model X (new label)",
          created: 1,
          context_length: 8000,
          pricing: { prompt: "1" },
        },
      ],
    });
    expect(renamedLabel.get("a/x")).toEqual(before.get("a/x"));
  });

  it("changes the fingerprint when created/context_length/pricing move (a re-point)", () => {
    const before = parseCatalogFingerprints({
      data: [
        { id: "a/x", created: 1, context_length: 8000, pricing: { prompt: "1", completion: "2" } },
      ],
    });
    const repointedCreated = parseCatalogFingerprints({
      data: [
        {
          id: "a/x",
          created: 999,
          context_length: 8000,
          pricing: { prompt: "1", completion: "2" },
        },
      ],
    });
    const repointedContext = parseCatalogFingerprints({
      data: [
        { id: "a/x", created: 1, context_length: 32000, pricing: { prompt: "1", completion: "2" } },
      ],
    });
    const repointedPricing = parseCatalogFingerprints({
      data: [
        { id: "a/x", created: 1, context_length: 8000, pricing: { prompt: "5", completion: "2" } },
      ],
    });
    expect(repointedCreated.get("a/x")).not.toEqual(before.get("a/x"));
    expect(repointedContext.get("a/x")).not.toEqual(before.get("a/x"));
    expect(repointedPricing.get("a/x")).not.toEqual(before.get("a/x"));
  });

  it("returns an empty map for malformed bodies and skips entries without a string id", () => {
    expect(parseCatalogFingerprints(null)).toEqual(new Map());
    expect(parseCatalogFingerprints({ data: "nope" })).toEqual(new Map());
    expect(parseCatalogFingerprints({ data: [{ noId: true }, 42, null] })).toEqual(new Map());
  });
});

describe("classifyFingerprintDrift", () => {
  it("reports nothing on the first run (no baseline to diff against)", () => {
    const current = new Map([["a/x", "fp1"]]);
    expect(classifyFingerprintDrift(null, current, ["a/x"])).toEqual([]);
  });

  it("flags a depended model whose fingerprint changed while still listed", () => {
    const previous = new Map([["a/x", "fp1"]]);
    const current = new Map([["a/x", "fp2"]]);
    expect(classifyFingerprintDrift(previous, current, ["a/x"])).toEqual([
      { model: "a/x", before: "fp1", after: "fp2" },
    ]);
  });

  it("stays quiet when the fingerprint is unchanged", () => {
    const previous = new Map([["a/x", "fp1"]]);
    const current = new Map([["a/x", "fp1"]]);
    expect(classifyFingerprintDrift(previous, current, ["a/x"])).toEqual([]);
  });

  it("ignores a model absent from either snapshot (that is the presence diff's job)", () => {
    const previous = new Map([["a/x", "fp1"]]);
    const current = new Map<string, string>(); // a/x vanished — a retirement, not a repoint
    expect(classifyFingerprintDrift(previous, current, ["a/x"])).toEqual([]);
  });

  it("ignores fingerprint changes on models we do not depend on", () => {
    const previous = new Map([["not/depended", "fp1"]]);
    const current = new Map([["not/depended", "fp2"]]);
    expect(classifyFingerprintDrift(previous, current, ["a/x"])).toEqual([]);
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
