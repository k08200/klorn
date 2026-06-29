import { describe, expect, it } from "vitest";
import {
  domainOfAddress,
  type LearnedRule,
  matchLearnedRules,
  subjectTokens,
} from "../learned-rules.js";

describe("domainOfAddress", () => {
  it("extracts the lowercased domain from a 'Name <addr>' header", () => {
    expect(domainOfAddress("Alice <alice@Corp.com>")).toBe("corp.com");
  });

  it("handles a bare address and sub-domains", () => {
    expect(domainOfAddress("billing@sub.example.com")).toBe("sub.example.com");
  });

  it("returns null when there is no parseable domain", () => {
    expect(domainOfAddress("not-an-email")).toBeNull();
  });
});

describe("subjectTokens", () => {
  it("normalizes, drops stopwords / short / numeric tokens", () => {
    const tokens = subjectTokens("Re: Invoice #123 for ACME Corp");
    expect(tokens).toContain("invoice");
    expect(tokens).toContain("acme");
    expect(tokens).toContain("corp");
    expect(tokens).not.toContain("re"); // too short
    expect(tokens).not.toContain("for"); // too short
    expect(tokens).not.toContain("123"); // numeric
  });

  it("is empty for a subject of only noise", () => {
    expect(subjectTokens("Re: Fwd: the a an")).toEqual([]);
  });
});

describe("matchLearnedRules", () => {
  const domainRule: LearnedRule = {
    pattern: "sender-domain",
    value: "news.example.com",
    tier: "SILENT",
  };
  const keywordRule: LearnedRule = {
    pattern: "subject-keyword",
    value: "invoice",
    tier: "QUEUE",
  };

  it("matches an unseen sender on a learned domain rule", () => {
    const hit = matchLearnedRules(
      { from: "Never Seen <fresh@news.example.com>", subject: "Weekly digest" },
      [domainRule],
    );
    expect(hit).toEqual(domainRule);
  });

  it("returns null when nothing matches", () => {
    const hit = matchLearnedRules({ from: "x@other.com", subject: "hello there" }, [
      domainRule,
      keywordRule,
    ]);
    expect(hit).toBeNull();
  });

  it("matches a subject-keyword rule when the token is present", () => {
    const hit = matchLearnedRules({ from: "x@vendor.io", subject: "Your invoice is ready" }, [
      keywordRule,
    ]);
    expect(hit).toEqual(keywordRule);
  });

  it("prefers a sender-domain match over a subject-keyword match", () => {
    const hit = matchLearnedRules({ from: "a@news.example.com", subject: "invoice attached" }, [
      keywordRule,
      domainRule,
    ]);
    expect(hit).toEqual(domainRule);
  });

  it("is order-stable among same-kind matches", () => {
    const r1: LearnedRule = { pattern: "subject-keyword", value: "invoice", tier: "QUEUE" };
    const r2: LearnedRule = { pattern: "subject-keyword", value: "receipt", tier: "SILENT" };
    const hit = matchLearnedRules({ from: "x@y.com", subject: "invoice and receipt" }, [r1, r2]);
    expect(hit).toEqual(r1);
  });
});
