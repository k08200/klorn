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

describe("isPlausibleMailtoAddress (linear: the target is sender-controlled)", () => {
  it("keeps the old rule: one @, no whitespace, a dot inside the domain", async () => {
    const { isPlausibleMailtoAddress } = await import("../mail/list-unsubscribe.js");
    for (const ok of ["a@b.c", "unsub+x@lists.acme.com", "a@b..c", "a.b@c.d.e"]) {
      expect(isPlausibleMailtoAddress(ok)).toBe(true);
    }
    for (const bad of [
      "",
      "a@b",
      "@b.c",
      "a@.c",
      "a@b.",
      "a@@b.c",
      "a@b@c.d",
      "a b@c.d",
      "a@b.c ",
    ]) {
      expect(isPlausibleMailtoAddress(bad)).toBe(false);
    }
  });

  it("stays linear on a crafted domain of dots", async () => {
    const { isPlausibleMailtoAddress, parseMailtoTarget } = await import(
      "../mail/list-unsubscribe.js"
    );
    const { expectLinear, repeatTo } = await import("./helpers/linear-timing.js");
    expectLinear((n) => repeatTo(n, ".", "a@", "@"), isPlausibleMailtoAddress);
    expectLinear((n) => repeatTo(n, ".", "mailto:a@", "@"), parseMailtoTarget);
  });
});

describe("one-click hardening (docs/design/mail-cleanup-actions.md, PR1)", () => {
  it("names the client in a User-Agent: some list endpoints refuse a POST without one", async () => {
    const post = vi.fn(async () => ({ statusCode: 200 }));
    await executeOneClickUnsubscribe("https://acme.com/unsub", post);
    const headers = post.mock.calls[0]?.[2] as Record<string, string>;
    expect(headers["user-agent"]).toMatch(/^Klorn\//);
  });

  it("refuses any port but 443 without issuing a request", async () => {
    const post = vi.fn(async () => ({ statusCode: 200 }));
    for (const url of [
      "https://acme.com:8443/u",
      "https://acme.com:25/u",
      "https://acme.com:80/u",
    ]) {
      expect(await executeOneClickUnsubscribe(url, post)).toEqual({
        ok: false,
        reason: "unsafe-endpoint",
      });
    }
    expect(await executeOneClickUnsubscribe("https://acme.com:443/u", post)).toEqual({ ok: true });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("every reason it returns is a known code (the logs never print anything else)", async () => {
    const { isKnownOneClickFailure } = await import("../mail/list-unsubscribe.js");
    const reasons = [
      await executeOneClickUnsubscribe("http://acme.com/u", vi.fn()),
      await executeOneClickUnsubscribe(
        "https://acme.com/u",
        vi.fn(async () => ({ statusCode: 503 })),
      ),
      await executeOneClickUnsubscribe(
        "https://acme.com/u",
        vi.fn(async () => {
          throw new Error("connect ECONNREFUSED https://acme.com/u?token=secret");
        }),
      ),
    ].map((out) => (out.ok ? "ok" : out.reason));
    expect(reasons).toEqual(["unsafe-endpoint", "http-503", "request-error"]);
    for (const reason of reasons) expect(isKnownOneClickFailure(reason)).toBe(true);
    expect(isKnownOneClickFailure("request-failed")).toBe(false);
    expect(isKnownOneClickFailure("connect ECONNREFUSED https://acme.com/u?token=secret")).toBe(
      false,
    );
  });
});
