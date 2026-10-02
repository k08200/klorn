/**
 * list-unsubscribe — header parsing (RFC 2369 List-Unsubscribe + RFC 8058
 * List-Unsubscribe-Post) and the one-click POST. Parsing is defensive: the
 * header is sender-controlled. One-click is https-only by RFC and goes
 * through the same SSRF guard as web-push endpoints; the request itself is
 * injected so the guard boundary is testable without network.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { executeOneClickUnsubscribe, parseListUnsubscribe } from "../mail/list-unsubscribe.js";

describe("parseListUnsubscribe", () => {
  it("parses mailto and https entries from the bracketed list", () => {
    const out = parseListUnsubscribe(
      "<mailto:unsub@lists.acme.com?subject=stop>, <https://acme.com/unsub?u=1>",
      "",
    );
    expect(out).toEqual({
      mailto: "mailto:unsub@lists.acme.com?subject=stop",
      url: "https://acme.com/unsub?u=1",
      oneClick: false,
    });
  });

  it("flags one-click only when the post header says so AND an https url exists", () => {
    const withPost = parseListUnsubscribe("<https://acme.com/unsub>", "List-Unsubscribe=One-Click");
    expect(withPost.oneClick).toBe(true);
    const mailtoOnly = parseListUnsubscribe(
      "<mailto:unsub@acme.com>",
      "List-Unsubscribe=One-Click",
    );
    expect(mailtoOnly.oneClick).toBe(false);
  });

  it("keeps an http (non-TLS) link as a plain url but never one-click", () => {
    const out = parseListUnsubscribe("<http://acme.com/unsub>", "List-Unsubscribe=One-Click");
    expect(out.url).toBe("http://acme.com/unsub");
    expect(out.oneClick).toBe(false);
  });

  it("returns empties for a missing or junk header", () => {
    expect(parseListUnsubscribe("", "")).toEqual({ mailto: null, url: null, oneClick: false });
    expect(parseListUnsubscribe("not a header", "")).toEqual({
      mailto: null,
      url: null,
      oneClick: false,
    });
  });

  it("takes the first entry of each kind and ignores other schemes", () => {
    const out = parseListUnsubscribe(
      "<ftp://x>, <https://a.com/1>, <https://b.com/2>, <mailto:first@a.com>, <mailto:second@b.com>",
      "",
    );
    expect(out.url).toBe("https://a.com/1");
    expect(out.mailto).toBe("mailto:first@a.com");
  });

  it("caps stored values at a sane length (sender-controlled header)", () => {
    const longUrl = `https://acme.com/${"x".repeat(3000)}`;
    const out = parseListUnsubscribe(`<${longUrl}>`, "");
    expect(out.url).toBeNull();
  });
});

describe("executeOneClickUnsubscribe", () => {
  it("refuses a non-https or unsafe endpoint without issuing a request", async () => {
    const post = vi.fn();
    expect(await executeOneClickUnsubscribe("http://acme.com/u", post)).toEqual({
      ok: false,
      reason: "unsafe-endpoint",
    });
    expect(await executeOneClickUnsubscribe("https://127.0.0.1/u", post)).toEqual({
      ok: false,
      reason: "unsafe-endpoint",
    });
    expect(post).not.toHaveBeenCalled();
  });

  it("POSTs the RFC 8058 body to a safe endpoint and reports 2xx as done", async () => {
    const post = vi.fn(async () => ({ statusCode: 200 }));
    const out = await executeOneClickUnsubscribe("https://acme.com/unsub", post);
    expect(out).toEqual({ ok: true });
    expect(post).toHaveBeenCalledWith(
      "https://acme.com/unsub",
      "List-Unsubscribe=One-Click",
      expect.objectContaining({ "content-type": "application/x-www-form-urlencoded" }),
    );
  });

  it("reports a 5xx as failure without throwing", async () => {
    const post = vi.fn(async () => ({ statusCode: 503 }));
    expect(await executeOneClickUnsubscribe("https://acme.com/unsub", post)).toEqual({
      ok: false,
      reason: "http-503",
    });
  });

  it("reports a thrown transport error as failure without throwing", async () => {
    const post = vi.fn(async () => {
      throw new Error("connect timeout");
    });
    const out = await executeOneClickUnsubscribe("https://acme.com/unsub", post);
    expect(out.ok).toBe(false);
  });
});

describe("parseMailtoTarget", () => {
  it("extracts address, subject and body from a mailto URI", async () => {
    const { parseMailtoTarget } = await import("../mail/list-unsubscribe.js");
    expect(
      parseMailtoTarget("mailto:unsub@lists.acme.com?subject=stop%20mail&body=please"),
    ).toEqual({
      to: "unsub@lists.acme.com",
      subject: "stop mail",
      body: "please",
    });
  });

  it("defaults subject and body to 'unsubscribe'", async () => {
    const { parseMailtoTarget } = await import("../mail/list-unsubscribe.js");
    expect(parseMailtoTarget("mailto:unsub@acme.com")).toEqual({
      to: "unsub@acme.com",
      subject: "unsubscribe",
      body: "unsubscribe",
    });
  });

  it("refuses a sender-controlled subject or body over the cap, so the caller falls back to the link", async () => {
    const { parseMailtoTarget, MAX_MAILTO_SUBJECT_LENGTH, MAX_MAILTO_BODY_LENGTH } = await import(
      "../mail/list-unsubscribe.js"
    );
    const at = (subject: string, body: string) =>
      parseMailtoTarget(
        `mailto:unsub@acme.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
      );
    expect(at("s".repeat(MAX_MAILTO_SUBJECT_LENGTH), "b")).not.toBeNull();
    expect(at("s".repeat(MAX_MAILTO_SUBJECT_LENGTH + 1), "b")).toBeNull();
    expect(at("s", "b".repeat(MAX_MAILTO_BODY_LENGTH))).not.toBeNull();
    expect(at("s", "b".repeat(MAX_MAILTO_BODY_LENGTH + 1))).toBeNull();
    expect(MAX_MAILTO_SUBJECT_LENGTH).toBeLessThanOrEqual(300);
    expect(MAX_MAILTO_BODY_LENGTH).toBeLessThanOrEqual(2_000);
  });

  it("measures the decoded text, not the URI, and ignores a huge query parameter it does not use", async () => {
    const { parseMailtoTarget } = await import("../mail/list-unsubscribe.js");
    expect(
      parseMailtoTarget(
        `mailto:unsub@acme.com?subject=${"%41".repeat(100)}&cc=${"x".repeat(50_000)}`,
      ),
    ).toMatchObject({ subject: "A".repeat(100) });
  });

  it("returns null for junk or non-address targets", async () => {
    const { parseMailtoTarget } = await import("../mail/list-unsubscribe.js");
    expect(parseMailtoTarget("mailto:not an address")).toBeNull();
    expect(parseMailtoTarget("https://acme.com")).toBeNull();
    expect(parseMailtoTarget("mailto:")).toBeNull();
  });
});

describe("scheme priority", () => {
  it("prefers a later https entry over an earlier http one (one-click stays eligible)", () => {
    const out = parseListUnsubscribe(
      "<http://legacy.acme.com/unsub>, <https://acme.com/unsub>",
      "List-Unsubscribe=One-Click",
    );
    expect(out.url).toBe("https://acme.com/unsub");
    expect(out.oneClick).toBe(true);
  });
});
