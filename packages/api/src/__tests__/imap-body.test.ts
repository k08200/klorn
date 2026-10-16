import { describe, expect, it } from "vitest";
import { decodeImapText, IMAP_DECODE_MAX_BYTES } from "../mail/imap-body.js";

// IMAP BODY[TEXT] arrives without the message's top-level headers, so a
// multipart or transfer-encoded body was stored as raw MIME (prod 2026-10-16:
// 50 of 50 iCloud rows). The poll now fetches Content-Type and
// Content-Transfer-Encoding alongside and decodes through a MIME parser.

const CRLF = "\r\n";

function headers(...lines: string[]): Buffer {
  return Buffer.from(lines.join(CRLF) + CRLF);
}

function b64(bytes: Buffer | string): string {
  return Buffer.from(bytes).toString("base64");
}

describe("decodeImapText", () => {
  it("decodes the text part of a multipart message with a base64 UTF-8 body", async () => {
    const text = [
      "--b1",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      b64("회의는 내일 3시입니다."),
      "--b1",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>회의는 내일 3시입니다.</p>",
      "--b1--",
      "",
    ].join(CRLF);

    const decoded = await decodeImapText(
      headers('Content-Type: multipart/alternative; boundary="b1"'),
      Buffer.from(text),
    );

    expect(decoded).toBe("회의는 내일 3시입니다.");
    expect(decoded).not.toContain("--b1");
  });

  it("decodes an EUC-KR body (Naver)", async () => {
    const eucKr = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb, 0x20, 0xb8, 0xde, 0xc0, 0xcf]); // "한글 메일"
    const decoded = await decodeImapText(
      headers("Content-Type: text/plain; charset=euc-kr", "Content-Transfer-Encoding: base64"),
      Buffer.from(b64(eucKr)),
    );

    expect(decoded).toBe("한글 메일");
  });

  it("decodes a quoted-printable single-part body", async () => {
    const decoded = await decodeImapText(
      headers(
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: quoted-printable",
      ),
      Buffer.from("caf=C3=A9 au lait, soft=\r\nbreak"),
    );

    expect(decoded).toBe("café au lait, softbreak");
  });

  it("falls back to the HTML part's text when there is no plain part", async () => {
    const decoded = await decodeImapText(
      headers("Content-Type: text/html; charset=utf-8"),
      Buffer.from("<html><body><p>Invoice <b>#42</b> is due</p><script>x()</script></body></html>"),
    );

    expect(decoded).toContain("Invoice #42 is due");
    expect(decoded).not.toContain("<");
    expect(decoded).not.toContain("x()");
  });

  it("keeps today's behaviour when the headers were not fetched", async () => {
    expect(await decodeImapText(undefined, Buffer.from("Hello   world"))).toBe("Hello   world");
    expect(await decodeImapText(undefined, undefined)).toBe("");
  });

  it("never throws on a malformed body and keeps the raw text", async () => {
    const decoded = await decodeImapText(
      headers('Content-Type: multipart/mixed; boundary="never-closed"'),
      Buffer.from("--never-closed\r\nContent-Type: text/plain\r\n\r\nplain words"),
    );

    expect(typeof decoded).toBe("string");
    expect(decoded).toContain("plain words");
  });

  it("never returns a NUL when a base64 part is cut mid-group (Postgres rejects NUL in text)", async () => {
    const encoded = b64("The quick brown fox jumps over the lazy dog. The end.");
    for (let cut = encoded.length - 3; cut < encoded.length; cut++) {
      const decoded = await decodeImapText(
        headers("Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64"),
        Buffer.from(encoded.slice(0, cut)),
      );
      expect(decoded).not.toContain("\u0000");
      expect(decoded.startsWith("The quick brown fox")).toBe(true);
    }
  });

  it("returns no body for a message that has only attachments, not their base64", async () => {
    const text = [
      "--b3",
      "Content-Type: application/pdf; name=a.pdf",
      "Content-Disposition: attachment; filename=a.pdf",
      "Content-Transfer-Encoding: base64",
      "",
      b64("%PDF-1.4 fake"),
      "--b3--",
      "",
    ].join(CRLF);

    const decoded = await decodeImapText(
      headers('Content-Type: multipart/mixed; boundary="b3"'),
      Buffer.from(text),
    );

    expect(decoded).toBe("");
  });

  it("reads a folded Content-Type and an empty header block", async () => {
    const folded = await decodeImapText(
      Buffer.from(
        'Content-Type: text/plain;\r\n charset="utf-8"\r\nContent-Transfer-Encoding: base64\r\n',
      ),
      Buffer.from(b64("접힌 헤더")),
    );
    expect(folded).toBe("접힌 헤더");

    // No Content-Type at all (NIL fields): RFC 2045 default, text/plain.
    const bare = await decodeImapText(Buffer.from("\r\n"), Buffer.from("plain body"));
    expect(bare).toBe("plain body");
  });

  it("strips NUL from the raw fallback too", async () => {
    expect(await decodeImapText(undefined, Buffer.from("a\u0000b"))).toBe("ab");
  });

  it("parses at most IMAP_DECODE_MAX_BYTES, so a large attachment after the text is skipped", async () => {
    const big = "A".repeat(IMAP_DECODE_MAX_BYTES * 3);
    const text = [
      "--b2",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "see attached",
      "--b2",
      "Content-Type: application/pdf",
      "Content-Transfer-Encoding: base64",
      "",
      big,
      "--b2--",
    ].join(CRLF);

    const decoded = await decodeImapText(
      headers('Content-Type: multipart/mixed; boundary="b2"'),
      Buffer.from(text),
    );

    expect(decoded).toBe("see attached");
  });

  describe("hostile input stays within budget (single event loop)", () => {
    const BUDGET_MS = 500;
    const timed = (fn: () => unknown) => {
      const start = performance.now();
      fn();
      return performance.now() - start;
    };

    it("a '<' flood in the HTML alternative", () => {
      const text = [
        "--b",
        "Content-Type: text/plain",
        "",
        "hi",
        "--b",
        "Content-Type: text/html",
        "",
        "<".repeat(IMAP_DECODE_MAX_BYTES),
        "--b--",
      ].join(CRLF);
      const head = headers('Content-Type: multipart/mixed; boundary="b"');
      expect(timed(() => expect(decodeImapText(head, Buffer.from(text))).toBe("hi"))).toBeLessThan(
        BUDGET_MS,
      );
    });

    it("an HTML-only '<' flood and deep tag nesting", () => {
      for (const html of ["<".repeat(IMAP_DECODE_MAX_BYTES), "<div>".repeat(50_000)]) {
        const ms = timed(() =>
          decodeImapText(headers("Content-Type: text/html"), Buffer.from(html)),
        );
        expect(ms).toBeLessThan(BUDGET_MS);
      }
    });

    it("thousands of tiny parts", () => {
      const part = `--p${CRLF}Content-Type: text/plain${CRLF}${CRLF}${CRLF}`;
      const text = part.repeat(Math.floor(IMAP_DECODE_MAX_BYTES / part.length));
      const head = headers('Content-Type: multipart/mixed; boundary="p"');
      expect(timed(() => decodeImapText(head, Buffer.from(text)))).toBeLessThan(BUDGET_MS);
    });

    it("nested message/rfc822 and deeply nested multiparts", () => {
      const rfc822 = `Content-Type: message/rfc822${CRLF}${CRLF}`.repeat(5000);
      let nested = "deep text";
      for (let depth = 0; depth < 2000; depth++) {
        nested = `--n${depth}${CRLF}Content-Type: multipart/mixed; boundary="n${depth + 1}"${CRLF}${CRLF}${nested}`;
      }
      for (const [type, body] of [
        ["message/rfc822", rfc822],
        ['multipart/mixed; boundary="n0"', nested],
      ]) {
        const ms = timed(() => decodeImapText(headers(`Content-Type: ${type}`), Buffer.from(body)));
        expect(ms).toBeLessThan(BUDGET_MS);
      }
    });

    it("a huge folded header and an oversized boundary", () => {
      const folded = Buffer.from(
        `Content-Type: text/plain;${`\r\n x=${"y".repeat(60)}`.repeat(40_000)}\r\n`,
      );
      expect(timed(() => decodeImapText(folded, Buffer.from("body")))).toBeLessThan(BUDGET_MS);

      const boundary = "a".repeat(8000);
      const head = headers(`Content-Type: multipart/mixed; boundary="${boundary}"`);
      const body = Buffer.from("a".repeat(IMAP_DECODE_MAX_BYTES));
      expect(timed(() => expect(decodeImapText(head, body)).toBe(""))).toBeLessThan(BUDGET_MS);
    });
  });
});
