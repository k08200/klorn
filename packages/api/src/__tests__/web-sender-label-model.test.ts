/**
 * Mail v2 reader sender label correction — the pure rules in
 * packages/web/src/app/email/[id]/_v2/sender-label-model.ts: which choices the
 * menu offers, the optimistic state, and the request each choice sends.
 */

import type { ReaderSenderLabel } from "@klorn/contract";
import { describe, expect, it } from "vitest";
import {
  applySenderLabelChange,
  SENDER_LABEL_CATEGORIES,
  senderLabelOptions,
  senderLabelRequest,
} from "../../../web/src/app/email/[id]/_v2/sender-label-model";
import { USER_LABEL_CATEGORIES } from "../mail/sender-labels.js";

const DERIVED: ReaderSenderLabel = {
  address: "ada@example.com",
  domain: "example.com",
  current: "promotions",
  correction: null,
};

describe("senderLabelOptions", () => {
  it("offers every category the server accepts, for the address and the domain", () => {
    expect([...SENDER_LABEL_CATEGORIES]).toEqual([...USER_LABEL_CATEGORIES]);
    const options = senderLabelOptions(DERIVED);
    expect(options.address.map((c) => c.category)).toEqual([...USER_LABEL_CATEGORIES]);
    expect(options.domain?.value).toBe("example.com");
    expect(options.domain?.choices.map((c) => c.change)).toContainEqual({
      kind: "set",
      scope: "domain",
      category: "customer",
    });
  });

  it("a derived label is never checked, and there is nothing of the user's to clear", () => {
    const options = senderLabelOptions(DERIVED);
    expect(options.address.some((c) => c.checked)).toBe(false);
    expect(options.domain?.choices.some((c) => c.checked)).toBe(false);
    expect(options.clear).toBeNull();
  });

  it("checks the user's correction only at its own scope, and offers to clear it", () => {
    const byAddress = senderLabelOptions({ ...DERIVED, current: "customer", correction: "sender" });
    expect(byAddress.address.filter((c) => c.checked).map((c) => c.category)).toEqual(["customer"]);
    expect(byAddress.domain?.choices.some((c) => c.checked)).toBe(false);
    expect(byAddress.clear).toBe("sender");

    const byDomain = senderLabelOptions({ ...DERIVED, current: "investor", correction: "domain" });
    expect(byDomain.address.some((c) => c.checked)).toBe(false);
    expect(byDomain.domain?.choices.filter((c) => c.checked).map((c) => c.category)).toEqual([
      "investor",
    ]);
    expect(byDomain.clear).toBe("domain");
  });

  it("offers no domain when the server names none (a public mail provider)", () => {
    expect(senderLabelOptions({ ...DERIVED, domain: null }).domain).toBeNull();
  });

  it("gives every choice a distinct id", () => {
    const options = senderLabelOptions(DERIVED);
    const ids = [...options.address, ...(options.domain?.choices ?? [])].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("applySenderLabelChange (optimistic state)", () => {
  it("a set shows the new label as the user's own, at its scope", () => {
    expect(
      applySenderLabelChange(DERIVED, { kind: "set", scope: "domain", category: "investor" }),
    ).toEqual({ ...DERIVED, current: "investor", correction: "domain" });
  });

  it("a clear of the correction in effect claims no label until the server answers", () => {
    const corrected: ReaderSenderLabel = { ...DERIVED, current: "customer", correction: "sender" };
    expect(applySenderLabelChange(corrected, { kind: "clear", scope: "sender" })).toEqual({
      ...DERIVED,
      current: null,
      correction: null,
    });
  });

  it("a clear of another scope changes nothing on screen", () => {
    const corrected: ReaderSenderLabel = { ...DERIVED, current: "customer", correction: "sender" };
    expect(applySenderLabelChange(corrected, { kind: "clear", scope: "domain" })).toBe(corrected);
  });

  it("never mutates the state it was given", () => {
    const before = { ...DERIVED };
    applySenderLabelChange(DERIVED, { kind: "set", scope: "sender", category: "billing" });
    expect(DERIVED).toEqual(before);
  });
});

describe("senderLabelRequest", () => {
  it("a set is a PUT carrying the server's own address or domain", () => {
    const put = senderLabelRequest(DERIVED, { kind: "set", scope: "sender", category: "customer" });
    expect(put?.method).toBe("PUT");
    expect(put?.path).toBe("/api/email/sender-labels");
    expect(JSON.parse(put?.body ?? "")).toEqual({
      scope: "sender",
      value: "ada@example.com",
      category: "customer",
    });
    const domain = senderLabelRequest(DERIVED, {
      kind: "set",
      scope: "domain",
      category: "investor",
    });
    expect(JSON.parse(domain?.body ?? "")).toMatchObject({ scope: "domain", value: "example.com" });
  });

  it("a clear is a DELETE with the key in an encoded query and no body", () => {
    const del = senderLabelRequest(
      { ...DERIVED, address: "a+b@example.com" },
      { kind: "clear", scope: "sender" },
    );
    expect(del).toEqual({
      method: "DELETE",
      path: "/api/email/sender-labels?scope=sender&value=a%2Bb%40example.com",
    });
  });

  it("sends nothing for a domain the server did not offer", () => {
    const publicSender = { ...DERIVED, domain: null };
    expect(
      senderLabelRequest(publicSender, { kind: "set", scope: "domain", category: "customer" }),
    ).toBeNull();
    expect(senderLabelRequest(publicSender, { kind: "clear", scope: "domain" })).toBeNull();
  });
});
