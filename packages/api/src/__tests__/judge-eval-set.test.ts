/**
 * Eval-set regression gate for the 4-tier judge.
 *
 * Runs the committed synthetic 50-email set (eval/judge-eval-set.json)
 * through the NO-LLM pipeline (fast-path + keyword fallback) and enforces:
 *   - an accuracy floor (a ratchet — raise it when the fallback improves,
 *     never lower it to make a PR pass), and
 *   - two safety invariants that must hold even on misses:
 *       1. a missed PUSH degrades to QUEUE (visible), never SILENT (hidden)
 *       2. a SILENT-labelled marketing item is never predicted PUSH
 *
 * The LLM path is mocked at the openai.js boundary here (no network, no
 * keys). The LLM end-to-end gate runs the SAME eval set via
 * `pnpm --filter @klorn/api eval:judge` / .github/workflows/eval.yml with
 * the ≥80% POC bar.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createCompletionMock = vi.hoisted(() => vi.fn());

vi.mock("../openai.js", () => ({
  createCompletion: createCompletionMock,
  MODEL: "test-model",
  JUDGE_MODEL: "test-judge-model",
}));

vi.mock("../sentry.js", () => ({
  captureError: vi.fn(),
}));

import { judgeEmail, POC_TIERS, type PocTier } from "../poc-judge.js";

const EVAL_SET_PATH = fileURLToPath(new URL("../../eval/judge-eval-set.json", import.meta.url));

/**
 * Floor for the no-LLM pipeline on the synthetic set.
 * Measured 78% on 2026-06-12 (39/50; misses are urgent-human-non-investor
 * PUSH items and AUTO items, which need the LLM's feature extraction).
 */
const KEYWORD_PIPELINE_ACCURACY_FLOOR = 0.7;

interface EvalItem {
  id: string;
  from: string;
  subject: string;
  snippet: string | null;
  labels: string[];
  label: PocTier;
  note?: string;
}

describe("LLM feature-extraction path (mocked provider)", () => {
  beforeEach(() => {
    createCompletionMock.mockReset();
  });

  it("applies the tier rule to LLM-extracted features", async () => {
    createCompletionMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              confidence: 0.9,
              senderTrust: 0.9,
              reversibility: 0.2,
              urgency: 0.9,
              reason: "investor deadline",
            }),
          },
        },
      ],
    });
    const result = await judgeEmail({
      from: "Partner <partner@fund.example>",
      subject: "Deck needed today",
      snippet: "Please send the latest deck today",
      labels: [],
    });
    expect(result.tier).toBe("PUSH");
    expect(result.source).toBe("llm");
    expect(result.reason).toBe("investor deadline");
  });

  it("falls back to keyword features when the LLM returns garbage", async () => {
    createCompletionMock.mockResolvedValue({
      choices: [{ message: { content: "not json at all" } }],
    });
    const result = await judgeEmail({
      from: "Someone <a@b.example>",
      subject: "Hello",
      snippet: null,
      labels: [],
    });
    expect(result.source).toBe("keyword-fallback");
    expect(result.tier).toBe("QUEUE");
  });

  it("silences a plain newsletter via keyword fallback when the LLM is down", async () => {
    // Regression for the off-by-boundary bug: marketing fallback features sat
    // exactly ON the SILENT branch's strict floors (urgency<0.2, rev>0.9),
    // so an LLM outage turned every newsletter into QUEUE noise.
    createCompletionMock.mockRejectedValue(new Error("provider down"));
    const result = await judgeEmail({
      from: "TechCrunch <newsletter@techcrunch.example>",
      subject: "Your weekly startup roundup",
      snippet: "The week in startups",
      labels: [],
    });
    expect(result.source).toBe("keyword-fallback");
    expect(result.tier).toBe("SILENT");
  });
});

describe("eval-set gate (no-LLM pipeline)", () => {
  const file = JSON.parse(readFileSync(EVAL_SET_PATH, "utf8")) as { items: EvalItem[] };

  beforeEach(() => {
    createCompletionMock.mockReset();
  });

  it("eval set is well-formed: 50 items, valid tiers, unique ids", () => {
    expect(file.items).toHaveLength(50);
    const ids = new Set(file.items.map((i) => i.id));
    expect(ids.size).toBe(50);
    for (const item of file.items) {
      expect(POC_TIERS).toContain(item.label);
    }
  });

  it(`fast-path + keyword fallback stays ≥${KEYWORD_PIPELINE_ACCURACY_FLOOR * 100}% with safety invariants`, async () => {
    createCompletionMock.mockRejectedValue(new Error("LLM unavailable"));

    const predictions = await Promise.all(
      file.items.map(async (item) => ({
        item,
        judgement: await judgeEmail({
          from: item.from,
          subject: item.subject,
          snippet: item.snippet,
          labels: item.labels,
        }),
      })),
    );

    // Safety invariant 1: a missed PUSH must degrade to QUEUE (visible),
    // never to SILENT (hidden). A hidden urgent email is the worst failure.
    const pushSilenced = predictions.filter(
      (p) => p.item.label === "PUSH" && p.judgement.tier === "SILENT",
    );
    expect(pushSilenced).toHaveLength(0);

    // Safety invariant 2: marketing must never interrupt.
    const marketingPushed = predictions.filter(
      (p) => p.item.label === "SILENT" && p.judgement.tier === "PUSH",
    );
    expect(marketingPushed).toHaveLength(0);

    // Fast-path-designed items must silence deterministically.
    for (const p of predictions) {
      if (p.item.note?.startsWith("fast-path")) {
        expect(p.judgement.tier, p.item.id).toBe("SILENT");
        expect(p.judgement.source, p.item.id).toBe("fast-path");
      }
    }

    const hits = predictions.filter((p) => p.judgement.tier === p.item.label);
    const accuracy = hits.length / predictions.length;
    const misses = predictions
      .filter((p) => p.judgement.tier !== p.item.label)
      .map((p) => `${p.item.id} ${p.item.label}→${p.judgement.tier} (${p.item.subject})`);

    expect(
      accuracy,
      `accuracy ${(accuracy * 100).toFixed(1)}% below floor; misses:\n${misses.join("\n")}`,
    ).toBeGreaterThanOrEqual(KEYWORD_PIPELINE_ACCURACY_FLOOR);
  });
});
