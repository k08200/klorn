/**
 * vision-attachment-policy — the deterministic "send this attachment to the
 * vision model?" rules. isDecorativeImage is the new guard that keeps tiny
 * logos / tracking pixels (e.g. the 558-byte logo.png on a BetaList digest)
 * out of the vision path so they don't burn quota or surface VISION_FAILED.
 */

import { describe, expect, it } from "vitest";
import { isDecorativeImage, isVisionAttachment } from "../vision-attachment-policy.js";

describe("isDecorativeImage", () => {
  it("treats a tiny image (the 558-byte logo.png repro) as decorative", () => {
    expect(isDecorativeImage({ filename: "logo.png", mimeType: "image/png", size: 558 })).toBe(
      true,
    );
  });

  it("treats a sub-4KB image as decorative regardless of filename", () => {
    expect(isDecorativeImage({ filename: "header.jpg", mimeType: "image/jpeg", size: 2_000 })).toBe(
      true,
    );
  });

  it("treats a decorative filename as decorative even at/above the byte floor", () => {
    // A 30KB email logo is still chrome, not content worth OCR'ing.
    expect(isDecorativeImage({ filename: "logo.png", mimeType: "image/png", size: 30_000 })).toBe(
      true,
    );
    expect(
      isDecorativeImage({ filename: "facebook-icon.png", mimeType: "image/png", size: 12_000 }),
    ).toBe(true);
    expect(
      isDecorativeImage({ filename: "email_spacer.gif", mimeType: "image/gif", size: 50 }),
    ).toBe(true);
  });

  it("does NOT treat a real content image (large, non-decorative name) as decorative", () => {
    // A scanned resume / screenshot / headshot must still go to vision.
    expect(
      isDecorativeImage({ filename: "headshot.jpg", mimeType: "image/jpeg", size: 240_000 }),
    ).toBe(false);
    expect(
      isDecorativeImage({ filename: "resume_scan.png", mimeType: "image/png", size: 80_000 }),
    ).toBe(false);
  });

  it("treats a known 0-byte (corrupt/empty) image as decorative", () => {
    expect(isDecorativeImage({ filename: "photo.jpg", mimeType: "image/jpeg", size: 0 })).toBe(
      true,
    );
  });

  it("does NOT match a path-like prefix as decorative (filenames are basenames)", () => {
    // "header" here is a directory segment, not the file's own decorative name —
    // the `/` boundary was removed so a real content image isn't skipped.
    expect(
      isDecorativeImage({
        filename: "screenshots/header.png",
        mimeType: "image/png",
        size: 90_000,
      }),
    ).toBe(false);
  });

  it("never treats a non-image attachment (PDF/doc) as decorative", () => {
    // PDFs/docs always get analyzed, even tiny ones.
    expect(
      isDecorativeImage({ filename: "logo.pdf", mimeType: "application/pdf", size: 500 }),
    ).toBe(false);
    expect(
      isDecorativeImage({ filename: "icon.docx", mimeType: "application/octet-stream", size: 100 }),
    ).toBe(false);
  });

  it("falls back to filename-only when size is unknown (null)", () => {
    // No size signal → decide on the name. A decorative name still skips; an
    // unknown-size content image does not.
    expect(isDecorativeImage({ filename: "logo.png", mimeType: "image/png", size: null })).toBe(
      true,
    );
    expect(isDecorativeImage({ filename: "photo.jpg", mimeType: "image/jpeg", size: null })).toBe(
      false,
    );
  });
});

describe("isVisionAttachment (unchanged behavior, moved to leaf module)", () => {
  it("flags images and PDFs as vision candidates", () => {
    const base = { contentText: null, analysisStatus: "PENDING" };
    expect(isVisionAttachment({ ...base, filename: "x.png", mimeType: "image/png" })).toBe(true);
    expect(isVisionAttachment({ ...base, filename: "x.pdf", mimeType: "application/pdf" })).toBe(
      true,
    );
  });

  it("does NOT flag a plain analyzed text attachment", () => {
    expect(
      isVisionAttachment({
        filename: "notes.txt",
        mimeType: "text/plain",
        contentText: "hello",
        analysisStatus: "ANALYZED",
      }),
    ).toBe(false);
  });
});
