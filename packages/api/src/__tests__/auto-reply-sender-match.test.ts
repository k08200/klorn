import { describe, expect, it } from "vitest";
import { ruleSenderMatches } from "../mail/email-reply.js";

// An AUTO_REPLY rule sends an LLM-written reply with no per-message approval,
// to the From header's ADDRESS. Its `from` condition used to be a substring of
// the WHOLE header, display name included, so
//   From: "boss@company.com" <attacker@evil.com>
// matched a rule for boss@company.com and the reply went to the attacker.
// Patterns now match the parsed address only.

describe("ruleSenderMatches", () => {
  it("matches an address pattern only on the sender's own address", () => {
    const patterns = ["boss@company.com"];
    expect(ruleSenderMatches(patterns, "Boss <boss@company.com>")).toBe(true);
    expect(ruleSenderMatches(patterns, "BOSS@Company.COM")).toBe(true);
    expect(ruleSenderMatches(patterns, '"boss@company.com" <attacker@evil.com>')).toBe(false);
    expect(ruleSenderMatches(patterns, "boss@company.com.evil.com")).toBe(false);
    expect(ruleSenderMatches(patterns, "theboss@company.com")).toBe(false);
  });

  it("matches a bare domain and its subdomains, never a lookalike", () => {
    const patterns = ["company.com"];
    expect(ruleSenderMatches(patterns, "x@company.com")).toBe(true);
    expect(ruleSenderMatches(patterns, "x@mail.company.com")).toBe(true);
    expect(ruleSenderMatches(patterns, "x@evilcompany.com")).toBe(false);
    expect(ruleSenderMatches(patterns, "x@company.com.evil.com")).toBe(false);
    expect(ruleSenderMatches(patterns, '"x@company.com" <a@evil.com>')).toBe(false);
  });

  it("matches an @domain pattern on exactly that domain", () => {
    const patterns = ["@company.com"];
    expect(ruleSenderMatches(patterns, "Ann <ann@company.com>")).toBe(true);
    expect(ruleSenderMatches(patterns, "ann@mail.company.com")).toBe(false);
  });

  it("never matches on a display name", () => {
    expect(ruleSenderMatches(["Kim Jiwoo"], "Kim Jiwoo <kim@example.com>")).toBe(false);
    expect(ruleSenderMatches(["kim"], "Kim <someone@example.com>")).toBe(false);
  });

  it("fails closed on a From value it cannot read as one mailbox", () => {
    const patterns = ["company.com"];
    expect(ruleSenderMatches(patterns, "a <x@company.com> <y@evil.com>")).toBe(false);
    expect(ruleSenderMatches(patterns, "")).toBe(false);
  });

  it("ignores blank patterns and matches any listed one", () => {
    expect(ruleSenderMatches(["", "  "], "x@company.com")).toBe(false);
    expect(ruleSenderMatches(["other.org", " Company.com "], "x@company.com")).toBe(true);
  });
});

describe("ruleSenderMatches — review hardening", () => {
  it('does not treat a dotless word as a domain ("com" is not every .com sender)', () => {
    expect(ruleSenderMatches(["com"], "x@company.com")).toBe(false);
  });

  it("only matches a plain single address", () => {
    expect(ruleSenderMatches(["company.com"], "attacker@evil.com, x@company.com")).toBe(false);
    expect(ruleSenderMatches(["company.com"], '"a b"@company.com')).toBe(false);
  });

  it("refuses a non-ASCII address that lowercases into the pattern", () => {
    // Kelvin sign: lowercases to "k", but the reply would go to the unfolded form.
    expect(ruleSenderMatches(["koss@company.com"], "Koss@company.com")).toBe(false);
  });

  it("does not let a sub-address stand in for the exact address", () => {
    expect(ruleSenderMatches(["boss@company.com"], "boss+x@company.com")).toBe(false);
  });
});
