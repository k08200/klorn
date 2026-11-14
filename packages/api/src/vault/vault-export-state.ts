/**
 * The state one Klorn Vault export builds up as it streams (vault-export.ts):
 * what was emitted so far, so later notes only ever link to notes that are
 * in the archive. Local to one request; never shared, never stored.
 */

import type { VaultSummary } from "./vault-index-notes.js";
import type { VaultLimits } from "./vault-limits.js";
import type { VaultMailRef } from "./vault-notes.js";
import { PathRegistry } from "./vault-paths.js";
import { ZipWriter } from "./zip-writer.js";

export interface VaultExportInput {
  userId: string;
  includeBodies: boolean;
  /** The reader's language, for lane reasons stored as keys. */
  language: string;
  timeZone: string;
  now: Date;
  limits: VaultLimits;
}

/** Updated as the archive streams; the route audits it when the stream ends. */
export interface VaultExportProgress {
  notes: number;
  bytes: number;
  partial: boolean;
}

export interface ExportState {
  input: VaultExportInput;
  zip: ZipWriter;
  paths: PathRegistry;
  /** Mail notes emitted, in emission order (newest first). */
  refs: VaultMailRef[];
  /** Emitted mail notes by Gmail message id, newest per thread, and their subjects. */
  pathByGmailId: Map<string, string>;
  pathByThread: Map<string, string>;
  subjectByPath: Map<string, string>;
  /** Emitted sender notes by sender key. */
  senderPathByKey: Map<string, string>;
  /** Threads whose brief is already placed (on their newest mail note). */
  briefedThreads: Set<string>;
  mailBytes: number;
  /** Time spent reading and rendering mail, not waiting on the client. */
  workMs: number;
  skippedMails: number;
  partial: VaultSummary["partial"];
}

export type Emit = (path: string, text: string) => Buffer;

export function newVaultProgress(): VaultExportProgress {
  return { notes: 0, bytes: 0, partial: false };
}

export function newExportState(input: VaultExportInput): ExportState {
  return {
    input,
    zip: new ZipWriter(input.now),
    paths: new PathRegistry(),
    refs: [],
    pathByGmailId: new Map(),
    pathByThread: new Map(),
    subjectByPath: new Map(),
    senderPathByKey: new Map(),
    briefedThreads: new Set(),
    mailBytes: 0,
    workMs: 0,
    skippedMails: 0,
    partial: { mails: null, commitments: false, senderTraits: false },
  };
}

/** Groups into a map the caller owns (a local accumulator: linear, not copy-per-row). */
export function appendTo<T>(groups: Map<string, T[]>, key: string, value: T): void {
  const list = groups.get(key);
  if (list) list.push(value);
  else groups.set(key, [value]);
}
