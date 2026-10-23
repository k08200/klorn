/**
 * The pure halves of the Klorn mailbox's inbound webhook (step E1b of
 * docs/providers/unified-platform-plan.md): which recipients of a signed
 * `email.received` event are Klorn addresses, and how Resend's parsed content
 * becomes the row the shared store writes. No network, no database.
 */

import { describe, expect, it } from "vitest";
import { extractEmailAddress } from "../mail/email-address.js";
import { MAX_STORED_CC_LENGTH, MAX_STORED_SUBJECT_LENGTH } from "../mail/imap-envelope.js";
import {
  indexHeaders,
  klornMessageId,
  MAX_HEADER_KEYS,
  oversizedHeaders,
  type ResendReceivedContent,
  resendToRawEmail,
  whitelistAuthentication,
} from "../mail/klorn-inbound-map.js";
import { inboundRecipients, MAX_INBOUND_RECIPIENTS } from "../mail/klorn-inbound-recipients.js";
import { MAX_STORED_BODY_CHARS } from "../mail/stored-mail-text.js";

const DOMAIN = "klorn.ai";
const EMAIL_ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";
const ADDRESS = "jane@klorn.ai";

function eventData(overrides: Record<string, unknown> = {}) {
  return {
    email_id: EMAIL_ID,
    created_at: "2026-10-22T10:00:00.000Z",
    from: "sender@example.com",
    to: [ADDRESS],
    cc: [],
    bcc: [],
    received_for: [],
    message_id: "<m1@example.com>",
    subject: "Hi",
    attachments: [],
    ...overrides,
  };
}

function content(overrides: Partial<ResendReceivedContent> = {}): ResendReceivedContent {
  return {
    object: "email",
    id: EMAIL_ID,
    to: [ADDRESS],
    from: "sender@example.com",
    created_at: "2026-10-22T10:00:00.000Z",
    subject: "Quarterly numbers",
    bcc: null,
    cc: null,
    reply_to: null,
    received_for: [],
    html: "<p>Hello <b>Jane</b></p>",
    text: "Hello Jane, the numbers are attached.",
    headers: { from: "Sam Sender <sender@example.com>", to: "Jane <jane@klorn.ai>" },
    message_id: "<m1@example.com>",
    attachments: [],
    ...overrides,
  };
}

describe("inboundRecipients", () => {
  it("collects to, cc, bcc and received_for at the domain, deduplicated case-insensitively", () => {
    const result = inboundRecipients(
      eventData({
        to: ["JANE@KLORN.AI", "bob@example.com"],
        cc: ["sam@Klorn.AI"],
        bcc: ["jane@klorn.ai"],
        received_for: ["lee@klorn.ai", "sam@klorn.ai"],
      }),
      DOMAIN,
    );
    expect(result.handles).toEqual(["jane", "sam", "lee"]);
    expect(result.system).toEqual([]);
    // An address at another domain is not a Klorn recipient, so not a drop.
    expect(result.dropped).toBe(0);
  });

  it("reads the address inside a display-name form", () => {
    const result = inboundRecipients(eventData({ to: ['"Jane D." <Jane@klorn.ai>'] }), DOMAIN);
    expect(result.handles).toEqual(["jane"]);
  });

  it("drops a non-ASCII local part instead of case folding it (U+212A is not k)", () => {
    const result = inboundRecipients(eventData({ to: ["Kate@klorn.ai", "jäne@klorn.ai"] }), DOMAIN);
    expect(result.handles).toEqual([]);
    expect(result.dropped).toBe(2);
  });

  it("never matches the domain through Unicode case folding", () => {
    const result = inboundRecipients(eventData({ to: ["kate@Klorn.ai"] }), DOMAIN);
    expect(result.handles).toEqual([]);
    expect(result.dropped).toBe(0);
  });

  it("drops plus tags and malformed handles, and counts each once", () => {
    const result = inboundRecipients(
      eventData({
        to: ["jane+news@klorn.ai", "a..b@klorn.ai", "ab@klorn.ai"],
        cc: ["A..B@klorn.ai"],
      }),
      DOMAIN,
    );
    expect(result.handles).toEqual([]);
    expect(result.system).toEqual([]);
    expect(result.dropped).toBe(3);
  });

  it("looks reserved names up like any handle: the shape decides, not the reserved list", () => {
    // A later addition to the list must never stop delivery to an existing owner;
    // a name that was reserved all along simply has no row.
    const result = inboundRecipients(
      eventData({ to: ["support@klorn.ai", "post.master@klorn.ai"], cc: ["SUPPORT@klorn.ai"] }),
      DOMAIN,
    );
    expect(result.handles).toEqual(["support", "post.master"]);
    expect(result.dropped).toBe(0);
  });

  it("drops the CA/Browser Forum validation names, whatever the database holds", () => {
    const result = inboundRecipients(
      eventData({
        to: [
          "admin@klorn.ai",
          "ADMINISTRATOR@klorn.ai",
          "webmaster@klorn.ai",
          "hostmaster@klorn.ai",
        ],
      }),
      DOMAIN,
    );
    expect(result.handles).toEqual([]);
    expect(result.system).toEqual([]);
    expect(result.dropped).toBe(4);
  });

  it("counts how many addresses were at the domain at all", () => {
    expect(
      inboundRecipients(eventData({ to: ["a@example.com"], cc: ["b@other.ai"] }), DOMAIN).matched,
    ).toBe(0);
    expect(
      inboundRecipients(
        eventData({ to: ["jane@klorn.ai", "x@example.com"], cc: ["JANE@klorn.ai"] }),
        DOMAIN,
      ).matched,
    ).toBe(2);
  });

  it("puts postmaster and abuse on the system list, exactly", () => {
    const result = inboundRecipients(
      eventData({ to: ["POSTMASTER@klorn.ai", "abuse@klorn.ai", "postmaster@klorn.ai"] }),
      DOMAIN,
    );
    expect(result.system).toEqual(["postmaster", "abuse"]);
    expect(result.handles).toEqual([]);
    expect(result.dropped).toBe(0);
  });

  it("ignores entries that are not strings and fields that are not arrays", () => {
    const result = inboundRecipients(
      eventData({ to: [42, null, "jane@klorn.ai"], cc: "sam@klorn.ai", bcc: undefined }),
      DOMAIN,
    );
    expect(result.handles).toEqual(["jane"]);
  });

  it("caps the handles one event can name and counts the rest as dropped", () => {
    const many = Array.from({ length: MAX_INBOUND_RECIPIENTS + 5 }, (_, i) => `user${i}@klorn.ai`);
    const result = inboundRecipients(eventData({ to: many }), DOMAIN);
    expect(result.handles).toHaveLength(MAX_INBOUND_RECIPIENTS);
    expect(result.dropped).toBe(5);
  });
});

describe("whitelistAuthentication", () => {
  it("keeps the known verdicts, lowercased", () => {
    expect(whitelistAuthentication({ spf: "PASS", dkim: " fail ", dmarc: "softfail" })).toEqual({
      spf: "pass",
      dkim: "fail",
      dmarc: "softfail",
    });
    for (const verdict of ["neutral", "none", "temperror", "permerror"]) {
      expect(whitelistAuthentication({ spf: verdict, dkim: verdict, dmarc: verdict })?.spf).toBe(
        verdict,
      );
    }
  });

  it("turns anything else into unknown, per field", () => {
    expect(
      whitelistAuthentication({ spf: "<script>", dkim: 5, dmarc: { result: "pass" } }),
    ).toEqual({ spf: "unknown", dkim: "unknown", dmarc: "unknown" });
    expect(whitelistAuthentication({ spf: "pass" })).toEqual({
      spf: "pass",
      dkim: "unknown",
      dmarc: "unknown",
    });
  });

  it("is null when Resend sent no authentication object", () => {
    expect(whitelistAuthentication(undefined)).toBeNull();
    expect(whitelistAuthentication(null)).toBeNull();
    expect(whitelistAuthentication("pass")).toBeNull();
    expect(whitelistAuthentication(["pass"])).toBeNull();
  });
});

describe("resendToRawEmail", () => {
  it("names the row klorn:<email_id>: no address, so no shared log or report carries one", () => {
    expect(klornMessageId(EMAIL_ID)).toBe(`klorn:${EMAIL_ID}`);
    expect(resendToRawEmail(content(), eventData()).gmailId).toBe(`klorn:${EMAIL_ID}`);
  });

  it("maps the fixed fields like IMAP: inbox, unread, no thread, no attachments, no HTML", () => {
    const raw = resendToRawEmail(content(), eventData());
    expect(raw).toMatchObject({
      threadId: null,
      labels: ["INBOX", "UNREAD"],
      isRead: false,
      isStarred: false,
      attachments: [],
      htmlBody: "",
      subject: "Quarterly numbers",
    });
  });

  it("takes From from the headers (the display name), else the bare from", () => {
    expect(resendToRawEmail(content(), eventData()).from).toBe("Sam Sender <sender@example.com>");
    expect(resendToRawEmail(content({ headers: null }), eventData()).from).toBe(
      "sender@example.com",
    );
    // Header names are case-insensitive.
    expect(
      resendToRawEmail(content({ headers: { From: "Sam <sender@example.com>" } }), eventData())
        .from,
    ).toBe("Sam <sender@example.com>");
  });

  it("takes To and Cc from the headers, else the joined arrays, capped like IMAP", () => {
    const fromHeaders = resendToRawEmail(
      content({ headers: { to: "Jane <jane@klorn.ai>", cc: "a@example.com, b@example.com" } }),
      eventData(),
    );
    expect(fromHeaders.to).toBe("Jane <jane@klorn.ai>");
    expect(fromHeaders.cc).toBe("a@example.com, b@example.com");

    const fromArrays = resendToRawEmail(
      content({ headers: {}, to: ["jane@klorn.ai", "sam@klorn.ai"], cc: ["c@example.com"] }),
      eventData(),
    );
    expect(fromArrays.to).toBe("jane@klorn.ai, sam@klorn.ai");
    expect(fromArrays.cc).toBe("c@example.com");
    expect(resendToRawEmail(content({ headers: {}, cc: null }), eventData()).cc).toBe("");

    // Never cut: an entry that cannot be stored whole is left out.
    const long = "x".repeat(MAX_STORED_CC_LENGTH + 100);
    const capped = resendToRawEmail(content({ headers: { to: long, cc: long } }), eventData());
    expect(capped.to).toBe("");
    expect(capped.cc).toBe("");
    const many = Array.from({ length: 400 }, (_, i) => `p${i}@example.com`).join(", ");
    const whole = resendToRawEmail(content({ headers: { to: many } }), eventData());
    expect(whole.to.length).toBeLessThanOrEqual(MAX_STORED_CC_LENGTH);
    expect(whole.to.endsWith("@example.com")).toBe(true);
  });

  it.each([
    [
      "a long quoted display name",
      `"${"x".repeat(10)} <jane@klorn.ai> ${"y".repeat(3_990)}" <attacker@evil.com>`,
    ],
    [
      "an atom phrase with one encoded word",
      `=?utf-8?Q?=3Cjane=40klorn.ai=3E?= ${"a".repeat(4_000)} <attacker@evil.com>`,
    ],
  ])("stores the real From and To mailbox behind %s", (_label, raw) => {
    const mapped = resendToRawEmail(content({ headers: { from: raw, to: raw } }), eventData());
    expect(extractEmailAddress(mapped.from)).toBe("attacker@evil.com");
    expect(extractEmailAddress(mapped.to)).toBe("attacker@evil.com");
  });

  it("caps the subject and stores a placeholder for an empty one", () => {
    expect(
      resendToRawEmail(content({ subject: "y".repeat(MAX_STORED_SUBJECT_LENGTH + 5) }), eventData())
        .subject,
    ).toHaveLength(MAX_STORED_SUBJECT_LENGTH);
    expect(resendToRawEmail(content({ subject: "   " }), eventData()).subject).toBe("(no subject)");
  });

  it("uses text for the body, else the HTML as plain text, capped at IMAP's limit", () => {
    expect(resendToRawEmail(content(), eventData()).body).toBe(
      "Hello Jane, the numbers are attached.",
    );
    const htmlOnly = resendToRawEmail(content({ text: null }), eventData());
    expect(htmlOnly.body).toBe("Hello Jane");
    expect(htmlOnly.htmlBody).toBe("");
    expect(resendToRawEmail(content({ text: null, html: null }), eventData()).body).toBe("");

    const huge = resendToRawEmail(
      content({ text: "z".repeat(MAX_STORED_BODY_CHARS + 1_000) }),
      eventData(),
    );
    expect(huge.body).toHaveLength(MAX_STORED_BODY_CHARS);
  });

  it("strips NUL characters, which Postgres text cannot hold", () => {
    const raw = resendToRawEmail(
      content({ text: "a\u0000b", subject: "s\u0000t", headers: { from: "x\u0000@example.com" } }),
      eventData(),
    );
    expect(raw.body).toBe("ab");
    expect(raw.subject).toBe("st");
    // In an address header a control becomes a space, so it can never join two
    // halves into another mailbox (`jane\u0000@klorn.ai` is not jane@klorn.ai).
    expect(raw.from).toBe("x @example.com");
  });

  it("derives the snippet from the body, at most 200 characters", () => {
    const raw = resendToRawEmail(content({ text: `  ${"word ".repeat(100)}` }), eventData());
    expect(raw.snippet.length).toBeLessThanOrEqual(200);
    expect(raw.snippet.startsWith("word word")).toBe(true);
    expect(resendToRawEmail(content({ text: null, html: null }), eventData()).snippet).toBe("");
  });

  it("dates the row at Resend's receive time, not the sender's Date header", () => {
    const raw = resendToRawEmail(
      content({ headers: { date: "Mon, 1 Jan 1990 00:00:00 +0000" } }),
      eventData({ created_at: "2026-10-22T10:00:00.000Z" }),
    );
    expect(raw.receivedAt.toISOString()).toBe("2026-10-22T10:00:00.000Z");
  });

  it("parses List-Unsubscribe from the headers with the shared parser", () => {
    const raw = resendToRawEmail(
      content({
        headers: {
          "List-Unsubscribe": "<mailto:u@example.com>, <https://example.com/u?id=1>",
          "list-unsubscribe-post": "List-Unsubscribe=One-Click",
        },
      }),
      eventData(),
    );
    expect(raw.hasListUnsubscribe).toBe(true);
    expect(raw.listUnsubscribeMailto).toBe("mailto:u@example.com");
    expect(raw.listUnsubscribeUrl).toBe("https://example.com/u?id=1");
    expect(raw.listUnsubscribeOneClick).toBe(true);

    const none = resendToRawEmail(content({ headers: {} }), eventData());
    expect(none.hasListUnsubscribe).toBe(false);
    expect(none.listUnsubscribeUrl).toBeNull();
  });

  it("carries the whitelisted authentication verdicts", () => {
    const raw = resendToRawEmail(
      content({ authentication: { spf: "pass", dkim: "evil", dmarc: "FAIL" } }),
      eventData(),
    );
    expect(raw.authentication).toEqual({ spf: "pass", dkim: "unknown", dmarc: "fail" });
    expect(resendToRawEmail(content(), eventData()).authentication).toBeNull();
  });

  it("survives content fields of the wrong type", () => {
    const raw = resendToRawEmail(
      content({
        text: 5 as never,
        html: { x: 1 } as never,
        subject: null as never,
        headers: { from: ["a"] } as never,
        from: undefined as never,
        to: "jane@klorn.ai" as never,
      }),
      eventData(),
    );
    expect(raw.body).toBe("");
    expect(raw.subject).toBe("(no subject)");
    expect(raw.from).toBe("");
    expect(raw.to).toBe("");
  });
});

describe("resendToRawEmail: header encodings and hostile values", () => {
  it("decodes RFC 2047 encoded-words in From, To and Cc (a Korean sender name)", () => {
    const korean = Buffer.from("김철수", "utf8").toString("base64");
    const raw = resendToRawEmail(
      content({
        headers: {
          from: `=?UTF-8?B?${korean}?= <kim@example.com>`,
          to: "=?utf-8?Q?Jane_D=C3=B6e?= <jane@klorn.ai>",
          cc: "=?EUC-KR?B?x9Gx2w==?= <han@example.com>",
        },
      }),
      eventData(),
    );
    expect(raw.from).toBe("김철수 <kim@example.com>");
    expect(raw.to).toBe("Jane Döe <jane@klorn.ai>");
    expect(raw.cc).toBe("한글 <han@example.com>");
  });

  it("reads no List-Unsubscribe from a header over the ceiling", () => {
    const raw = resendToRawEmail(
      content({ headers: { "list-unsubscribe": `<https://example.com/u>${" ".repeat(300_000)}` } }),
      eventData(),
    );
    expect(raw.hasListUnsubscribe).toBe(false);
    expect(raw.listUnsubscribeUrl).toBeNull();
  });

  it("names the address headers over the ceiling, from the headers or the arrays", () => {
    expect(oversizedHeaders(content())).toEqual([]);
    expect(
      oversizedHeaders(
        content({
          headers: { from: "x".repeat(300_000), "list-unsubscribe": "y".repeat(300_000) },
          to: Array.from({ length: 100_000 }, () => "a@b.co"),
        }),
      ),
    ).toEqual(["from", "to", "list-unsubscribe"]);
  });

  it("strips NUL from the List-Unsubscribe targets", () => {
    const raw = resendToRawEmail(
      content({
        headers: {
          "list-unsubscribe": "<mailto:u\u0000@example.com>, <https://example.com/u\u0000?id=1>",
        },
      }),
      eventData(),
    );
    expect(raw.listUnsubscribeMailto).toBe("mailto:u@example.com");
    expect(raw.listUnsubscribeUrl).toBe("https://example.com/u?id=1");
  });

  it("keeps the text of an HTML-only message whose images are cid: references", () => {
    const raw = resendToRawEmail(
      content({
        text: null,
        html: `<p><img src="cid:ii_123" alt="">Quarterly numbers inside</p>`,
      }),
      eventData(),
    );
    expect(raw.body).toBe("Quarterly numbers inside");
    expect(raw.snippet).toBe("Quarterly numbers inside");
  });

  it("caps an over-long subject at the subject limit before any other work", () => {
    const raw = resendToRawEmail(
      content({ subject: `${"s".repeat(MAX_STORED_SUBJECT_LENGTH)}TAIL` }),
      eventData(),
    );
    expect(raw.subject).toHaveLength(MAX_STORED_SUBJECT_LENGTH);
    expect(raw.subject.endsWith("TAIL")).toBe(false);
  });
});

describe("indexHeaders: one bounded pass over the header keys", () => {
  function manyKeys(count: number, extra: Record<string, unknown> = {}) {
    const headers: Record<string, unknown> = {};
    for (let i = 0; i < count; i++) headers[`x-filler-${i}`] = "v";
    return Object.assign(headers, extra);
  }

  it("indexes the needed names case-insensitively, first string value winning", () => {
    const { values, examined } = indexHeaders({
      From: 5,
      FROM: "First <first@example.com>",
      from: "Second <second@example.com>",
      To: "to@example.com",
      "LIST-UNSUBSCRIBE": "<https://example.com/u>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      "X-Other": "ignored",
    });
    expect(values).toEqual({
      from: "First <first@example.com>",
      to: "to@example.com",
      "list-unsubscribe": "<https://example.com/u>",
      "list-unsubscribe-post": "List-Unsubscribe=One-Click",
    });
    expect(examined).toBe(7);
    expect(indexHeaders(null)).toEqual({ values: {}, examined: 0 });
    expect(indexHeaders("from: x")).toEqual({ values: {}, examined: 0 });
  });

  it(`examines at most ${MAX_HEADER_KEYS} keys of a 1M-key headers object`, () => {
    const headers = manyKeys(1_000_000, { from: "late@example.com" });
    const started = performance.now();
    const { values, examined } = indexHeaders(headers);
    expect(examined).toBe(MAX_HEADER_KEYS);
    // A needed header past the cap is not read: the content's own fields cover it.
    expect(values).toEqual({});
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it("maps a message with 1M header keys from the content's own fields, within a backstop", () => {
    const headers = manyKeys(1_000_000, {
      from: "Late <late@example.com>",
      to: "late@example.com",
    });
    const started = performance.now();
    const message = content({ headers, from: "sender@example.com", to: ["jane@klorn.ai"] });
    const oversized = oversizedHeaders(message);
    const raw = resendToRawEmail(message, eventData());
    expect(oversized).toEqual([]);
    expect(raw.from).toBe("sender@example.com");
    expect(raw.to).toBe("jane@klorn.ai");
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it("finds a needed header among ordinary ones, as before", () => {
    const headers = manyKeys(50, {
      "List-Unsubscribe": "<https://example.com/u>",
      From: "A <a@x.com>",
    });
    const raw = resendToRawEmail(content({ headers }), eventData());
    expect(raw.from).toBe("A <a@x.com>");
    expect(raw.listUnsubscribeUrl).toBe("https://example.com/u");
  });
});
