/**
 * Klorn Teams input rules (org/org-shape.ts): what an organization name, an
 * invited address and a company domain may be. The invite mail carries the
 * name and the address, so they are held to plain text and a plain address.
 */

import { describe, expect, it } from "vitest";
import {
  normalizeDomains,
  normalizeEmail,
  normalizeOrgName,
  slugFor,
  stripInvisibleText,
} from "../org/org-shape.js";

describe("organization names", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeOrgName("  Acme   Corp ")).toBe("Acme Corp");
  });

  it("drops zero-width and bidirectional controls", () => {
    expect(normalizeOrgName("Ac‮me​")).toBe("Acme");
    expect(stripInvisibleText("a⁦b⁩c﻿")).toBe("abc");
  });

  it("refuses links, control characters, empty and over-long names", () => {
    for (const bad of [
      "https://evil.test",
      "see www.evil.test",
      "a\u0007b",
      "   ",
      "x".repeat(81),
      42,
      null,
    ]) {
      expect(normalizeOrgName(bad)).toBeNull();
    }
    expect(normalizeOrgName("x".repeat(80))).toHaveLength(80);
  });

  it("makes a readable slug with a random suffix", () => {
    expect(slugFor("Acme Corp!")).toMatch(/^acme-corp-[0-9a-f]{6}$/);
    expect(slugFor("회사")).toMatch(/^org-[0-9a-f]{6}$/);
  });
});

describe("invited addresses", () => {
  it("lowercases a plain address", () => {
    expect(normalizeEmail("  New.Person+tag@Example.COM ")).toBe("new.person+tag@example.com");
  });

  it("refuses anything that could carry a second recipient or a display name", () => {
    for (const bad of [
      "a@b.com,c@d.com",
      "a@b.com;c@d.com",
      "Name <a@b.com>",
      '"a"@b.com',
      "a b@c.com",
      "a@b",
      "a@-b.com",
      "@b.com",
      "a@",
    ]) {
      expect(normalizeEmail(bad), bad).toBeNull();
    }
  });
});

describe("company domains", () => {
  it("lowercases, strips @ and deduplicates", () => {
    expect(normalizeDomains(["@Acme.Test", "acme.test", "sub.acme.test"])).toEqual([
      "acme.test",
      "sub.acme.test",
    ]);
  });

  it("refuses a non-domain or more than ten", () => {
    expect(normalizeDomains(["bad domain"])).toBeNull();
    expect(normalizeDomains(["localhost"])).toBeNull();
    expect(normalizeDomains(Array.from({ length: 11 }, (_, i) => `d${i}.test`))).toBeNull();
    expect(normalizeDomains("acme.test")).toBeNull();
  });
});
