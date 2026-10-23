/**
 * The pure halves of the Klorn mailbox's inbound webhook (step E1b of
 * docs/providers/unified-platform-plan.md): which recipients of a signed
 * `email.received` event are Klorn addresses, and how Resend's parsed content
 * becomes the row the shared store writes. No network, no database.
 */

import { describe, expect, it } from "vitest";
import { MAX_STORED_CC_LENGTH, MAX_STORED_SUBJECT_LENGTH } from "../mail/imap-envelope.js";
import {
  klornMessageId,
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

  it("drops plus tags, malformed handles and reserved names, and counts each once", () => {
    const result = inboundRecipients(
      eventData({
        to: ["jane+news@klorn.ai", "a..b@klorn.ai", "support@klorn.ai", "post.master@klorn.ai"],
        cc: ["SUPPORT@klorn.ai"],
      }),
      DOMAIN,
    );
    expect(result.handles).toEqual([]);
    expect(result.system).toEqual([]);
    expect(result.dropped).toBe(4);
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
  it("names the row klorn:<address>:<email_id>, per recipient", () => {
    expect(klornMessageId(ADDRESS, EMAIL_ID)).toBe(`klorn:${ADDRESS}:${EMAIL_ID}`);
    const raw = resendToRawEmail(content(), eventData(), ADDRESS);
    expect(raw.gmailId).toBe(`klorn:${ADDRESS}:${EMAIL_ID}`);
    expect(resendToRawEmail(content(), eventData(), "sam@klorn.ai").gmailId).toBe(
      `klorn:sam@klorn.ai:${EMAIL_ID}`,
    );
  });

  it("maps the fixed fields like IMAP: inbox, unread, no thread, no attachments, no HTML", () => {
    const raw = resendToRawEmail(content(), eventData(), ADDRESS);
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
    expect(resendToRawEmail(content(), eventData(), ADDRESS).from).toBe(
      "Sam Sender <sender@example.com>",
    );
    expect(resendToRawEmail(content({ headers: null }), eventData(), ADDRESS).from).toBe(
      "sender@example.com",
    );
    // Header names are case-insensitive.
    expect(
      resendToRawEmail(
        content({ headers: { From: "Sam <sender@example.com>" } }),
        eventData(),
        ADDRESS,
      ).from,
    ).toBe("Sam <sender@example.com>");
  });

  it("takes To and Cc from the headers, else the joined arrays, capped like IMAP", () => {
    const fromHeaders = resendToRawEmail(
      content({ headers: { to: "Jane <jane@klorn.ai>", cc: "a@example.com, b@example.com" } }),
      eventData(),
      ADDRESS,
    );
    expect(fromHeaders.to).toBe("Jane <jane@klorn.ai>");
    expect(fromHeaders.cc).toBe("a@example.com, b@example.com");

    const fromArrays = resendToRawEmail(
      content({ headers: {}, to: ["jane@klorn.ai", "sam@klorn.ai"], cc: ["c@example.com"] }),
      eventData(),
      ADDRESS,
    );
    expect(fromArrays.to).toBe("jane@klorn.ai, sam@klorn.ai");
    expect(fromArrays.cc).toBe("c@example.com");
    expect(resendToRawEmail(content({ headers: {}, cc: null }), eventData(), ADDRESS).cc).toBe("");

    const long = "x".repeat(MAX_STORED_CC_LENGTH + 100);
    const capped = resendToRawEmail(
      content({ headers: { to: long, cc: long } }),
      eventData(),
      ADDRESS,
    );
    expect(capped.to).toHaveLength(MAX_STORED_CC_LENGTH);
    expect(capped.cc).toHaveLength(MAX_STORED_CC_LENGTH);
  });

  it("caps the subject and stores a placeholder for an empty one", () => {
    expect(
      resendToRawEmail(
        content({ subject: "y".repeat(MAX_STORED_SUBJECT_LENGTH + 5) }),
        eventData(),
        ADDRESS,
      ).subject,
    ).toHaveLength(MAX_STORED_SUBJECT_LENGTH);
    expect(resendToRawEmail(content({ subject: "   " }), eventData(), ADDRESS).subject).toBe(
      "(no subject)",
    );
  });

  it("uses text for the body, else the HTML as plain text, capped at IMAP's limit", () => {
    expect(resendToRawEmail(content(), eventData(), ADDRESS).body).toBe(
      "Hello Jane, the numbers are attached.",
    );
    const htmlOnly = resendToRawEmail(content({ text: null }), eventData(), ADDRESS);
    expect(htmlOnly.body).toBe("Hello Jane");
    expect(htmlOnly.htmlBody).toBe("");
    expect(resendToRawEmail(content({ text: null, html: null }), eventData(), ADDRESS).body).toBe(
      "",
    );

    const huge = resendToRawEmail(
      content({ text: "z".repeat(MAX_STORED_BODY_CHARS + 1_000) }),
      eventData(),
      ADDRESS,
    );
    expect(huge.body).toHaveLength(MAX_STORED_BODY_CHARS);
  });

  it("strips NUL characters, which Postgres text cannot hold", () => {
    const raw = resendToRawEmail(
      content({ text: "a\u0000b", subject: "s\u0000t", headers: { from: "x\u0000@example.com" } }),
      eventData(),
      ADDRESS,
    );
    expect(raw.body).toBe("ab");
    expect(raw.subject).toBe("st");
    expect(raw.from).toBe("x@example.com");
  });

  it("derives the snippet from the body, at most 200 characters", () => {
    const raw = resendToRawEmail(
      content({ text: `  ${"word ".repeat(100)}` }),
      eventData(),
      ADDRESS,
    );
    expect(raw.snippet.length).toBeLessThanOrEqual(200);
    expect(raw.snippet.startsWith("word word")).toBe(true);
    expect(
      resendToRawEmail(content({ text: null, html: null }), eventData(), ADDRESS).snippet,
    ).toBe("");
  });

  it("dates the row at Resend's receive time, not the sender's Date header", () => {
    const raw = resendToRawEmail(
      content({ headers: { date: "Mon, 1 Jan 1990 00:00:00 +0000" } }),
      eventData({ created_at: "2026-10-22T10:00:00.000Z" }),
      ADDRESS,
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
      ADDRESS,
    );
    expect(raw.hasListUnsubscribe).toBe(true);
    expect(raw.listUnsubscribeMailto).toBe("mailto:u@example.com");
    expect(raw.listUnsubscribeUrl).toBe("https://example.com/u?id=1");
    expect(raw.listUnsubscribeOneClick).toBe(true);

    const none = resendToRawEmail(content({ headers: {} }), eventData(), ADDRESS);
    expect(none.hasListUnsubscribe).toBe(false);
    expect(none.listUnsubscribeUrl).toBeNull();
  });

  it("carries the whitelisted authentication verdicts", () => {
    const raw = resendToRawEmail(
      content({ authentication: { spf: "pass", dkim: "evil", dmarc: "FAIL" } }),
      eventData(),
      ADDRESS,
    );
    expect(raw.authentication).toEqual({ spf: "pass", dkim: "unknown", dmarc: "fail" });
    expect(resendToRawEmail(content(), eventData(), ADDRESS).authentication).toBeNull();
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
      ADDRESS,
    );
    expect(raw.body).toBe("");
    expect(raw.subject).toBe("(no subject)");
    expect(raw.from).toBe("");
    expect(raw.to).toBe("");
  });
});
