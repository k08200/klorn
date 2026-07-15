import { describe, expect, it } from "vitest";
import {
  MIN_DOMAIN_DISTINCT_SENDERS,
  MIN_RULE_EVIDENCE,
  mineLearnedRules,
  type OverrideObservation,
} from "../learning/learned-rule-mining.js";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/** Build an override observation with sane defaults. */
function obs(p: Partial<OverrideObservation>): OverrideObservation {
  return {
    from: "someone@example.com",
    subject: "hello",
    tier: "SILENT",
    sourceId: Math.random().toString(36).slice(2),
    updatedAt: NOW,
    ...p,
  };
}

describe("mineLearnedRules — sender-domain", () => {
  it("learns a domain rule from >=3 overrides across distinct senders, unanimous tier", () => {
    const rules = mineLearnedRules(
      [
        obs({ from: "a@news.acme.com", tier: "SILENT", sourceId: "s1" }),
        obs({ from: "b@news.acme.com", tier: "SILENT", sourceId: "s2" }),
        obs({ from: "c@news.acme.com", tier: "SILENT", sourceId: "s3" }),
      ],
      { now: NOW },
    );
    const domainRule = rules.find((r) => r.pattern === "sender-domain");
    expect(domainRule).toMatchObject({
      pattern: "sender-domain",
      value: "news.acme.com",
      tier: "SILENT",
      evidenceCount: 3,
      distinctSenders: 3,
    });
    expect(domainRule?.sourceIds.sort()).toEqual(["s1", "s2", "s3"]);
  });

  it("does NOT learn below the evidence floor", () => {
    const rules = mineLearnedRules(
      [
        obs({ from: "a@news.acme.com", tier: "SILENT" }),
        obs({ from: "b@news.acme.com", tier: "SILENT" }),
      ],
      { now: NOW },
    );
    expect(rules.filter((r) => r.pattern === "sender-domain")).toEqual([]);
    expect(MIN_RULE_EVIDENCE).toBe(3);
  });

  it("does NOT learn a domain rule when overrides disagree on tier", () => {
    const rules = mineLearnedRules(
      [
        obs({ from: "a@news.acme.com", tier: "SILENT" }),
        obs({ from: "b@news.acme.com", tier: "QUEUE" }),
        obs({ from: "c@news.acme.com", tier: "SILENT" }),
      ],
      { now: NOW },
    );
    expect(rules.filter((r) => r.pattern === "sender-domain")).toEqual([]);
  });

  it("does NOT learn a domain rule from a single repeated sender (sender-prior already covers it)", () => {
    const rules = mineLearnedRules(
      [
        obs({ from: "only@news.acme.com", tier: "SILENT", sourceId: "s1" }),
        obs({ from: "only@news.acme.com", tier: "SILENT", sourceId: "s2" }),
        obs({ from: "only@news.acme.com", tier: "SILENT", sourceId: "s3" }),
      ],
      { now: NOW },
    );
    expect(rules.filter((r) => r.pattern === "sender-domain")).toEqual([]);
    expect(MIN_DOMAIN_DISTINCT_SENDERS).toBe(2);
  });

  it("excludes overrides older than the max age window", () => {
    const rules = mineLearnedRules(
      [
        obs({ from: "a@news.acme.com", tier: "SILENT", updatedAt: NOW }),
        obs({ from: "b@news.acme.com", tier: "SILENT", updatedAt: NOW }),
        obs({ from: "c@news.acme.com", tier: "SILENT", updatedAt: NOW - 90 * DAY }),
      ],
      { now: NOW },
    );
    // Only 2 fresh → below floor → no rule.
    expect(rules.filter((r) => r.pattern === "sender-domain")).toEqual([]);
  });
});

describe("mineLearnedRules — subject-keyword", () => {
  it("learns a keyword rule from >=3 unanimous overrides across distinct senders", () => {
    const rules = mineLearnedRules(
      [
        obs({ from: "a@x.com", subject: "Your invoice for May", tier: "QUEUE" }),
        obs({ from: "b@y.com", subject: "Invoice attached", tier: "QUEUE" }),
        obs({ from: "c@z.com", subject: "invoice reminder", tier: "QUEUE" }),
      ],
      { now: NOW },
    );
    const kw = rules.find((r) => r.pattern === "subject-keyword" && r.value === "invoice");
    expect(kw).toMatchObject({ pattern: "subject-keyword", value: "invoice", tier: "QUEUE" });
    expect(kw?.evidenceCount).toBe(3);
    expect(kw?.distinctSenders).toBe(3);
  });

  it("does NOT learn a keyword rule concentrated in one sender", () => {
    const rules = mineLearnedRules(
      [
        obs({ from: "same@x.com", subject: "invoice 1", tier: "QUEUE" }),
        obs({ from: "same@x.com", subject: "invoice 2", tier: "QUEUE" }),
        obs({ from: "same@x.com", subject: "invoice 3", tier: "QUEUE" }),
      ],
      { now: NOW },
    );
    expect(rules.filter((r) => r.pattern === "subject-keyword")).toEqual([]);
  });

  it("returns an empty array for no observations", () => {
    expect(mineLearnedRules([], { now: NOW })).toEqual([]);
  });
});
