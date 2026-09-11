/**
 * Company domains (2026-09-10): the user declares their company's email
 * domains; a sender on one is 회사 as a RECORDED fact. The validation is the
 * point — the value is user input that reaches a prompt and a row chip.
 */

import { describe, expect, it } from "vitest";
import {
  isInternalSender,
  MAX_COMPANY_DOMAINS,
  normalizeCompanyDomains,
  normalizeDomain,
  senderDomain,
  suggestedCompanyDomain,
} from "../mail/company-domains.js";
import { analysisPreamble } from "../mail/email-summarize.js";

describe("normalizeDomain", () => {
  it("accepts what people paste and returns the canonical hostname", () => {
    expect(normalizeDomain("Acme.com")).toBe("acme.com");
    expect(normalizeDomain("  @acme.com ")).toBe("acme.com");
    expect(normalizeDomain("*.acme.com")).toBe("acme.com");
    expect(normalizeDomain("https://acme.com/about")).toBe("acme.com");
    expect(normalizeDomain("me@mail.acme.co.kr")).toBe("mail.acme.co.kr");
    expect(normalizeDomain("acme.com.")).toBe("acme.com");
  });

  it("rejects anything that is not a domain", () => {
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain("acme")).toBeNull();
    expect(normalizeDomain("acme .com")).toBeNull();
    expect(normalizeDomain("-acme.com")).toBeNull();
    expect(normalizeDomain("acme.com; DROP TABLE")).toBeNull();
    expect(normalizeDomain(`${"a".repeat(64)}.com`)).toBeNull();
  });
});

describe("normalizeCompanyDomains", () => {
  it("dedupes, skips blanks, keeps order", () => {
    expect(normalizeCompanyDomains(["Acme.com", "", " acme.com", "sub.acme.io"])).toEqual({
      domains: ["acme.com", "sub.acme.io"],
    });
    expect(normalizeCompanyDomains([])).toEqual({ domains: [] });
  });

  it("rejects loudly, naming the offending value", () => {
    expect(normalizeCompanyDomains("acme.com")).toEqual({ error: "domains must be an array" });
    expect(normalizeCompanyDomains([42])).toEqual({ error: "domains must be strings" });
    expect(normalizeCompanyDomains(["acme.com", "not a domain"])).toEqual({
      error: "Not a domain: not a domain",
    });
  });

  it("a public mail provider is never a company domain", () => {
    // gmail.com as "my company" would mark the whole world 회사.
    const result = normalizeCompanyDomains(["acme.com", "Gmail.com"]);
    expect("error" in result && result.error).toContain("gmail.com is a public mail provider");
    expect("error" in normalizeCompanyDomains(["naver.com"])).toBe(true);
  });

  it("caps the list", () => {
    const many = Array.from({ length: MAX_COMPANY_DOMAINS + 1 }, (_, i) => `d${i}.com`);
    expect(normalizeCompanyDomains(many)).toEqual({
      error: `At most ${MAX_COMPANY_DOMAINS} domains`,
    });
    expect(normalizeCompanyDomains(many.slice(0, MAX_COMPANY_DOMAINS))).toEqual({
      domains: many.slice(0, MAX_COMPANY_DOMAINS),
    });
  });
});

describe("senderDomain / isInternalSender", () => {
  it("reads the From header's domain, lowercase", () => {
    expect(senderDomain("Sarah Kim <Sarah@Acme.com>")).toBe("acme.com");
    expect(senderDomain("bob@mail.acme.com")).toBe("mail.acme.com");
    expect(senderDomain(null)).toBeNull();
    expect(senderDomain("no address here")).toBeNull();
  });

  it("exact or subdomain match is internal; a lookalike suffix is not", () => {
    const domains = ["acme.com"];
    expect(isInternalSender("Sarah <sarah@acme.com>", domains)).toBe(true);
    expect(isInternalSender("bot@mail.acme.com", domains)).toBe(true);
    expect(isInternalSender("x@notacme.com", domains)).toBe(false);
    expect(isInternalSender("x@acme.com.evil.io", domains)).toBe(false);
    expect(isInternalSender("x@other.com", domains)).toBe(false);
  });

  it("no declared domains, or no From, is never internal", () => {
    expect(isInternalSender("x@acme.com", [])).toBe(false);
    expect(isInternalSender(null, ["acme.com"])).toBe(false);
  });
});

describe("suggestedCompanyDomain", () => {
  it("offers the account's own domain, never a public provider", () => {
    expect(suggestedCompanyDomain("yong@acme.com")).toBe("acme.com");
    expect(suggestedCompanyDomain("k0820086@gmail.com")).toBeNull();
    expect(suggestedCompanyDomain("someone@naver.com")).toBeNull();
    expect(suggestedCompanyDomain(null)).toBeNull();
  });
});

describe("analysisPreamble + company domains", () => {
  it("names the internal domains after the purpose sentence", () => {
    const text = analysisPreamble("work", ["acme.com", "acme.io"]);
    expect(text.startsWith(analysisPreamble("work"))).toBe(true);
    expect(text).toContain("acme.com, acme.io");
    expect(text).toContain("INTERNAL");
  });

  it("no domains → byte-identical to the purpose-only preamble", () => {
    expect(analysisPreamble("work", [])).toBe(analysisPreamble("work"));
    expect(analysisPreamble(null, [])).toBe(analysisPreamble(null));
    expect(analysisPreamble("personal", [])).toBe(analysisPreamble("personal"));
  });
});
