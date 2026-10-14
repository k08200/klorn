/**
 * Storage limits (step D1): the size cap before and during an upload, the
 * content-type grammar and policy hook, the signed-URL expiry cap, and the
 * download name that ends up in Content-Disposition.
 */

import { describe, expect, it } from "vitest";
import { attachmentDisposition, sanitizeDownloadName } from "../storage/download-name.js";
import {
  allowContentTypes,
  assertSignedUrlExpiry,
  assertUploadSize,
  denyContentTypes,
  guardBytes,
  MAX_OBJECT_BYTES,
  MAX_SIGNED_URL_EXPIRY_SECONDS,
  normalizeContentType,
  SIGNED_DOWNLOAD_CONTENT_TYPE,
} from "../storage/limits.js";
import { chunksOf, codeOf, codeOfAsync, collect } from "./helpers/storage-bytes.js";

async function drain(source: AsyncIterable<Uint8Array>): Promise<number> {
  return (await collect(source)).byteLength;
}

describe("named limits", () => {
  it("caps one object at 25 MiB and a signed URL at five minutes", () => {
    expect(MAX_OBJECT_BYTES).toBe(25 * 1024 * 1024);
    expect(MAX_SIGNED_URL_EXPIRY_SECONDS).toBe(300);
    expect(SIGNED_DOWNLOAD_CONTENT_TYPE).toBe("application/octet-stream");
  });
});

describe("assertUploadSize (before the upload)", () => {
  it("accepts sizes from zero up to the cap", () => {
    expect(codeOf(() => assertUploadSize(0, 100))).toBe("no-error");
    expect(codeOf(() => assertUploadSize(100, 100))).toBe("no-error");
  });

  it("refuses a declared size over the cap", () => {
    expect(codeOf(() => assertUploadSize(101, 100))).toBe("object-too-large");
  });

  it.each([
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("refuses a size that is not a whole number of bytes (%s)", (size) => {
    expect(codeOf(() => assertUploadSize(size, 100))).toBe("invalid-size");
  });
});

describe("guardBytes (during the upload)", () => {
  it("passes a stream that is exactly the declared size", async () => {
    const guarded = guardBytes(chunksOf([4, 6]), { declaredSize: 10, maxBytes: 100 });
    expect(await drain(guarded)).toBe(10);
  });

  it("aborts a stream that runs past the cap", async () => {
    // The declared size passed the check before the upload; the stream then
    // keeps sending. The counter is the only thing between it and the bucket.
    let yielded = 0;
    const guarded = guardBytes(chunksOf([60, 60]), { declaredSize: 100, maxBytes: 100 });
    const code = await codeOfAsync(async () => {
      for await (const chunk of guarded) yielded += chunk.byteLength;
    });
    expect(code).toBe("object-too-large");
    // The chunk that crossed the cap is never handed on.
    expect(yielded).toBe(60);
  });

  it("reports the cap, not the mismatch, when one chunk blows past both", async () => {
    const guarded = guardBytes(chunksOf([101]), { declaredSize: 10, maxBytes: 100 });
    expect(await codeOfAsync(() => drain(guarded))).toBe("object-too-large");
  });

  it("aborts a stream longer than declared even under the cap", async () => {
    const guarded = guardBytes(chunksOf([8, 8]), { declaredSize: 10, maxBytes: 100 });
    expect(await codeOfAsync(() => drain(guarded))).toBe("size-mismatch");
  });

  it("holds back the chunk that completes the declared size until the stream has ended", async () => {
    // Handing that chunk on would give the bucket a complete body of the
    // declared size. It must not get one from a stream that is about to fail.
    const yieldedBeforeFailure = async (sizes: number[]) => {
      let yielded = 0;
      const guarded = guardBytes(chunksOf(sizes), { declaredSize: 10, maxBytes: 100 });
      const code = await codeOfAsync(async () => {
        for await (const chunk of guarded) yielded += chunk.byteLength;
      });
      return { code, yielded };
    };
    expect(await yieldedBeforeFailure([10, 1])).toEqual({ code: "size-mismatch", yielded: 0 });
    expect(await yieldedBeforeFailure([4, 6, 1])).toEqual({ code: "size-mismatch", yielded: 4 });
  });

  it("ignores empty chunks after the declared size", async () => {
    const guarded = guardBytes(chunksOf([10, 0, 0]), { declaredSize: 10, maxBytes: 100 });
    expect(await drain(guarded)).toBe(10);
  });

  it("fails a stream that ends short of the declared size", async () => {
    const guarded = guardBytes(chunksOf([4]), { declaredSize: 10, maxBytes: 100 });
    expect(await codeOfAsync(() => drain(guarded))).toBe("size-mismatch");
  });

  it("accepts an empty stream for an empty object", async () => {
    const guarded = guardBytes(chunksOf([]), { declaredSize: 0, maxBytes: 100 });
    expect(await drain(guarded)).toBe(0);
  });
});

describe("normalizeContentType", () => {
  it("lower-cases and drops parameters", () => {
    expect(normalizeContentType("Text/HTML; charset=UTF-8")).toBe("text/html");
    expect(normalizeContentType(" application/pdf ")).toBe("application/pdf");
    expect(normalizeContentType("application/vnd.ms-excel.sheet+xml")).toBe(
      "application/vnd.ms-excel.sheet+xml",
    );
  });

  it.each([
    ["empty", ""],
    ["no slash", "pdf"],
    ["header injection", "text/plain\r\nx-amz-acl: public-read"],
    ["two slashes", "a/b/c"],
    ["a space inside", "text/pl ain"],
    ["wildcard", "*/*"],
  ])("refuses a value that is not a media type (%s)", (_label, value) => {
    expect(codeOf(() => normalizeContentType(value))).toBe("invalid-content-type");
  });
});

describe("content-type policies", () => {
  it("allowContentTypes admits exact types and type/* families only", () => {
    const policy = allowContentTypes(["application/pdf", "image/*"]);
    expect(policy("application/pdf")).toBe(true);
    expect(policy("image/png")).toBe(true);
    expect(policy("text/html")).toBe(false);
    expect(policy("application/pdfx")).toBe(false);
  });

  it("denyContentTypes admits everything except the listed types", () => {
    const policy = denyContentTypes(["text/html", "application/x-*"]);
    expect(policy("application/pdf")).toBe(true);
    expect(policy("text/html")).toBe(false);
    expect(policy("application/x-msdownload")).toBe(false);
  });
});

describe("assertSignedUrlExpiry", () => {
  it("accepts one second up to the cap", () => {
    expect(codeOf(() => assertSignedUrlExpiry(1))).toBe("no-error");
    expect(codeOf(() => assertSignedUrlExpiry(MAX_SIGNED_URL_EXPIRY_SECONDS))).toBe("no-error");
  });

  it("refuses an expiry past the cap", () => {
    expect(codeOf(() => assertSignedUrlExpiry(MAX_SIGNED_URL_EXPIRY_SECONDS + 1))).toBe(
      "expiry-too-long",
    );
    expect(codeOf(() => assertSignedUrlExpiry(86_400))).toBe("expiry-too-long");
  });

  it.each([
    0,
    -5,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("refuses an expiry that is not a positive whole number (%s)", (seconds) => {
    expect(codeOf(() => assertSignedUrlExpiry(seconds))).toBe("invalid-expiry");
  });
});

describe("sanitizeDownloadName", () => {
  it("keeps an ordinary name", () => {
    expect(sanitizeDownloadName("report.pdf")).toBe("report.pdf");
  });

  it("keeps only the last path component", () => {
    expect(sanitizeDownloadName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeDownloadName("C:\\Users\\me\\notes.txt")).toBe("notes.txt");
  });

  it("removes quotes, control characters and bidi overrides", () => {
    const name = sanitizeDownloadName('a"b\r\nSet-Cookie: x\u202Efdp.exe');
    expect(name).not.toMatch(/["\r\n\u202E]/);
    expect(name).toBe("ab Set-Cookie x fdp.exe");
  });

  it("drops leading dots and falls back when nothing is left", () => {
    expect(sanitizeDownloadName(".htaccess")).toBe("htaccess");
    expect(sanitizeDownloadName("...")).toBe("download");
    expect(sanitizeDownloadName("")).toBe("download");
    expect(sanitizeDownloadName(undefined as unknown as string)).toBe("download");
  });

  it("composes Korean file names to NFC and keeps them", () => {
    const decomposed = "보고서.pdf".normalize("NFD");
    expect(sanitizeDownloadName(decomposed)).toBe("보고서.pdf");
  });

  it("drops a lone surrogate instead of throwing later", () => {
    expect(sanitizeDownloadName("a\uD800b.txt")).toBe("ab.txt");
  });

  it("truncates a long name and keeps the extension", () => {
    const name = sanitizeDownloadName(`${"x".repeat(500)}.pdf`);
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.endsWith(".pdf")).toBe(true);
  });
});

describe("attachmentDisposition", () => {
  it("is always an attachment, with an ASCII name and a UTF-8 name", () => {
    expect(attachmentDisposition("report.pdf")).toBe(
      "attachment;filename=\"report.pdf\";filename*=UTF-8''report.pdf",
    );
  });

  it("percent-encodes a Korean name and gives ASCII clients a fallback", () => {
    const value = attachmentDisposition("보고서 최종.pdf");
    expect(value.startsWith("attachment;")).toBe(true);
    expect(value).toContain('filename="download.pdf"');
    expect(value).toContain(`filename*=UTF-8''${encodeURIComponent("보고서 최종.pdf")}`);
  });

  it("never contains a space, a raw quote from the name, or a line break", () => {
    const value = attachmentDisposition('my "final" report\r\n.html');
    expect(value).not.toMatch(/[ \r\n]/);
    // Exactly the two quotes that delimit the ASCII name.
    expect(value.match(/"/g)).toHaveLength(2);
    expect(value.startsWith("attachment;")).toBe(true);
  });

  it("encodes the characters RFC 5987 does not allow raw", () => {
    const value = attachmentDisposition("it's (a) *test*!.txt");
    const extended = value.split("filename*=UTF-8''")[1] ?? "";
    expect(extended).not.toMatch(/['()*! ]/);
  });
});
