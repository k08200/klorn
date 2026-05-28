/**
 * poc-judge tier-rule + fast-path unit tests.
 *
 * These tests cover the parts of poc-judge that never call the LLM:
 *   - `tierFromFeatures` — the deterministic 4-feature → 4-tier rule
 *   - `judgeEmail` fast-path — fastClassify-driven automated mail → SILENT
 *
 * LLM-driven feature extraction is exercised end-to-end by
 * `scripts/poc-accuracy.ts` against the real provider, not here.
 */

import { describe, expect, it } from "vitest";
import { judgeEmail, tierFromFeatures } from "../poc-judge.js";

describe("tierFromFeatures", () => {
  it("returns QUEUE when confidence is below 0.5", () => {
    const { tier } = tierFromFeatures({
      confidence: 0.3,
      senderTrust: 0.9,
      reversibility: 0.9,
      urgency: 0.9,
    });
    expect(tier).toBe("QUEUE");
  });

  it("returns QUEUE when sender trust is below 0.3", () => {
    const { tier } = tierFromFeatures({
      confidence: 0.9,
      senderTrust: 0.2,
      reversibility: 0.9,
      urgency: 0.9,
    });
    expect(tier).toBe("QUEUE");
  });

  it("returns PUSH when urgency >= 0.7 and confidence >= 0.7", () => {
    const { tier } = tierFromFeatures({
      confidence: 0.8,
      senderTrust: 0.7,
      reversibility: 0.5,
      urgency: 0.9,
    });
    expect(tier).toBe("PUSH");
  });

  it("returns AUTO when reversibility >= 0.85, confidence >= 0.85, urgency < 0.5", () => {
    const { tier } = tierFromFeatures({
      confidence: 0.9,
      senderTrust: 0.8,
      reversibility: 0.95,
      urgency: 0.2,
    });
    expect(tier).toBe("AUTO");
  });

  it("does NOT return AUTO when confidence is just below 0.85", () => {
    const { tier } = tierFromFeatures({
      confidence: 0.84,
      senderTrust: 0.8,
      reversibility: 0.95,
      urgency: 0.2,
    });
    expect(tier).toBe("SILENT");
  });

  it("does NOT return AUTO when reversibility is just below 0.85", () => {
    const { tier } = tierFromFeatures({
      confidence: 0.9,
      senderTrust: 0.8,
      reversibility: 0.84,
      urgency: 0.2,
    });
    expect(tier).toBe("SILENT");
  });

  it("returns SILENT for low-urgency, mid-confidence informational mail", () => {
    const { tier } = tierFromFeatures({
      confidence: 0.6,
      senderTrust: 0.6,
      reversibility: 0.7,
      urgency: 0.1,
    });
    expect(tier).toBe("SILENT");
  });

  it("clamps out-of-range features so a bad LLM response can't crash the rule", () => {
    const { tier } = tierFromFeatures({
      confidence: 1.5,
      senderTrust: -0.2,
      reversibility: 9,
      urgency: -3,
    });
    // senderTrust clamps to 0 → triggers the QUEUE-on-unknown-sender branch
    expect(tier).toBe("QUEUE");
  });

  it("returns a non-empty reason for every branch", () => {
    const branches = [
      { confidence: 0.3, senderTrust: 0.9, reversibility: 0.9, urgency: 0.9 },
      { confidence: 0.9, senderTrust: 0.2, reversibility: 0.9, urgency: 0.9 },
      { confidence: 0.8, senderTrust: 0.7, reversibility: 0.5, urgency: 0.9 },
      { confidence: 0.9, senderTrust: 0.8, reversibility: 0.95, urgency: 0.2 },
      { confidence: 0.6, senderTrust: 0.6, reversibility: 0.7, urgency: 0.1 },
    ];
    for (const f of branches) {
      const { reason } = tierFromFeatures(f);
      expect(reason.length).toBeGreaterThan(0);
    }
  });
});

describe("judgeEmail fast-path", () => {
  it("routes a no-reply marketing email to SILENT without calling the LLM", async () => {
    const result = await judgeEmail({
      from: "noreply@brand.example",
      subject: "Last chance — 50% off ends tonight",
      snippet: "View this email in your browser",
      labels: ["CATEGORY_PROMOTIONS"],
    });
    expect(result.tier).toBe("SILENT");
    expect(result.source).toBe("fast-path");
    expect(result.features.urgency).toBe(0);
  });

  it("routes a Korean ad marker subject to SILENT via fast-path", async () => {
    const result = await judgeEmail({
      from: "marketing@brand.example",
      subject: "[광고] 새로운 혜택을 확인하세요",
      snippet: "수신거부 안내",
      labels: [],
    });
    expect(result.tier).toBe("SILENT");
    expect(result.source).toBe("fast-path");
  });
});
