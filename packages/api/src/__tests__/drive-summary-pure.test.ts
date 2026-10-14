/**
 * D4: the pure parts of drive file summaries. The byte cap holds while a file
 * streams (never after buffering it), the text comes from the attachment
 * pipeline's extractor and is capped before any model sees it, and the day and
 * backoff arithmetic the caps use.
 */

import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_EXTRACTABLE_BYTES } from "../mail/email-attachment-text.js";
import { readCappedBytes } from "../drive/summary-bytes.js";
import { extractSummaryText, isSummarisableFile } from "../drive/summary-extract.js";
import {
  DRIVE_SUMMARY_MAX_INPUT_CHARS,
  DRIVE_SUMMARY_MAX_SOURCE_BYTES,
  DRIVE_SUMMARY_RETRY_BASE_MS,
  DRIVE_SUMMARY_RETRY_MAX_MS,
  driveSummariesLive,
  nextUtcDay,
  summaryRetryDelayMs,
  utcDayKey,
  utcDayKeyBefore,
} from "../drive/summary-policy.js";

/** A source of `count` chunks of `size` bytes that records how many were pulled. */
function countingSource(count: number, size: number) {
  const state = { pulled: 0, returned: false };
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (state.pulled >= count) return { done: true, value: undefined };
          state.pulled += 1;
          return { done: false, value: new Uint8Array(size).fill(0x61) };
        },
        async return() {
          state.returned = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
  return { source, state };
}

describe("readCappedBytes: the cap is checked while the bytes stream", () => {
  it("collects a file under the cap whole", async () => {
    const { source } = countingSource(4, 1_000);
    const result = await readCappedBytes(source, 4_000);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bytes.length).toBe(4_000);
  });

  it("stops at the chunk that crosses the cap, pulls no further and releases the source", async () => {
    const { source, state } = countingSource(1_000, 1_024);
    const result = await readCappedBytes(source, 10 * 1_024);
    expect(result).toEqual({ ok: false, reason: "too-large" });
    // 10 chunks fit, the 11th crosses: nothing after it is read.
    expect(state.pulled).toBe(11);
    expect(state.returned).toBe(true);
  });

  it("an endless source ends in too-large instead of filling memory", async () => {
    const endless: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        for (;;) yield new Uint8Array(64 * 1_024);
      },
    };
    await expect(readCappedBytes(endless, 1_000_000)).resolves.toEqual({
      ok: false,
      reason: "too-large",
    });
  });

  it("destroys a Node stream it stops reading", async () => {
    const stream = Readable.from(
      (function* () {
        for (let i = 0; i < 100; i++) yield Buffer.alloc(1_000, 1);
      })(),
    );
    const result = await readCappedBytes(stream, 5_000);
    expect(result.ok).toBe(false);
    expect(stream.destroyed).toBe(true);
  });

  it("the summary cap is the attachment extractor's own", () => {
    expect(DRIVE_SUMMARY_MAX_SOURCE_BYTES).toBe(MAX_EXTRACTABLE_BYTES);
  });
});

describe("the text comes from the attachment pipeline's extractor", () => {
  it("reads a text file and caps the text before any model sees it", () => {
    const long = "가".repeat(DRIVE_SUMMARY_MAX_INPUT_CHARS + 500);
    const result = extractSummaryText(Buffer.from(long, "utf8"), "notes.txt", "text/plain");
    expect(result.ok).toBe(true);
    if (result.ok) expect([...result.text]).toHaveLength(DRIVE_SUMMARY_MAX_INPUT_CHARS);
  });

  it("an unknown binary type is unsupported, an empty text has no text", () => {
    expect(extractSummaryText(Buffer.from([1, 2, 3]), "blob.bin", null)).toEqual({
      ok: false,
      code: "unsupported-type",
    });
    expect(extractSummaryText(Buffer.from("   \n "), "empty.txt", "text/plain")).toEqual({
      ok: false,
      code: "no-text",
    });
  });

  it("a PDF with no text layer is skipped, not summarised from the extractor's placeholder", () => {
    const result = extractSummaryText(Buffer.from("%PDF-1.4\n%%EOF"), "scan.pdf", "application/pdf");
    expect(result).toEqual({ ok: false, code: "no-text" });
  });

  it("decides what is worth fetching from the name, the type label and the size", () => {
    expect(isSummarisableFile("report.pdf", "application/pdf", 10_000)).toBe(true);
    expect(isSummarisableFile("notes.md", null, 10)).toBe(true);
    expect(isSummarisableFile("photo.png", "image/png", 10)).toBe(false);
    expect(isSummarisableFile("photo.jpg", null, 10)).toBe(false);
    expect(isSummarisableFile("archive.zip", "application/zip", 10)).toBe(false);
    expect(
      isSummarisableFile("big.pdf", "application/pdf", DRIVE_SUMMARY_MAX_SOURCE_BYTES + 1),
    ).toBe(false);
    expect(isSummarisableFile("unknown.pdf", "application/pdf", null)).toBe(true);
  });
});

describe("day keys, caps' reset and backoff", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("works in UTC days", () => {
    const now = new Date("2026-10-14T23:59:59.000Z");
    expect(utcDayKey(now)).toBe("2026-10-14");
    expect(nextUtcDay(now).toISOString()).toBe("2026-10-15T00:00:00.000Z");
    expect(utcDayKeyBefore(now, 7)).toBe("2026-10-07");
  });

  it("doubles the retry wait from the base, up to the cap", () => {
    expect(summaryRetryDelayMs(1)).toBe(DRIVE_SUMMARY_RETRY_BASE_MS);
    expect(summaryRetryDelayMs(2)).toBe(2 * DRIVE_SUMMARY_RETRY_BASE_MS);
    expect(summaryRetryDelayMs(50)).toBe(DRIVE_SUMMARY_RETRY_MAX_MS);
  });

  it("is live only while DRIVE_SUMMARIES_ENABLED and DRIVE_ENABLED are both on", () => {
    vi.stubEnv("DRIVE_SUMMARIES_ENABLED", "true");
    vi.stubEnv("DRIVE_ENABLED", "");
    expect(driveSummariesLive()).toBe(false);
    vi.stubEnv("DRIVE_ENABLED", "true");
    expect(driveSummariesLive()).toBe(true);
    vi.stubEnv("DRIVE_SUMMARIES_ENABLED", "off");
    expect(driveSummariesLive()).toBe(false);
  });
});
