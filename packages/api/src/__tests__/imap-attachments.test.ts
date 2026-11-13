import { beforeEach, describe, expect, it, vi } from "vitest";
import { fastestCpuMs } from "./helpers/linear-timing.js";

// IMAP mail stored `attachments: []`: the poll never looked past the text part.
// These fixtures walk the same BODY[TEXT] the poll already fetches, with the
// same bounded linear MIME reader as imap-body.ts, and hand the parts to the
// Gmail attachment model (partKey = IMAP section number).

const extract = vi.hoisted(() => vi.fn());
vi.mock("../mail/attachment-extract-isolated.js", () => ({
  extractAttachmentContentIsolated: extract,
}));

const { collectImapAttachmentParts, imapRawAttachments } = await import(
  "../mail/imap-attachments.js"
);
const { cleanAttachmentFilename } = await import("../mail/attachment-names.js");

const CRLF = "\r\n";
const head = (value: string) => Buffer.from(`Content-Type: ${value}${CRLF}`);
const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64");
const mime = (...lines: string[]) => Buffer.from(lines.join(CRLF));

const PDF = Buffer.from("%PDF-1.4 quarterly numbers");

const MIXED_WITH_PDF = mime(
  "--mix",
  'Content-Type: multipart/alternative; boundary="alt"',
  "",
  "--alt",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "see attached",
  "--alt",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>see attached</p>",
  "--alt--",
  "--mix",
  'Content-Type: application/pdf; name="report.pdf"',
  'Content-Disposition: attachment; filename="report.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  b64(PDF),
  "--mix--",
  "",
);

describe("collectImapAttachmentParts", () => {
  it("lists a base64 PDF with its IMAP section, exact decoded size and bytes", () => {
    const parts = collectImapAttachmentParts(
      head('multipart/mixed; boundary="mix"'),
      MIXED_WITH_PDF,
      { complete: true },
    );

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      section: "2",
      filename: "report.pdf",
      mimeType: "application/pdf",
      size: PDF.length,
      contentId: null,
      inlineOnly: false,
    });
    expect(parts[0]?.decode()).toEqual(PDF);
  });

  it("finds nothing in a plain multipart/alternative message", () => {
    const alternative = mime(
      "--alt",
      "Content-Type: text/plain",
      "",
      "hi",
      "--alt",
      "Content-Type: text/html",
      "",
      "<p>hi</p>",
      "--alt--",
    );
    expect(
      collectImapAttachmentParts(head('multipart/alternative; boundary="alt"'), alternative, {
        complete: true,
      }),
    ).toEqual([]);
  });

  it("keeps a filename-less inline image by Content-ID and drops a non-image one", () => {
    const related = mime(
      "--rel",
      "Content-Type: text/html",
      "",
      '<img src="cid:logo@x">',
      "--rel",
      "Content-Type: image/png",
      "Content-ID: <logo@x>",
      "Content-Transfer-Encoding: base64",
      "",
      b64("png-bytes"),
      "--rel",
      "Content-Type: application/octet-stream",
      "Content-ID: <blob@x>",
      "",
      "opaque",
      "--rel--",
    );
    const message = mime(
      "--mix",
      'Content-Type: multipart/related; boundary="rel"',
      "",
      related.toString("latin1"),
      "--mix",
      'Content-Type: text/csv; name="a.csv"',
      "",
      "a,b",
      "--mix--",
    );

    const parts = collectImapAttachmentParts(head('multipart/mixed; boundary="mix"'), message, {
      complete: true,
    });

    expect(parts.map((p) => [p.section, p.filename, p.contentId, p.inlineOnly])).toEqual([
      ["1.2", "inline-logo@x", "logo@x", true],
      ["2", "a.csv", null, false],
    ]);
  });

  it("lists an attached message/rfc822 as one .eml and never its inner parts", () => {
    const message = mime(
      "--mix",
      "Content-Type: text/plain",
      "",
      "fyi",
      "--mix",
      "Content-Type: message/rfc822",
      "",
      'Content-Type: multipart/mixed; boundary="inner"',
      "Subject: original",
      "",
      "--inner",
      'Content-Type: application/pdf; name="inner.pdf"',
      "",
      "%PDF",
      "--inner--",
      "--mix--",
    );

    const parts = collectImapAttachmentParts(head('multipart/mixed; boundary="mix"'), message, {
      complete: true,
    });

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      section: "2",
      filename: "attached-message.eml",
      mimeType: "message/rfc822",
    });
  });

  it("decodes Korean filenames: RFC 2231 (one value, continuations, EUC-KR) and RFC 2047", () => {
    const quote = "견적서.pdf";
    const utf8Pct = [...Buffer.from(quote)].map((b) => `%${b.toString(16).toUpperCase()}`);
    const eucKrPct = "%B0%DF%C0%FB%BC%AD.pdf"; // 견적서 in EUC-KR
    const parts = (disposition: string) =>
      collectImapAttachmentParts(
        head('multipart/mixed; boundary="m"'),
        mime(
          "--m",
          "Content-Type: application/pdf",
          `Content-Disposition: ${disposition}`,
          "",
          "%PDF",
          "--m--",
        ),
        { complete: true },
      )[0]?.filename;

    expect(parts(`attachment; filename*=UTF-8''${utf8Pct.join("")}`)).toBe(quote);
    expect(
      parts(
        `attachment;\r\n filename*0*=UTF-8''${utf8Pct.slice(0, 5).join("")};\r\n filename*1*=${utf8Pct.slice(5).join("")}`,
      ),
    ).toBe(quote);
    expect(parts(`attachment; filename*=euc-kr''${eucKrPct}`)).toBe(quote);
    expect(parts(`attachment; filename="=?UTF-8?B?${b64(quote)}?="`)).toBe(quote);
    expect(parts(`attachment; filename="${quote}"`)).toBe(quote);
  });

  it("strips path components, control and bidi characters from a filename", () => {
    expect(cleanAttachmentFilename("../../etc/passwd")).toBe("passwd");
    expect(cleanAttachmentFilename("..\\..\\boot.ini")).toBe("boot.ini");
    expect(cleanAttachmentFilename("in\u0000voice\r\n.pdf")).toBe("invoice.pdf");
    expect(cleanAttachmentFilename(`photo${String.fromCharCode(0x202e)}gnp.exe`)).toBe(
      "photognp.exe",
    );
    expect(cleanAttachmentFilename("..")).toBe("");
    expect(cleanAttachmentFilename("a".repeat(400)).length).toBe(255);
  });

  it("numbers a single-part attachment message as section 1", () => {
    const parts = collectImapAttachmentParts(
      Buffer.from(
        `Content-Type: application/pdf; name="only.pdf"${CRLF}Content-Transfer-Encoding: base64${CRLF}`,
      ),
      Buffer.from(b64(PDF)),
      { complete: true },
    );
    expect(parts.map((p) => [p.section, p.filename, p.size])).toEqual([
      ["1", "only.pdf", PDF.length],
    ]);
  });

  it("has no size or bytes for a part the fetch slice cut off", () => {
    const cut = Buffer.from(MIXED_WITH_PDF.toString("latin1").slice(0, -20));
    const [part] = collectImapAttachmentParts(head('multipart/mixed; boundary="mix"'), cut, {
      complete: false,
    });
    expect(part).toMatchObject({ section: "2", filename: "report.pdf", size: null });
    expect(part?.decode()).toBeNull();
  });

  it("returns nothing without headers or text", () => {
    expect(collectImapAttachmentParts(undefined, MIXED_WITH_PDF, { complete: true })).toEqual([]);
    expect(collectImapAttachmentParts(head("text/plain"), undefined, { complete: true })).toEqual(
      [],
    );
  });

  describe("hostile input stays within budget", () => {
    const BUDGET_MS = 500;

    it("thousands of named parts are capped and stay linear", () => {
      const part = `--p${CRLF}Content-Type: application/pdf; name="x.pdf"${CRLF}${CRLF}x${CRLF}`;
      const body = Buffer.from(part.repeat(20_000));
      let parts: unknown[] = [];
      const ms = fastestCpuMs(() => {
        parts = collectImapAttachmentParts(head('multipart/mixed; boundary="p"'), body, {
          complete: true,
        });
      });
      expect(ms).toBeLessThan(BUDGET_MS);
      expect(parts.length).toBeLessThanOrEqual(64);
    });

    it("deep nesting and a huge filename*N continuation run", () => {
      let nested = "x";
      for (let depth = 0; depth < 2000; depth++) {
        nested = `--n${depth}${CRLF}Content-Type: multipart/mixed; boundary="n${depth + 1}"${CRLF}${CRLF}${nested}`;
      }
      const continuations = Array.from({ length: 5000 }, (_, i) => ` filename*${i}*=%41`).join(
        `;${CRLF}`,
      );
      const many = mime(
        "--m",
        "Content-Type: application/pdf",
        `Content-Disposition: attachment;${CRLF}${continuations}`,
        "",
        "%PDF",
        "--m--",
      );
      for (const [type, body] of [
        ['multipart/mixed; boundary="n0"', Buffer.from(nested)],
        ['multipart/mixed; boundary="m"', many],
      ] as const) {
        const ms = fastestCpuMs(() =>
          collectImapAttachmentParts(head(type), body, { complete: true }),
        );
        expect(ms).toBeLessThan(BUDGET_MS);
      }
    });
  });
});

describe("imapRawAttachments", () => {
  beforeEach(() => {
    extract.mockReset();
  });

  it("extracts readable non-inline parts through the isolated worker, keyed by section", async () => {
    extract.mockResolvedValue({ text: "quarterly numbers", status: "readable" });
    const parts = collectImapAttachmentParts(
      head('multipart/mixed; boundary="mix"'),
      MIXED_WITH_PDF,
      { complete: true },
    );

    const raw = await imapRawAttachments(parts);

    expect(extract).toHaveBeenCalledWith(PDF, "report.pdf", "application/pdf");
    expect(raw).toEqual([
      {
        gmailAttachmentId: "2",
        partKey: "2",
        filename: "report.pdf",
        mimeType: "application/pdf",
        size: PDF.length,
        contentId: null,
        contentText: "quarterly numbers",
      },
    ]);
  });

  it("keeps the row without text when the worker is unavailable", async () => {
    extract.mockRejectedValue(new Error("busy"));
    const parts = collectImapAttachmentParts(
      head('multipart/mixed; boundary="mix"'),
      MIXED_WITH_PDF,
      { complete: true },
    );

    const [row] = await imapRawAttachments(parts);

    expect(row).toMatchObject({ partKey: "2", contentText: null });
  });

  it("never extracts an inline-only image or an unreadable type", async () => {
    const message = mime(
      "--m",
      "Content-Type: image/png",
      "Content-ID: <logo@x>",
      "",
      "png",
      "--m",
      'Content-Type: application/zip; name="a.zip"',
      "",
      "PK",
      "--m--",
    );
    const parts = collectImapAttachmentParts(head('multipart/related; boundary="m"'), message, {
      complete: true,
    });

    const raw = await imapRawAttachments(parts);

    expect(extract).not.toHaveBeenCalled();
    expect(raw.map((r) => [r.partKey, r.contentText])).toEqual([
      ["1", null],
      ["2", null],
    ]);
  });
});
