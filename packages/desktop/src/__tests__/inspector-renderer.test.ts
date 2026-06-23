import { describe, expect, it } from "vitest";
import { esc, renderOntology } from "../inspector-renderer.js";

/** A snapshot shaped like ontology.ts:describePolicy() output. */
const SNAPSHOT = {
  tiers: ["PUSH", "QUEUE", "SILENT", "AUTO"],
  relation: { thresholds: { push: { confidence: 0.7 }, silent: { confidence: 0.4 } } },
  entity: {
    priorThresholds: { trustedSenderFloor: 0.6 },
    shortCircuitTiers: { override: ["PUSH"], history: ["SILENT"] },
  },
  pattern: { keywordScores: { urgency: { urgent: 0.3 } } },
  dial: { escalationConfidenceFloor: 0.5, escalationModel: null },
};

describe("esc", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(esc(`<img src=x onerror="alert(&'1')">`)).toBe(
      "&lt;img src=x onerror=&quot;alert(&amp;&#39;1&#39;)&quot;&gt;",
    );
  });
});

describe("renderOntology", () => {
  it("renders every section of a full snapshot", () => {
    const html = renderOntology(SNAPSHOT);
    expect(html).toContain("Tiers");
    expect(html).toContain("PUSH");
    expect(html).toContain("Relation — tier thresholds");
    expect(html).toContain("0.7");
    expect(html).toContain("Entity — sender knowledge");
    expect(html).toContain("Prior thresholds");
    expect(html).toContain("Short-circuit tiers");
    expect(html).toContain("Pattern — keyword scores");
    expect(html).toContain("Model dial");
  });

  it("labels a null escalation model as off", () => {
    const html = renderOntology(SNAPSHOT);
    expect(html).toContain("off (JUDGE_ESCALATION_MODEL unset)");
  });

  it("shows the model name when the dial is on", () => {
    const html = renderOntology({
      dial: { escalationConfidenceFloor: 0.5, escalationModel: "x/y" },
    });
    expect(html).toContain("x/y");
    expect(html).not.toContain("off (JUDGE_ESCALATION_MODEL unset)");
  });

  it("escapes snapshot values so a malicious tier name can't inject markup", () => {
    const html = renderOntology({ tiers: ["<script>evil</script>"] });
    expect(html).not.toContain("<script>evil");
    expect(html).toContain("&lt;script&gt;evil");
  });

  it("degrades to a placeholder for a non-object snapshot", () => {
    expect(renderOntology(null)).toContain("No ontology data");
    expect(renderOntology("nope")).toContain("No ontology data");
  });

  it("degrades to a placeholder when no known sections are present", () => {
    expect(renderOntology({ unrelated: 1 })).toContain("empty");
  });
});
