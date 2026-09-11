/**
 * Sender labels (2026-09-11): the user's correction of who a sender is. The
 * label is the strongest row evidence and reaches the analysis prompt, so
 * the validation and the address-over-domain precedence are the contract.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as { scope: string; value: string; category: string }[],
  findManyCalls: [] as unknown[],
}));

vi.mock("../db.js", () => ({
  prisma: {
    senderLabel: {
      findMany: vi.fn(async (args: unknown) => {
        state.findManyCalls.push(args);
        return state.rows;
      }),
      upsert: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
  },
}));

import {
  normalizeSenderLabelKey,
  senderLabelsFor,
  USER_LABEL_CATEGORIES,
  userLabelLine,
  validateSenderLabel,
} from "../mail/sender-labels.js";

describe("normalizeSenderLabelKey / validateSenderLabel", () => {
  it("a sender value may be a full From header; it is stored as the lowercase address", () => {
    expect(
      normalizeSenderLabelKey({ scope: "sender", value: "Sarah Kim <Sarah@Acme.com>" }),
    ).toEqual({ ok: { scope: "sender", value: "sarah@acme.com" } });
    expect(normalizeSenderLabelKey({ scope: "sender", value: "no address" })).toEqual({
      error: "Not an email address: no address",
    });
  });

  it("a domain value is canonicalized; public providers are refused", () => {
    expect(normalizeSenderLabelKey({ scope: "domain", value: "@Acme.io" })).toEqual({
      ok: { scope: "domain", value: "acme.io" },
    });
    // "Everyone at gmail.com is a customer" is a flood, not a correction.
    const pub = normalizeSenderLabelKey({ scope: "domain", value: "gmail.com" });
    expect("error" in pub && pub.error).toContain("public mail provider");
    expect(normalizeSenderLabelKey({ scope: "domain", value: "acme" })).toEqual({
      error: "Not a domain: acme",
    });
  });

  it("rejects an unknown scope, a missing value, an unknown category", () => {
    expect(normalizeSenderLabelKey({ scope: "team", value: "x@y.com" })).toEqual({
      error: "scope must be sender or domain",
    });
    expect(normalizeSenderLabelKey({ scope: "sender" })).toEqual({ error: "value is required" });
    const bad = validateSenderLabel({ scope: "sender", value: "x@y.com", category: "vip" });
    expect("error" in bad && bad.error).toContain("category must be one of");
    expect(
      validateSenderLabel({ scope: "sender", value: "x@y.com", category: "investor" }),
    ).toEqual({ ok: { scope: "sender", value: "x@y.com", category: "investor" } });
  });

  it("the pickable vocabulary is the chip vocabulary the client renders", () => {
    expect([...USER_LABEL_CATEGORIES]).toEqual([
      "internal",
      "customer",
      "investor",
      "system",
      "billing",
      "promotions",
    ]);
  });
});

describe("senderLabelsFor", () => {
  beforeEach(() => {
    state.rows = [];
    state.findManyCalls.length = 0;
  });

  it("one query for the page; the address label beats the domain label", async () => {
    state.rows = [
      { scope: "domain", value: "acme.com", category: "customer" },
      { scope: "sender", value: "cfo@acme.com", category: "investor" },
    ];
    const map = await senderLabelsFor("user-1", ["CFO@acme.com", "eng@acme.com", "x@other.io"]);
    expect(state.findManyCalls).toHaveLength(1);
    expect(map.get("cfo@acme.com")).toBe("investor");
    expect(map.get("eng@acme.com")).toBe("customer");
    expect(map.has("x@other.io")).toBe(false);
  });

  it("no addresses → no query; a stored value outside the vocabulary is ignored", async () => {
    expect((await senderLabelsFor("user-1", [])).size).toBe(0);
    expect(state.findManyCalls).toHaveLength(0);
    state.rows = [{ scope: "sender", value: "a@b.com", category: "vip-from-old-build" }];
    expect((await senderLabelsFor("user-1", ["a@b.com"])).size).toBe(0);
  });
});

describe("userLabelLine", () => {
  it("one authoritative line for a labeled sender, nothing otherwise", () => {
    expect(userLabelLine("customer")).toBe(
      "Sender relationship (declared by the user, authoritative): customer\n",
    );
    expect(userLabelLine(null)).toBe("");
    expect(userLabelLine("garbage")).toBe("");
  });
});
