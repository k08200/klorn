/**
 * Attachment text extraction, off the event loop.
 *
 * The extractor (email-attachment-text.ts) parses sender-controlled bytes — PDF,
 * DOCX, XLSX, PPTX, HWP — during Gmail sync, and the API serves every user and
 * runs every scheduler on one event loop. In one week three separate inputs
 * were found that stalled it for seconds to minutes (#1414, #1466, #1468); each
 * was fixed by making a scan linear. This bounds the next one instead of
 * waiting for it: extraction runs in a worker thread with a time limit and a
 * heap limit, so a stall, a crash or a runaway allocation costs that one
 * attachment's text — the call throws, as the extractor's own failures did —
 * and never the server. The queue for the one worker is bounded in length and
 * wait time.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { captureError } from "../sentry.js";
import type { AttachmentExtractJob } from "./attachment-extract-worker.js";
import {
  type ExtractedAttachmentContent,
  extractAttachmentContent,
  needsParsing,
} from "./email-attachment-text.js";

/** Room for a legitimate 8 MB file on a small shared-CPU instance; a stall is cut off here. */
const EXTRACT_TIMEOUT_MS = 10_000;
/** Inputs are at most 8 MB and archives stop at 8 MB inflated, so this is generous. */
const WORKER_OLD_HEAP_MB = 128;
const WORKER_YOUNG_HEAP_MB = 32;
/** One at a time: a burst of attachments must not become a burst of threads on one small instance. */
const MAX_CONCURRENT_EXTRACTIONS = 1;
/**
 * Attachments that may wait for the slot, and for how long. Past either the
 * attachment is left unread rather than queued: one sender's mail must not hold
 * every other user's sync behind it.
 */
const MAX_WAITING_EXTRACTIONS = 32;
const MAX_WAIT_MS = 20_000;
/** A failure kind reaches Sentry at most this often; the log line is always written. */
const REPORT_INTERVAL_MS = 10 * 60_000;
/** Sender-controlled, so only this much of it reaches a log line. */
const MAX_LOGGED_TYPE_CHARS = 100;

/**
 * The text could not be read this time: the queue was full or the wait too
 * long ("busy"), the extraction ran out of time ("timeout"), or the worker
 * crashed, ran out of memory or answered nonsense ("failed"). A throw, like the
 * in-process extractor's own failures: Gmail sync stores no text (and keeps any
 * a previous sync read), and a drive summary is retried with backoff instead of
 * being skipped as a file that has no text.
 */
export class AttachmentExtractionUnavailableError extends Error {
  constructor(readonly reason: "busy" | "timeout" | "failed") {
    super(`attachment text extraction unavailable: ${reason}`);
    this.name = "AttachmentExtractionUnavailableError";
  }
}

const lastReportedAt = new Map<string, number>();

export interface IsolatedExtractOptions {
  timeoutMs?: number;
  /** Test seam: run this worker script instead of the extractor. */
  workerUrl?: URL;
}

interface Waiter {
  grant: () => void;
}

let active = 0;
const waiting: Waiter[] = [];

/** Resolves true once this caller holds the slot, false when it should not wait. */
function acquireSlot(): Promise<boolean> {
  if (active < MAX_CONCURRENT_EXTRACTIONS) {
    active++;
    return Promise.resolve(true);
  }
  if (waiting.length >= MAX_WAITING_EXTRACTIONS) return Promise.resolve(false);
  return new Promise((resolve) => {
    const waiter: Waiter = {
      grant: () => {
        clearTimeout(timer);
        resolve(true);
      },
    };
    const timer = setTimeout(() => {
      const index = waiting.indexOf(waiter);
      if (index >= 0) waiting.splice(index, 1);
      resolve(false);
    }, MAX_WAIT_MS);
    waiting.push(waiter);
  });
}

/** Hands the slot straight to the next waiter, so no one can slip in between. */
function releaseSlot(): void {
  const next = waiting.shift();
  if (next) next.grant();
  else active--;
}

/** The compiled worker in production; from source, a bootstrap that loads it through tsx. */
function extractorWorker(): { url: URL; entry?: string } {
  const compiled = new URL("./attachment-extract-worker.js", import.meta.url);
  if (existsSync(fileURLToPath(compiled))) return { url: compiled };
  return {
    url: new URL("./attachment-extract-worker-dev.mjs", import.meta.url),
    entry: new URL("./attachment-extract-worker.ts", import.meta.url).href,
  };
}

function isExtracted(value: unknown): value is ExtractedAttachmentContent {
  if (typeof value !== "object" || value === null) return false;
  const { text, status } = value as { text?: unknown; status?: unknown };
  return (
    (typeof text === "string" || text === null) &&
    (status === "readable" || status === "metadata" || status === "unsupported")
  );
}

/** A log-safe form of a sender-supplied MIME type. */
function loggableType(mimeType: string): string {
  const printable = Array.from(mimeType)
    .filter((ch) => ch >= " " && ch <= "~")
    .join("");
  return printable.slice(0, MAX_LOGGED_TYPE_CHARS) || "no type";
}

export async function extractAttachmentContentIsolated(
  buffer: Buffer,
  filename: string,
  mimeType: string,
  options: IsolatedExtractOptions = {},
): Promise<ExtractedAttachmentContent> {
  // Images, unknown types and oversized files never parse their bytes: no thread needed.
  if (!options.workerUrl && !needsParsing(filename, mimeType, buffer.length)) {
    return extractAttachmentContent(buffer, filename, mimeType);
  }
  if (!(await acquireSlot())) {
    console.warn(
      `[ATTACHMENT] extraction skipped, queue full or wait too long (${loggableType(mimeType)}, ${buffer.length} bytes)`,
    );
    throw new AttachmentExtractionUnavailableError("busy");
  }
  try {
    return await runInWorker({ bytes: new Uint8Array(buffer), filename, mimeType }, options);
  } finally {
    releaseSlot();
  }
}

function runInWorker(
  job: AttachmentExtractJob,
  options: IsolatedExtractOptions,
): Promise<ExtractedAttachmentContent> {
  const timeoutMs = options.timeoutMs ?? EXTRACT_TIMEOUT_MS;
  const target = options.workerUrl ? { url: options.workerUrl } : extractorWorker();
  // Never the filename: it is the sender's text. A sender controls how often
  // this fires, so each kind reaches Sentry at most once per interval.
  const report = (
    what: string,
    reason: AttachmentExtractionUnavailableError["reason"],
    err: unknown,
  ) => {
    const type = loggableType(job.mimeType);
    console.warn(`[ATTACHMENT] ${what} (${type}, ${job.bytes.byteLength} bytes)`, err);
    const now = Date.now();
    if (now - (lastReportedAt.get(reason) ?? 0) < REPORT_INTERVAL_MS) return;
    lastReportedAt.set(reason, now);
    captureError(err, {
      tags: { scope: "attachment-extract.worker", reason },
      extra: { mimeType: type, bytes: job.bytes.byteLength },
    });
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(target.url, {
      workerData: { entry: target.entry, job },
      // The extractor needs no configuration; the worker gets none of the API's secrets.
      env: {},
      resourceLimits: {
        maxOldGenerationSizeMb: WORKER_OLD_HEAP_MB,
        maxYoungGenerationSizeMb: WORKER_YOUNG_HEAP_MB,
      },
    });
    const settle = () => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      return true;
    };
    const fail = (reason: AttachmentExtractionUnavailableError["reason"]) => {
      if (settle()) reject(new AttachmentExtractionUnavailableError(reason));
    };
    const timer = setTimeout(() => {
      report(`extraction stopped after ${timeoutMs} ms`, "timeout", new Error("timed out"));
      fail("timeout");
    }, timeoutMs);
    worker.once("message", (message: unknown) => {
      if (isExtracted(message)) {
        if (settle()) resolve(message);
        return;
      }
      report("extraction worker sent an unexpected result", "failed", new Error("bad message"));
      fail("failed");
    });
    // `on`, not `once`: a second error from a dying worker must not become an
    // unhandled 'error' event in the API process.
    worker.on("error", (err) => {
      if (settled) return;
      report("extraction worker failed", "failed", err);
      fail("failed");
    });
    worker.once("exit", (code) => {
      if (settled) return;
      report("extraction worker exited without a result", "failed", new Error(`exit ${code}`));
      fail("failed");
    });
  });
}
