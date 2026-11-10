/**
 * Attachment text extraction runs in a worker thread (2026-10-17). The
 * extractor parses sender-controlled bytes — PDF, DOCX, XLSX, PPTX, HWP — on the
 * API's single event loop during Gmail sync. Three separate "one email stalls
 * the API" bugs were found in a week (#1414, #1466, #1468). The worker bounds the
 * next one: a stall, a crash or a runaway allocation costs that attachment's
 * text, never the server.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import {
  AttachmentExtractionUnavailableError,
  extractAttachmentContentIsolated,
} from "../mail/attachment-extract-isolated.js";
import { extractAttachmentContent } from "../mail/email-attachment-text.js";

const fixture = (name: string) =>
  new URL(`../__fixtures__/attachment-workers/${name}.mjs`, import.meta.url);

/** The real worker boots TypeScript through tsx here, which is slow under a busy test run. */
const REAL_WORKER_TIMEOUT_MS = 30_000;

describe("extractAttachmentContentIsolated", () => {
  it("returns exactly what the in-process extractor returns", async () => {
    const cases: Array<[Buffer, string, string]> = [
      [Buffer.from("Quarterly numbers attached.\nRevenue up 12%."), "notes.txt", "text/plain"],
      [Buffer.from("%PDF-1.4\nBT (Hello from a PDF) Tj ET\n%%EOF"), "hello.pdf", "application/pdf"],
      [Buffer.from([1, 2, 3, 4]), "photo.png", "image/png"],
    ];
    for (const [bytes, name, type] of cases) {
      const isolated = await extractAttachmentContentIsolated(bytes, name, type, {
        timeoutMs: REAL_WORKER_TIMEOUT_MS,
      });
      expect(isolated).toEqual(extractAttachmentContent(bytes, name, type));
    }
  }, 120_000);

  it("stops an extraction that never finishes, and the event loop keeps running meanwhile", async () => {
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 20);
    const started = Date.now();

    const result = extractAttachmentContentIsolated(
      Buffer.from("x"),
      "trap.pdf",
      "application/pdf",
      {
        timeoutMs: 500,
        workerUrl: fixture("hang"),
      },
    );

    // A throw, like the extractor's own failures: Gmail stores no text (and keeps
    // what an earlier sync read); a drive summary retries instead of skipping.
    await expect(result).rejects.toMatchObject({
      name: "AttachmentExtractionUnavailableError",
      reason: "timeout",
    });
    clearInterval(ticker);
    expect(Date.now() - started).toBeLessThan(5_000);
    // In-process, a spinning extractor would have frozen this timer completely.
    expect(ticks).toBeGreaterThan(5);
  });

  it("fails when the extractor throws", async () => {
    const result = extractAttachmentContentIsolated(
      Buffer.from("x"),
      "broken.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      { timeoutMs: 10_000, workerUrl: fixture("crash") },
    );
    await expect(result).rejects.toMatchObject({ reason: "failed" });
  });

  it("fails when the extractor runs out of its heap", async () => {
    const result = extractAttachmentContentIsolated(
      Buffer.from("x"),
      "bomb.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      { timeoutMs: 20_000, workerUrl: fixture("oom") },
    );
    await expect(result).rejects.toMatchObject({ reason: "failed" });
  }, 30_000);

  it("runs one extraction at a time", async () => {
    const started = Date.now();
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        extractAttachmentContentIsolated(Buffer.from("x"), "a.txt", "text/plain", {
          timeoutMs: 10_000,
          workerUrl: fixture("slow"),
        }),
      ),
    );
    expect(results.every((r) => r.status === "readable" && r.text === "done")).toBe(true);
    // Three 200 ms extractions back to back cannot finish sooner than this.
    expect(Date.now() - started).toBeGreaterThanOrEqual(550);
  });

  it("refuses an attachment instead of queueing it behind 32 others", async () => {
    const run = () =>
      extractAttachmentContentIsolated(Buffer.from("x"), "a.txt", "text/plain", {
        timeoutMs: 10_000,
        workerUrl: fixture("quick"),
      });
    // One running, 32 waiting, and a 34th that must not wait.
    const results = await Promise.allSettled(Array.from({ length: 34 }, run));
    const done = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof AttachmentExtractionUnavailableError,
    );
    expect(done).toHaveLength(33);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason.reason).toBe("busy");
  }, 30_000);

  it("reads a legacy hwp whose text is one 6 MB run without running out of heap", async () => {
    // A character-at-a-time string build needed ~30× the text in memory and ran
    // the worker's 128 MB heap out at 6 MB (review of #1535).
    const hwp = Buffer.concat([
      Buffer.from("HWP Document File V5\0"),
      Buffer.from("가".repeat(3_000_000), "utf16le"),
    ]);
    const result = await extractAttachmentContentIsolated(
      hwp,
      "long.hwp",
      "application/haansofthwp",
      { timeoutMs: REAL_WORKER_TIMEOUT_MS },
    );
    expect(result.status).toBe("readable");
    expect(result.text?.length).toBeGreaterThan(1_000_000);
  }, 120_000);

  it("reads an image or an unknown type in-process: nothing to parse, no thread", async () => {
    const started = Date.now();
    const image = await extractAttachmentContentIsolated(Buffer.alloc(10), "logo.png", "image/png");
    const blob = await extractAttachmentContentIsolated(
      Buffer.alloc(10),
      "data.bin",
      "application/octet-stream",
    );
    expect(image).toEqual(extractAttachmentContent(Buffer.alloc(10), "logo.png", "image/png"));
    expect(blob.status).toBe("unsupported");
    // A worker booting TypeScript takes most of a second here; in-process is instant.
    expect(Date.now() - started).toBeLessThan(500);
  });
});
