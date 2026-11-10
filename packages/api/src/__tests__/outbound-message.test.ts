/**
 * Step B3: the MIME builder and the recipient guard are shared by the Gmail
 * path (base64url `raw` for the Gmail API) and the IMAP path (bytes for SMTP and
 * for an IMAP APPEND). They live in `mail/outbound-message.ts`.
 *
 * Pinned here:
 *   - without the standalone headers the output is byte-for-byte what
 *     `mail/gmail.ts` produced before B3, for 1440 input combinations. The
 *     expected values are not hand-written: fixtures/gmail-mime-main.json holds
 *     the sha256 of what main's builder (commit 1c7c767c) returned for each one;
 *   - a standalone message (SMTP / APPEND) additionally carries From, Date and
 *     Message-ID in a fixed order, a base64 body (no 8BITMIME needed), and folds
 *     Subject and long attachment names so no encoded-word exceeds 75 characters
 *     and no line exceeds 998 octets;
 *   - reply headers go through `reply-headers.ts` on both flavours;
 *   - the recipient guard answers exactly as Gmail's `sendEmail` did, and
 *     `toSmtpAddress` refuses anything that is not a plain, bounded addr-spec.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  buildPlainTextMime,
  buildPlainTextRawEmail,
  checkSendRecipient,
  extractAddress,
  isNoReplyAddress,
  looksLikeEmailAddress,
  newMessageId,
  toSmtpAddress,
} from "../mail/outbound-message.js";

const CRLF = "\r\n";
const SUBJECT = "Re: Q3 plan";
const SUBJECT_B64 = Buffer.from(SUBJECT).toString("base64");
const DATE = new Date("2026-09-30T10:00:00.000Z");
const ORIGINAL = "<orig-1@mail.example.com>";

const decodeRaw = (raw: string) => Buffer.from(raw, "base64url").toString("utf-8");

interface FixtureAttachment {
  filename: string;
  mimeType: string;
  contentBase64: string;
}
interface MainFixture {
  dimensions: {
    to: string[];
    subject: string[];
    body: string[];
    attachments: FixtureAttachment[][];
    threading: unknown[];
  };
  hashes: string[];
  samples: Array<{ index: number; expectedRaw: string }>;
}
const fixture: MainFixture = JSON.parse(
  readFileSync(new URL("./fixtures/gmail-mime-main.json", import.meta.url), "utf-8"),
);

/** Every combination, in the order the fixture was generated from main's builder. */
function* combinations() {
  let index = 0;
  const d = fixture.dimensions;
  for (const to of d.to)
    for (const subject of d.subject)
      for (const body of d.body)
        for (const attachmentSet of d.attachments)
          for (const threading of d.threading) {
            const attachments = attachmentSet.map((a) => ({
              filename: a.filename,
              mimeType: a.mimeType,
              content: Buffer.from(a.contentBase64, "base64"),
            }));
            yield { index: index++, to, subject, body, attachments, threading };
          }
}

function withPinnedBoundary<T>(run: () => T): T {
  const now = vi.spyOn(Date, "now").mockReturnValue(0);
  const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
  try {
    return run();
  } finally {
    now.mockRestore();
    random.mockRestore();
  }
}

describe("buildPlainTextRawEmail — Gmail output is byte-identical to main", () => {
  it("has a fixture with every combination it claims", () => {
    const d = fixture.dimensions;
    expect(fixture.hashes).toHaveLength(
      d.to.length * d.subject.length * d.body.length * d.attachments.length * d.threading.length,
    );
    expect(fixture.hashes.length).toBe(1440);
  });

  it("matches main's sha256 for every combination (plain and multipart, threaded or not)", () => {
    const mismatches = withPinnedBoundary(() => {
      const bad: number[] = [];
      for (const c of combinations()) {
        const raw = buildPlainTextRawEmail(
          c.to,
          c.subject,
          c.body,
          c.attachments,
          (c.threading ?? undefined) as never,
        );
        if (createHash("sha256").update(raw).digest("hex") !== fixture.hashes[c.index]) {
          bad.push(c.index);
        }
      }
      return bad;
    });
    expect(mismatches).toEqual([]);
  });

  it("reproduces the readable samples exactly", () => {
    const wanted = new Map(fixture.samples.map((sample) => [sample.index, sample.expectedRaw]));
    const got = withPinnedBoundary(() => {
      const out = new Map<number, string>();
      for (const c of combinations()) {
        if (!wanted.has(c.index)) continue;
        out.set(
          c.index,
          buildPlainTextRawEmail(
            c.to,
            c.subject,
            c.body,
            c.attachments,
            (c.threading ?? undefined) as never,
          ),
        );
      }
      return out;
    });
    expect(wanted.size).toBeGreaterThan(0);
    for (const [index, expectedRaw] of wanted) expect(got.get(index)).toBe(expectedRaw);
  });

  it("returns the same bytes as buildPlainTextMime, base64url-encoded", () => {
    const mime = buildPlainTextMime("bob@example.com", SUBJECT, "Sounds good.", [], {
      inReplyTo: ORIGINAL,
    });
    const raw = buildPlainTextRawEmail("bob@example.com", SUBJECT, "Sounds good.", [], {
      inReplyTo: ORIGINAL,
    });
    expect(decodeRaw(raw)).toBe(mime);
  });

  it("keeps the Gmail Subject a single unfolded encoded word, however long", () => {
    const subject = "x".repeat(300);
    const head = decodeRaw(buildPlainTextRawEmail("bob@example.com", subject, "b")).split(
      `${CRLF}${CRLF}`,
    )[0];
    expect(head.split(CRLF)[1]).toBe(
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    );
  });
});

describe("buildPlainTextMime — standalone message (SMTP / APPEND)", () => {
  const standalone = {
    from: "me@naver.com",
    messageId: "<0b7e3c1a-1111-4222-8333-444455556666@naver.com>",
    date: DATE,
  };

  it("emits From, To, Subject, Date, Message-ID in that order, then MIME headers", () => {
    const mime = buildPlainTextMime("bob@example.com", SUBJECT, "Sounds good.", [], undefined, {
      ...standalone,
    });
    const [head] = mime.split(`${CRLF}${CRLF}`);
    expect(head.split(CRLF)).toEqual([
      "From: me@naver.com",
      "To: bob@example.com",
      `Subject: =?UTF-8?B?${SUBJECT_B64}?=`,
      "Date: Wed, 30 Sep 2026 10:00:00 +0000",
      `Message-ID: ${standalone.messageId}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
    ]);
  });

  it("encodes the body as base64 with CRLF line breaks, so the bytes are 7-bit clean", () => {
    const body = "안녕하세요\n두 번째 줄 \u{1F600}";
    const mime = buildPlainTextMime("bob@example.com", SUBJECT, body, [], undefined, standalone);
    const encoded = mime.split(`${CRLF}${CRLF}`)[1];
    expect(Buffer.from(encoded.replace(/\r\n/g, ""), "base64").toString("utf-8")).toBe(
      "안녕하세요\r\n두 번째 줄 \u{1F600}",
    );
    expect(Array.from(mime).every((ch) => ch.charCodeAt(0) < 0x80)).toBe(true);
    for (const line of mime.split(CRLF)) expect(line.length).toBeLessThanOrEqual(998);
  });

  it("folds the base64 body at 76 characters per line", () => {
    const mime = buildPlainTextMime("b@example.com", SUBJECT, "x".repeat(500), [], undefined, {
      ...standalone,
    });
    const bodyLines = mime.split(`${CRLF}${CRLF}`)[1].split(CRLF);
    expect(bodyLines.length).toBeGreaterThan(1);
    for (const line of bodyLines) expect(line.length).toBeLessThanOrEqual(76);
  });

  it("puts In-Reply-To and References (parsed ids only) after Message-ID", () => {
    const mime = buildPlainTextMime(
      "bob@example.com",
      SUBJECT,
      "hi",
      [],
      { inReplyTo: `junk ${ORIGINAL}`, references: "<root@x.example> <mid@x.example>" },
      standalone,
    );
    const head = mime.split(`${CRLF}${CRLF}`)[0].split(CRLF);
    const at = head.indexOf(`Message-ID: ${standalone.messageId}`);
    expect(head.slice(at + 1, at + 3)).toEqual([
      `In-Reply-To: ${ORIGINAL}`,
      "References: <root@x.example> <mid@x.example>",
    ]);
  });

  it("keeps a multipart message standalone: headers first, base64 text part, attachment", () => {
    const mime = buildPlainTextMime(
      "bob@example.com",
      SUBJECT,
      "Body",
      [{ filename: "a.txt", mimeType: "text/plain", content: Buffer.from("hello") }],
      undefined,
      standalone,
    );
    expect(mime.startsWith(`From: me@naver.com${CRLF}To: bob@example.com${CRLF}`)).toBe(true);
    expect(mime).toContain("Date: Wed, 30 Sep 2026 10:00:00 +0000");
    expect(mime).toContain(`Message-ID: ${standalone.messageId}`);
    expect(mime).toContain("Content-Type: multipart/mixed; boundary=");
    expect(mime).toContain(`Content-Transfer-Encoding: base64${CRLF}${CRLF}Qm9keQ==`);
    expect(mime).toContain(Buffer.from("hello").toString("base64"));
  });

  it("never lets CR or LF from a field start a new header line", () => {
    const mime = buildPlainTextMime(
      "bob@example.com\r\nBcc: evil@example.com",
      "Hi\r\nBcc: evil@example.com",
      "body",
      [],
      undefined,
      { ...standalone, from: "me@naver.com\r\nBcc: evil@example.com" },
    );
    const headerLines = mime.split(`${CRLF}${CRLF}`)[0].split(CRLF);
    expect(headerLines.some((line) => line.startsWith("Bcc:"))).toBe(false);
  });
});

describe("buildPlainTextMime — standalone folding", () => {
  const standalone = {
    from: "me@naver.com",
    messageId: "<0b7e3c1a-1111-4222-8333-444455556666@naver.com>",
    date: DATE,
  };
  const unfold = (head: string) => head.replace(/\r\n[ \t]+/g, " ");
  const headOf = (mime: string) => mime.split(`${CRLF}${CRLF}`)[0];
  const words = (value: string) =>
    [...value.matchAll(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=/g)].map((m) => ({
      whole: m[0],
      text: Buffer.from(m[1], "base64").toString("utf-8"),
    }));

  it("keeps a short subject as one encoded word on the Subject line", () => {
    const head = headOf(
      buildPlainTextMime("b@example.com", SUBJECT, "b", [], undefined, standalone),
    );
    expect(head.split(CRLF).find((line) => line.startsWith("Subject:"))).toBe(
      `Subject: =?UTF-8?B?${SUBJECT_B64}?=`,
    );
  });

  it("splits a long subject into encoded words of at most 75 characters", () => {
    const subject = "긴 제목 with English words and \u{1F600} emoji ".repeat(12);
    const head = headOf(
      buildPlainTextMime("b@example.com", subject, "b", [], undefined, standalone),
    );
    const value =
      unfold(head)
        .split(CRLF)
        .find((line) => line.startsWith("Subject:")) ?? "";
    const found = words(value);
    expect(found.length).toBeGreaterThan(3);
    for (const word of found) expect(word.whole.length).toBeLessThanOrEqual(75);
    expect(found.map((word) => word.text).join("")).toBe(subject.trim());
  });

  it("never splits a multibyte character across encoded words", () => {
    const subject = "\u{1F600}".repeat(120) + "가".repeat(80);
    const head = headOf(
      buildPlainTextMime("b@example.com", subject, "b", [], undefined, standalone),
    );
    for (const word of words(unfold(head))) expect(word.text).not.toContain("\uFFFD");
    const joined = words(unfold(head))
      .map((word) => word.text)
      .join("");
    expect(joined).toBe(subject);
  });

  it("keeps every physical header line within 78 characters for a long subject", () => {
    const subject = "긴 제목 ".repeat(200);
    const head = headOf(
      buildPlainTextMime("b@example.com", subject, "b", [], undefined, standalone),
    );
    for (const line of head.split(CRLF)) expect(line.length).toBeLessThanOrEqual(78);
  });

  it("does not let a CRLF in the subject start another header", () => {
    const head = headOf(
      buildPlainTextMime(
        "b@example.com",
        "Hi\r\nBcc: evil@example.com",
        "b",
        [],
        undefined,
        standalone,
      ),
    );
    expect(head.split(CRLF).some((line) => /^bcc:/i.test(line))).toBe(false);
  });

  it("folds a long attachment name into RFC 2231 continuations that reassemble to the name", () => {
    const filename = "보고서 (최종) 'v2' *draft* 2026 ".repeat(8).trim() + ".pdf";
    const mime = buildPlainTextMime(
      "b@example.com",
      "s",
      "b",
      [{ filename, mimeType: "application/pdf", content: Buffer.from("x") }],
      undefined,
      standalone,
    );
    const disposition = unfold(mime).match(/Content-Disposition: ([^\r]*)/)?.[1] ?? "";
    const parts = [...disposition.matchAll(/filename\*(\d+)\*=([^;]*)/g)].sort(
      (a, b) => Number(a[1]) - Number(b[1]),
    );
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0][2].startsWith("UTF-8''")).toBe(true);
    const encoded = parts
      .map((part, i) => (i === 0 ? part[2].slice("UTF-8''".length) : part[2]))
      .join("");
    expect(decodeURIComponent(encoded)).toBe(filename);
    // no reserved character is left bare in a parameter value
    expect(encoded).not.toMatch(/['()*;" ]/);
  });

  it("keeps every header line of a message with an extreme attachment under 998 octets", () => {
    const filename = "가".repeat(255);
    const mime = buildPlainTextMime(
      "b@example.com",
      "긴".repeat(2000),
      "b",
      [
        {
          filename,
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          content: Buffer.from("x"),
        },
      ],
      undefined,
      standalone,
    );
    const headerLines = mime.split(CRLF).filter((line) => !/^[A-Za-z0-9+/=]+$/.test(line));
    for (const line of headerLines) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(998);
  });

  it("caps the ASCII fallback name and keeps its extension", () => {
    const mime = buildPlainTextMime(
      "b@example.com",
      "s",
      "b",
      [
        {
          filename: `${"a".repeat(200)}.pdf`,
          mimeType: "application/pdf",
          content: Buffer.from("x"),
        },
      ],
      undefined,
      standalone,
    );
    const name = mime.match(/ name="([^"]*)"/)?.[1] ?? "";
    expect(name.length).toBeLessThanOrEqual(40);
    expect(name.endsWith(".pdf")).toBe(true);
  });

  it("leaves a short attachment name on the same lines the Gmail flavour uses", () => {
    const mime = buildPlainTextMime(
      "b@example.com",
      "s",
      "b",
      [{ filename: "a.txt", mimeType: "text/plain", content: Buffer.from("x") }],
      undefined,
      standalone,
    );
    expect(unfold(mime)).toContain(
      `Content-Disposition: attachment; filename="a.txt"; filename*=UTF-8''a.txt`,
    );
  });
});

describe("newMessageId", () => {
  it("is a valid <unique@domain> id on the sender's domain", () => {
    const id = newMessageId("me@naver.com");
    expect(id).toMatch(/^<[0-9a-f-]{36}@naver\.com>$/);
    expect(newMessageId("me@naver.com")).not.toBe(id);
  });

  it("falls back to a fixed local domain when the address has no usable domain", () => {
    expect(newMessageId("not-an-address")).toMatch(/^<[0-9a-f-]{36}@klorn\.local>$/);
    expect(newMessageId("me@ex ample<>.com")).toMatch(/^<[0-9a-f-]{36}@example\.com>$/);
  });
});

describe("checkSendRecipient — the Gmail sendEmail guard, shared", () => {
  it.each([
    [
      "a@x.com, b@y.com",
      "Send to one recipient at a time (no commas or semicolons in the address).",
    ],
    [
      "a@x.com; b@y.com",
      "Send to one recipient at a time (no commas or semicolons in the address).",
    ],
    [
      "accounts.google.com",
      'Invalid email address: "accounts.google.com". Use a full address like local@domain, not a domain such as accounts.google.com.',
    ],
    [
      "noreply@example.com",
      "This address (noreply@example.com) is a no-reply system sender, so Klorn will not send a reply.",
    ],
  ])("refuses %s with the Gmail wording", (to, message) => {
    expect(checkSendRecipient(to)).toBe(message);
  });

  it("accepts a plain address and a display-name form", () => {
    expect(checkSendRecipient("bob@example.com")).toBeNull();
    expect(checkSendRecipient("Bob <bob@example.com>")).toBeNull();
  });

  it("exposes the primitives the Gmail module re-exports", () => {
    expect(extractAddress(" Bob <bob@example.com> ")).toBe("bob@example.com");
    expect(looksLikeEmailAddress("bob@example.com")).toBe(true);
    expect(looksLikeEmailAddress("bob")).toBe(false);
    expect(isNoReplyAddress("do-not-reply@example.com")).toBe(true);
    expect(isNoReplyAddress("bob@example.com")).toBe(false);
  });
});

describe("toSmtpAddress — only a plain, bounded addr-spec reaches an SMTP command", () => {
  it.each([
    ["bob@example.com", "bob@example.com"],
    ["Bob Builder <bob.b+tag@mail.example.co.kr>", "bob.b+tag@mail.example.co.kr"],
    ["  bob@example.com  ", "bob@example.com"],
  ])("accepts %s", (input, expected) => {
    expect(toSmtpAddress(input)).toBe(expected);
  });

  it.each([
    "bob@example.com>",
    "bob@example.com(comment)evil.com",
    "Name <bob@example.com(x)evil.com>",
    "bob@exa mple.com",
    "bob\r\n@example.com",
    "bob@example.com\r\nRCPT TO:<evil@example.com>",
    '"bob smith"@example.com',
    "bob@@example.com",
    "@example.com",
    "bob@",
    "bob@localhost",
    "bob@-example.com",
    "bob@example..com",
    ".bob@example.com",
    "bob.@example.com",
    "bob..b@example.com",
    "bob@[127.0.0.1]",
    "bob@127.0.0.1",
    "bób@example.com",
    "bob@exämple.com",
    `${"a".repeat(65)}@example.com`,
    `bob@${"a".repeat(64)}.com`,
    `bob@${"a.".repeat(130)}com`,
    "",
  ])("refuses %j", (input) => {
    expect(toSmtpAddress(input)).toBeNull();
  });
});
