/**
 * Worker-thread entry for attachment text extraction
 * (attachment-extract-isolated.ts). Runs the in-process extractor on the bytes
 * it is handed and posts the result back once.
 */

import { parentPort, workerData } from "node:worker_threads";
import { extractAttachmentContent } from "./email-attachment-text.js";

export interface AttachmentExtractJob {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}

const { job } = workerData as { job: AttachmentExtractJob };
const buffer = Buffer.from(job.bytes.buffer, job.bytes.byteOffset, job.bytes.byteLength);
parentPort?.postMessage(extractAttachmentContent(buffer, job.filename, job.mimeType));
