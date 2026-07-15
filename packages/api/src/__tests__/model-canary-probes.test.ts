/**
 * Model-canary probes (#526) — canonicalizer + probe-set invariants.
 *
 * The probes are the behavioral fingerprint for the non-judge models
 * (MODEL / AGENT_MODEL / VISION_MODEL). Everything downstream compares
 * canonical single-token answers run-over-run, so the canonicalizer must
 * collapse harmless formatting variance (case, punctuation, quoting,
 * whitespace) without ever collapsing two genuinely different answers.
 */

import { describe, expect, it } from "vitest";
import {
  canonicalizeProbeAnswer,
  FINGERPRINT_TRUTH,
  TEXT_PROBES,
  VISION_PROBES,
} from "../llm/model-canary-probes.js";

describe("canonicalizeProbeAnswer", () => {
  it("collapses case, quotes, trailing punctuation, and whitespace", () => {
    expect(canonicalizeProbeAnswer("  Apple.  ")).toBe("APPLE");
    expect(canonicalizeProbeAnswer('"88"')).toBe("88");
    expect(canonicalizeProbeAnswer("`INV-2291`")).toBe("INV-2291");
    expect(canonicalizeProbeAnswer("no!")).toBe("NO");
  });

  it("keeps only the first token of a multi-token answer", () => {
    expect(canonicalizeProbeAnswer("Apple, obviously")).toBe("APPLE");
    expect(canonicalizeProbeAnswer("2026-07-25 (ten days later)")).toBe("2026-07-25");
  });

  it("preserves meaningful internal punctuation (dates, ids)", () => {
    expect(canonicalizeProbeAnswer("2026-07-25")).toBe("2026-07-25");
    expect(canonicalizeProbeAnswer("inv-2291")).toBe("INV-2291");
  });

  it("maps empty/whitespace output to UNPARSEABLE", () => {
    expect(canonicalizeProbeAnswer("")).toBe("UNPARSEABLE");
    expect(canonicalizeProbeAnswer("   ")).toBe("UNPARSEABLE");
  });
});

describe("probe-set invariants", () => {
  const all = [...TEXT_PROBES, ...VISION_PROBES];

  it("probe ids are unique and stable-looking", () => {
    const ids = all.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it("objective probes have expectations in canonical form", () => {
    for (const p of all) {
      if (p.expect === FINGERPRINT_TRUTH) continue;
      expect(canonicalizeProbeAnswer(p.expect), `probe ${p.id}`).toBe(p.expect);
    }
  });

  it("has both objective and fingerprint probes (swap detection needs both)", () => {
    const objective = TEXT_PROBES.filter((p) => p.expect !== FINGERPRINT_TRUTH);
    const fingerprint = TEXT_PROBES.filter((p) => p.expect === FINGERPRINT_TRUTH);
    expect(objective.length).toBeGreaterThanOrEqual(6);
    expect(fingerprint.length).toBeGreaterThanOrEqual(3);
  });

  it("every text probe instructs a single-token answer", () => {
    for (const p of TEXT_PROBES) {
      expect(p.prompt.toLowerCase(), `probe ${p.id}`).toContain("one");
    }
  });
});
