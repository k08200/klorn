/**
 * Step B3: turning the header block an IMAP server returns for one message into
 * the reply-header result of the provider seam.
 *
 * The block is untrusted server text. Only message ids, parsed by
 * `mail/reply-headers.ts`, leave this module: In-Reply-To will carry the
 * original's Message-ID, References the original's chain.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_HEADER_BLOCK_BYTES,
  parseHeaderFields,
  replyHeadersFromBlock,
} from "../mail/providers/imap-reply-headers.js";

const block = (...lines: string[]) => Buffer.from(`${lines.join("\r\n")}\r\n\r\n`);

describe("parseHeaderFields", () => {
  it("reads name/value pairs case-insensitively and trims values", () => {
    const fields = parseHeaderFields(
      block("Message-ID:   <a@x.example>  ", "REFERENCES: <b@x.example>"),
    );
    expect(fields.get("message-id")).toBe("<a@x.example>");
    expect(fields.get("references")).toBe("<b@x.example>");
  });

  it("unfolds continuation lines (CRLF and bare LF)", () => {
    const crlf = parseHeaderFields(
      block("References: <a@x.example>", " <b@x.example>", "\t<c@x.example>"),
    );
    expect(crlf.get("references")).toBe("<a@x.example> <b@x.example> <c@x.example>");
    const lf = parseHeaderFields(Buffer.from("References: <a@x.example>\n <b@x.example>\n\n"));
    expect(lf.get("references")).toBe("<a@x.example> <b@x.example>");
  });

  it("keeps the first occurrence of a repeated header", () => {
    const fields = parseHeaderFields(
      block("Message-ID: <first@x.example>", "Message-ID: <second@x.example>"),
    );
    expect(fields.get("message-id")).toBe("<first@x.example>");
  });

  it("stops at the blank line that ends the block", () => {
    const fields = parseHeaderFields(
      Buffer.from("Message-ID: <a@x.example>\r\n\r\nReferences: <late@x.example>\r\n"),
    );
    expect(fields.has("references")).toBe(false);
  });

  it("ignores lines that are not headers, and non-buffer input", () => {
    expect(parseHeaderFields(block("no colon here", ": empty name", "Good: yes")).get("good")).toBe(
      "yes",
    );
    expect(parseHeaderFields(undefined).size).toBe(0);
    expect(parseHeaderFields(null).size).toBe(0);
    expect(parseHeaderFields(42).size).toBe(0);
    expect(parseHeaderFields(Buffer.alloc(0)).size).toBe(0);
  });

  it("only looks at the first MAX_HEADER_BLOCK_BYTES bytes", () => {
    const filler = `X-Junk: ${"a".repeat(MAX_HEADER_BLOCK_BYTES)}\r\n`;
    const fields = parseHeaderFields(Buffer.from(`${filler}Message-ID: <late@x.example>\r\n\r\n`));
    expect(fields.has("message-id")).toBe(false);
  });
});

describe("replyHeadersFromBlock", () => {
  it("returns the original's Message-ID and its References chain as message ids", () => {
    const result = replyHeadersFromBlock(
      block("Message-ID: <orig@x.example>", "References: <root@x.example>", " <mid@x.example>"),
    );
    expect(result).toEqual({
      messageId: "<orig@x.example>",
      references: "<root@x.example> <mid@x.example>",
    });
  });

  it("omits what is missing", () => {
    expect(replyHeadersFromBlock(block("Message-ID: <orig@x.example>"))).toEqual({
      messageId: "<orig@x.example>",
    });
    expect(replyHeadersFromBlock(block("References: <a@x.example>"))).toEqual({
      references: "<a@x.example>",
    });
    expect(replyHeadersFromBlock(block("Subject: hi"))).toEqual({});
    expect(replyHeadersFromBlock(undefined)).toEqual({});
  });

  it("passes only parsed ids: free text, separators and control characters are dropped", () => {
    const result = replyHeadersFromBlock(
      Buffer.from(
        "Message-ID: junk <orig@x.example> Bcc: evil@x.example\r\nReferences: <a@x.example>\u2028Bcc: evil <b b@x.example> <c@x.example>\r\n\r\n",
      ),
    );
    expect(result).toEqual({
      messageId: "<orig@x.example>",
      references: "<a@x.example> <c@x.example>",
    });
    expect(JSON.stringify(result)).not.toMatch(/Bcc|evil|\u2028/);
  });

  it("takes the last id when Message-ID holds several", () => {
    expect(replyHeadersFromBlock(block("Message-ID: <a@x.example> <b@x.example>"))).toEqual({
      messageId: "<b@x.example>",
    });
  });
});
