import { describe, expect, it } from "vitest";
import { gmailDmarcPass, readShadowHeaders } from "../mail/gmail-fetch.js";

const h = (pairs: Record<string, string>) =>
  Object.entries(pairs).map(([name, value]) => ({ name, value }));

describe("readShadowHeaders", () => {
  it("reads list, precedence, auto-submitted and the raw Date header", () => {
    const r = readShadowHeaders(
      h({
        "List-Id": "<announce.example.com>",
        Precedence: "bulk",
        "Auto-Submitted": "auto-generated",
        Date: "Fri, 30 Oct 2026 09:12:00 +0900",
      }),
      { mimeType: "text/plain" },
    );
    expect(r).toEqual({
      listId: "<announce.example.com>",
      precedence: "bulk",
      autoSubmitted: "auto-generated",
      dateHeader: "Fri, 30 Oct 2026 09:12:00 +0900",
      hasCalendarInvite: false,
      dmarcPass: null,
    });
  });

  it("returns nulls for absent headers and caps their length", () => {
    const r = readShadowHeaders(h({ "List-Id": "x".repeat(5000) }), {});
    expect(r.precedence).toBeNull();
    expect(r.dateHeader).toBeNull();
    expect(r.listId?.length).toBeLessThanOrEqual(500);
  });

  it("detects a calendar invite from a text/calendar part anywhere, with or without a filename", () => {
    const nested = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [{ mimeType: "text/plain" }, { mimeType: "text/calendar" }],
        },
      ],
    };
    expect(readShadowHeaders([], nested).hasCalendarInvite).toBe(true);
    expect(
      readShadowHeaders([], {
        mimeType: "multipart/mixed",
        parts: [{ mimeType: "application/octet-stream", filename: "invite.ICS" }],
      }).hasCalendarInvite,
    ).toBe(true);
    expect(readShadowHeaders([], { mimeType: "application/ics" }).hasCalendarInvite).toBe(true);
    expect(
      readShadowHeaders([], { mimeType: "multipart/mixed", parts: [{ mimeType: "text/html" }] })
        .hasCalendarInvite,
    ).toBe(false);
  });

  it("stops at the MIME depth limit", () => {
    let part: Record<string, unknown> = { mimeType: "text/calendar" };
    for (let i = 0; i < 30; i++) part = { mimeType: "multipart/mixed", parts: [part] };
    expect(readShadowHeaders([], part).hasCalendarInvite).toBe(false);
  });
});

describe("gmailDmarcPass", () => {
  const ar = (v: string) => ({ name: "Authentication-Results", value: v });
  const from = { name: "From", value: "Kim <kim@acme.com>" };
  const google =
    "mx.google.com;\r\n dkim=pass header.i=@acme.com;\r\n spf=pass smtp.mailfrom=kim@acme.com;\r\n dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=acme.com";

  it("trusts Gmail's own verdict for the From domain", () => {
    expect(gmailDmarcPass([ar(google), from])).toBe(true);
  });

  it("is false for a failed or misaligned verdict", () => {
    expect(gmailDmarcPass([ar(google.replace("dmarc=pass", "dmarc=fail")), from])).toBe(false);
    expect(
      gmailDmarcPass([ar(google.replace("header.from=acme.com", "header.from=evil.com")), from]),
    ).toBe(false);
  });

  it("ignores a sender-written header below Gmail's, and any other authserv-id", () => {
    const forged = ar("mx.google.com; dmarc=pass header.from=acme.com");
    expect(gmailDmarcPass([ar(google.replace("dmarc=pass", "dmarc=fail")), forged, from])).toBe(
      false,
    );
    expect(gmailDmarcPass([ar("evil.example; dmarc=pass header.from=acme.com"), from])).toBeNull();
    expect(gmailDmarcPass([from])).toBeNull();
  });
});
