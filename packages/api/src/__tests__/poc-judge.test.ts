/**
 * poc-judge tier-rule + fast-path unit tests.
 *
 * Covers the parts of poc-judge that never call the LLM:
 *   - `tierFromFeatures` — the 5-branch 4-feature → 4-tier rule.
 *   - `judgeEmail` fast-path — marketing subject / Gmail PROMOTIONS → SILENT.
 *
 * LLM-driven feature extraction is exercised end-to-end by
 * `scripts/poc-accuracy.ts` against the real provider, not here.
 *
 * The rule defaults to QUEUE (the founder's "I'll look at it on my own
 * pace" bucket), so SILENT is now narrow — only obvious marketing/promo
 * with a low-trust sender and no urgency.
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

  it("returns PUSH when urgency >= 0.7 and confidence >= 0.7", () => {
    const { tier } = tierFromFeatures({
      confidence: 0.8,
      senderTrust: 0.7,
      reversibility: 0.5,
      urgency: 0.9,
    });
    expect(tier).toBe("PUSH");
  });

  it("returns SILENT only on the narrow marketing signal (trust<0.2 + urg<0.2 + rev>0.9)", () => {
    const { tier } = tierFromFeatures({
      confidence: 0.9,
      senderTrust: 0.05,
      reversibility: 1.0,
      urgency: 0.0,
    });
    expect(tier).toBe("SILENT");
  });

  it("does NOT return SILENT when senderTrust is 0.4 (system notification, still QUEUE)", () => {
    const { tier } = tierFromFeatures({
      confidence: 0.7,
      senderTrust: 0.4,
      reversibility: 1.0,
      urgency: 0.0,
    });
    expect(tier).toBe("QUEUE");
  });

  it("does NOT return SILENT when urgency is 0.3 (not below 0.2 floor)", () => {
    // reversibility lowered so the AUTO branch doesn't claim this one;
    // the point is just to prove that urgency 0.3 disqualifies SILENT.
    const { tier } = tierFromFeatures({
      confidence: 0.9,
      senderTrust: 0.1,
      reversibility: 0.8,
      urgency: 0.3,
    });
    expect(tier).toBe("QUEUE");
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
    expect(tier).toBe("QUEUE");
  });

  it("does NOT return AUTO when reversibility is just below 0.85", () => {
    const { tier } = tierFromFeatures({
      confidence: 0.9,
      senderTrust: 0.8,
      reversibility: 0.84,
      urgency: 0.2,
    });
    expect(tier).toBe("QUEUE");
  });

  it("defaults to QUEUE for low-urgency mid-trust informational mail", () => {
    const { tier } = tierFromFeatures({
      confidence: 0.6,
      senderTrust: 0.6,
      reversibility: 0.7,
      urgency: 0.1,
    });
    expect(tier).toBe("QUEUE");
  });

  it("clamps out-of-range features (large numbers → 1, negatives → 0)", () => {
    // After clamp: confidence=1, senderTrust=0, reversibility=1, urgency=0
    // senderTrust 0 < 0.2, urgency 0 < 0.2, reversibility 1 > 0.9 → SILENT branch
    const { tier } = tierFromFeatures({
      confidence: 1.5,
      senderTrust: -0.2,
      reversibility: 9,
      urgency: -3,
    });
    expect(tier).toBe("SILENT");
  });

  it("returns a non-empty reason for every branch", () => {
    const branches = [
      { confidence: 0.3, senderTrust: 0.9, reversibility: 0.9, urgency: 0.9 }, // QUEUE conf
      { confidence: 0.8, senderTrust: 0.7, reversibility: 0.5, urgency: 0.9 }, // PUSH
      { confidence: 0.9, senderTrust: 0.05, reversibility: 1.0, urgency: 0.0 }, // SILENT
      { confidence: 0.9, senderTrust: 0.8, reversibility: 0.95, urgency: 0.2 }, // AUTO
      { confidence: 0.6, senderTrust: 0.6, reversibility: 0.7, urgency: 0.1 }, // QUEUE default
    ];
    for (const f of branches) {
      const { reason } = tierFromFeatures(f);
      expect(reason.length).toBeGreaterThan(0);
    }
  });
});

describe("judgeEmail fast-path", () => {
  it("routes a Gmail PROMOTIONS-labelled email to SILENT without calling the LLM", async () => {
    const result = await judgeEmail({
      from: "noreply@brand.example",
      subject: "Last chance — 50% off ends tonight",
      snippet: "View this email in your browser",
      labels: ["CATEGORY_PROMOTIONS"],
    });
    expect(result.tier).toBe("SILENT");
    expect(result.source).toBe("fast-path");
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

  it("routes a 'view in browser' subject to SILENT via fast-path", async () => {
    const result = await judgeEmail({
      from: "newsletter@example.com",
      subject: "Weekly digest — view this email in your browser",
      snippet: "...",
      labels: [],
    });
    expect(result.tier).toBe("SILENT");
    expect(result.source).toBe("fast-path");
  });

  it("does NOT fast-path a no-reply system notification (e.g. Vercel deploy fail)", async () => {
    // The fast-path is narrow on purpose so system notifications fall through
    // to the LLM / keyword fallback, where they end up in QUEUE.
    const result = await judgeEmail({
      from: "Vercel <notifications@vercel.com>",
      subject: "Failed preview deployment on team 'k0820086'",
      snippet: "Build error in packages/web",
      labels: [],
    });
    expect(result.source).not.toBe("fast-path");
    // Without LLM, the keyword fallback marks this as a system notification
    // (senderTrust 0.4) → falls through to the QUEUE default branch.
    expect(result.tier).toBe("QUEUE");
  });

  it("does NOT fast-path own-product signup notifications", async () => {
    // The founder's own waitlist signups arrive from no-reply senders but
    // are firmly in QUEUE — they're a business signal to glance at.
    const result = await judgeEmail({
      from: "Klorn <onboarding@resend.dev>",
      subject: "[Klorn] New waitlist signup: example@example.com",
      snippet: "A new user joined the waitlist",
      labels: [],
    });
    expect(result.source).not.toBe("fast-path");
    expect(result.tier).toBe("QUEUE");
  });
});
