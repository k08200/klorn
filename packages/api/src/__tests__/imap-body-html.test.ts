import { describe, expect, it } from "vitest";
import { decodeImapBody, decodeImapText, IMAP_DECODE_MAX_BYTES } from "../mail/imap-body.js";
import { fastestCpuMs } from "./helpers/linear-timing.js";

// iCloud mail showed no HTML: the IMAP decoder returned at the first text/plain
// part and dropped its text/html sibling, and the poll stored `htmlBody: ""`.
// decodeImapBody returns both, from the same bounded walk.

const CRLF = "\r\n";

function headers(...lines: string[]): Buffer {
  return Buffer.from(lines.join(CRLF) + CRLF);
}

function b64(value: string): string {
  return Buffer.from(value).toString("base64");
}

const ALTERNATIVE = [
  "--alt",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: base64",
  "",
  b64("회의는 내일 3시입니다."),
  "--alt",
  "Content-Type: text/html; charset=utf-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "<p>=ED=9A=8C=EC=9D=98=EB=8A=94 <b>=EB=82=B4=EC=9D=BC</b></p>",
  "--alt--",
  "",
].join(CRLF);

describe("decodeImapBody", () => {
  it("returns the HTML sibling of a multipart/alternative text part", () => {
    const decoded = decodeImapBody(
      headers('Content-Type: multipart/alternative; boundary="alt"'),
      Buffer.from(ALTERNATIVE),
    );

    expect(decoded.text).toBe("회의는 내일 3시입니다.");
    expect(decoded.html).toBe("<p>회의는 <b>내일</b></p>");
  });

  it("finds the HTML inside multipart/related next to inline images", () => {
    const related = [
      "--rel",
      'Content-Type: multipart/alternative; boundary="alt"',
      "",
      ALTERNATIVE,
      "--rel",
      "Content-Type: image/png",
      "Content-Transfer-Encoding: base64",
      "Content-ID: <logo@x>",
      "",
      b64("png-bytes"),
      "--rel--",
      "",
    ].join(CRLF);
    const mixed = [
      "--mix",
      'Content-Type: multipart/related; boundary="rel"',
      "",
      related,
      "--mix",
      'Content-Type: application/pdf; name="a.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      b64("%PDF-1.4"),
      "--mix--",
      "",
    ].join(CRLF);

    const decoded = decodeImapBody(
      headers('Content-Type: multipart/mixed; boundary="mix"'),
      Buffer.from(mixed),
    );

    expect(decoded.text).toBe("회의는 내일 3시입니다.");
    expect(decoded.html).toBe("<p>회의는 <b>내일</b></p>");
  });

  it("returns the HTML of an HTML-only single-part message, text projected from it", () => {
    const decoded = decodeImapBody(
      headers("Content-Type: text/html; charset=utf-8"),
      Buffer.from("<div>Hello <i>there</i></div>"),
    );

    expect(decoded.html).toBe("<div>Hello <i>there</i></div>");
    expect(decoded.text).toBe("Hello there");
  });

  it("never takes the HTML of an attached message/rfc822", () => {
    const mixed = [
      "--mix",
      "Content-Type: text/plain",
      "",
      "outer text",
      "--mix",
      "Content-Type: message/rfc822",
      "",
      "Content-Type: text/html",
      "",
      "<p>inner</p>",
      "--mix--",
      "",
    ].join(CRLF);

    const decoded = decodeImapBody(
      headers('Content-Type: multipart/mixed; boundary="mix"'),
      Buffer.from(mixed),
    );

    expect(decoded).toEqual({ text: "outer text", html: "" });
  });

  it("has no HTML for plain mail, raw fallback or empty input", () => {
    expect(decodeImapBody(headers("Content-Type: text/plain"), Buffer.from("hi")).html).toBe("");
    expect(decodeImapBody(undefined, Buffer.from("raw")).html).toBe("");
    expect(decodeImapBody(headers("Content-Type: text/html"), undefined)).toEqual({
      text: "",
      html: "",
    });
  });

  it("does not store HTML the size cap cut, but still reads its text", () => {
    const html = `<p>${"word ".repeat(IMAP_DECODE_MAX_BYTES / 4)}</p>`;
    const head = headers("Content-Type: text/html");

    const decoded = decodeImapBody(head, Buffer.from(html));

    expect(decoded.html).toBe("");
    expect(decoded.text.startsWith("word word")).toBe(true);
    // A user-chosen host's slice is cut wherever it ends.
    expect(decodeImapBody(head, Buffer.from("<p>short</p>"), { complete: false }).html).toBe("");
    expect(decodeImapBody(head, Buffer.from("<p>short</p>")).html).toBe("<p>short</p>");
  });

  it("treats an RFC 2231-named text part as an attachment, not the body", () => {
    const mixed = [
      "--mix",
      "Content-Type: text/plain",
      "",
      "the body",
      "--mix",
      "Content-Type: text/html",
      "Content-Disposition: inline; filename*=UTF-8''report.html",
      "",
      "<p>attached report</p>",
      "--mix--",
    ].join(CRLF);

    const decoded = decodeImapBody(
      headers('Content-Type: multipart/mixed; boundary="mix"'),
      Buffer.from(mixed),
    );

    expect(decoded).toEqual({ text: "the body", html: "" });
  });

  it("keeps decodeImapText's answer identical", () => {
    const head = headers('Content-Type: multipart/alternative; boundary="alt"');
    expect(decodeImapText(head, Buffer.from(ALTERNATIVE))).toBe(
      decodeImapBody(head, Buffer.from(ALTERNATIVE)).text,
    );
  });

  it("stays within budget on a '<' flood in the HTML alternative", () => {
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
    expect(fastestCpuMs(() => decodeImapBody(head, Buffer.from(text)))).toBeLessThan(500);
  });
});
