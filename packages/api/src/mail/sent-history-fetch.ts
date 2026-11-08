/**
 * The Gmail side of the Sent-history import (sent-history-import.ts): list the
 * window's ids, diff them against SentMessage, fetch headers for a batch.
 * Every call is bounded: a page cap and a run deadline on the listing, a
 * timeout on each request, two fetches in flight.
 */

import type { google } from "googleapis";
import { prisma } from "../db.js";
import { Semaphore } from "../semaphore.js";
import { isGoogleNotFoundError } from "./gmail.js";
import { clampSentField } from "./sent-fields.js";
import type { SentMessageInput } from "./sent-messages.js";

type Gmail = ReturnType<typeof google.gmail>;

export const SENT_HISTORY_WINDOW_DAYS = 365;
/** Newest sent mails considered per inbox (founder decision, 2026-11-01). */
export const SENT_HISTORY_CAP = 2_000;
/** Metadata fetches per run: one run per email-sync tick per user. */
export const SENT_HISTORY_BATCH = 100;
/** messages.list maximum; ids only, 5 quota units per page. */
const LIST_PAGE_SIZE = 500;
/** 4 full pages reach the cap; Gmail may return short pages, never more than this. */
const MAX_LIST_PAGES = 10;
/** In-flight metadata fetches per import: at most ~10 units/s at Gmail's latency. */
const GET_CONCURRENCY = 2;
/** Detached work: a hung request must not hold an import slot forever. */
const GMAIL_CALL_TIMEOUT_MS = 20_000;
const METADATA_HEADERS = ["To", "Subject", "Date"];
/** Only what a row needs: the snippet and labels never leave Google. */
const METADATA_FIELDS = "id,threadId,internalDate,payload/headers";
const DAY_MS = 86_400_000;

export type HistoryRow = Omit<SentMessageInput, "origin" | "inferredOrigin">;

export interface Listing {
  /** The oldest unrecorded ids of the capped window, at most SENT_HISTORY_BATCH. */
  missing: string[];
  /** Ids skipped because their fetch already failed too often. */
  exhausted: number;
  /** The whole capped window was listed and `missing` is all of what is left. */
  complete: boolean;
}

async function notRecorded(userId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const existing = await prisma.sentMessage.findMany({
    where: { userId, gmailId: { in: ids } },
    select: { gmailId: true },
  });
  const known = new Set(existing.map((r) => r.gmailId));
  return ids.filter((id) => !known.has(id));
}

/**
 * List the window's ids newest first (Gmail's order), stopping at the cap, and
 * return the oldest ones not recorded yet. Oldest first: where an unattended
 * reply and a manual one share a claim's window, the earlier is recorded
 * before the later is classified (the classifier's one-row-per-claim rule).
 */
export async function listMissing(
  gmail: Gmail,
  userId: string,
  opts: { now: number; deadline: number; isExhausted: (gmailId: string) => boolean },
): Promise<Listing> {
  const after = Math.floor((opts.now - SENT_HISTORY_WINDOW_DAYS * DAY_MS) / 1000);
  const unrecorded: string[] = [];
  let listed = 0;
  let pages = 0;
  let pageToken: string | undefined;
  let more = true;
  while (more) {
    if (pages === MAX_LIST_PAGES || Date.now() > opts.deadline) break;
    const res = await gmail.users.messages.list(
      {
        userId: "me",
        q: `in:sent after:${after}`,
        maxResults: Math.min(LIST_PAGE_SIZE, SENT_HISTORY_CAP - listed),
        ...(pageToken ? { pageToken } : {}),
      },
      { timeout: GMAIL_CALL_TIMEOUT_MS },
    );
    pages += 1;
    const ids = (res.data.messages ?? []).flatMap((m) => (m.id ? [m.id] : []));
    listed += ids.length;
    unrecorded.push(...(await notRecorded(userId, ids)));
    pageToken = res.data.nextPageToken ?? undefined;
    more = Boolean(pageToken) && listed < SENT_HISTORY_CAP;
  }
  const pending = unrecorded.filter((id) => !opts.isExhausted(id));
  return {
    missing: [...pending].reverse().slice(0, SENT_HISTORY_BATCH),
    exhausted: unrecorded.length - pending.length,
    complete: !more && pending.length <= SENT_HISTORY_BATCH,
  };
}

type FetchResult =
  | { kind: "row"; row: HistoryRow }
  | { kind: "gone" }
  | { kind: "failed"; id: string; error: unknown; lasting: boolean }
  | { kind: "undated"; id: string }
  | { kind: "skipped" };

/** 4xx that say "try later" or "this grant", not "this message": never counted. */
const TRANSIENT_4XX = new Set([401, 403, 408, 429]);

function httpStatus(err: unknown): number | undefined {
  const e = err as { response?: { status?: unknown }; code?: unknown } | null;
  const status = e?.response?.status ?? e?.code;
  return typeof status === "number" ? status : undefined;
}

/**
 * A failure that will repeat for this message: a 4xx other than auth, timeout
 * and rate limit (404/410 never get here). 5xx, 429, network errors and
 * timeouts are about Gmail or the grant, not the message.
 */
export function isLastingFetchFailure(err: unknown): boolean {
  const status = httpStatus(err);
  return status !== undefined && status >= 400 && status < 500 && !TRANSIENT_4XX.has(status);
}

export interface FetchOutcome {
  /** Rows before the first failure, undated message or unfetched id, in batch order. */
  rows: HistoryRow[];
  /** Ids that failed for good or had no usable date: one more failed attempt each. */
  countedIds: string[];
  /** The first transient fetch error, if any: the inbox pauses. */
  transientError: unknown;
  /** The first lasting fetch error, if any: reported, counted, no pause. */
  lastingError: unknown;
  /** Something in the batch was not imported: the inbox is not finished. */
  cut: boolean;
}

/**
 * Headers of each id, two at a time, oldest first. A message deleted since the
 * listing (404) is skipped. Any other failure, a message with no usable date,
 * or the run deadline stops the batch there: rows after that point are
 * dropped too, so the one-row-per-claim rule never sees a gap behind it.
 */
export async function fetchHeaders(
  gmail: Gmail,
  inbox: string,
  ids: string[],
  deadline: number,
): Promise<FetchOutcome> {
  const sem = new Semaphore(GET_CONCURRENCY);
  let stop = false;
  const results = await sem.all<FetchResult>(
    ids.map((id) => async () => {
      if (stop || Date.now() > deadline) {
        stop = true;
        return { kind: "skipped" };
      }
      try {
        const res = await gmail.users.messages.get(
          {
            userId: "me",
            id,
            format: "metadata",
            metadataHeaders: METADATA_HEADERS,
            fields: METADATA_FIELDS,
          },
          { timeout: GMAIL_CALL_TIMEOUT_MS },
        );
        const row = toHistoryRow(res.data, id, inbox);
        if (row) return { kind: "row", row };
        stop = true;
        return { kind: "undated", id };
      } catch (error) {
        if (isGoogleNotFoundError(error)) return { kind: "gone" };
        stop = true;
        return { kind: "failed", id, error, lasting: isLastingFetchFailure(error) };
      }
    }),
  );
  const cutAt = results.findIndex((r) => r.kind !== "row" && r.kind !== "gone");
  const kept = cutAt === -1 ? results : results.slice(0, cutAt);
  const failures = results.flatMap((r) => (r.kind === "failed" ? [r] : []));
  return {
    rows: kept.flatMap((r) => (r.kind === "row" ? [r.row] : [])),
    countedIds: results.flatMap((r) =>
      r.kind === "undated" || (r.kind === "failed" && r.lasting) ? [r.id] : [],
    ),
    transientError: failures.find((f) => !f.lasting)?.error ?? null,
    lastingError: failures.find((f) => f.lasting)?.error ?? null,
    cut: cutAt !== -1,
  };
}

interface MetadataMessage {
  id?: string | null;
  threadId?: string | null;
  internalDate?: string | null;
  payload?: { headers?: { name?: string | null; value?: string | null }[] } | null;
}

function header(message: MetadataMessage, name: string): string {
  const headers = message.payload?.headers ?? [];
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function validDate(ms: number): Date | null {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Gmail's internalDate; the Date header only when internalDate is missing
 * (null or "" — Number() of either is 0, the epoch). Neither usable: null,
 * and the row is not recorded at the epoch. The folder listing the Sent scan
 * reads (gmail-mailbox.ts) uses this too, so import and scan write the same
 * sentAt.
 */
export function sentAtOf(message: MetadataMessage): Date | null {
  const internal = message.internalDate;
  if (internal !== null && internal !== undefined && internal.trim() !== "") {
    const date = validDate(Number(internal));
    if (date) return date;
  }
  const dateHeader = header(message, "Date");
  return dateHeader ? validDate(Date.parse(dateHeader)) : null;
}

function toHistoryRow(message: MetadataMessage, id: string, inbox: string): HistoryRow | null {
  const sentAt = sentAtOf(message);
  if (!sentAt) return null;
  return {
    gmailId: message.id ?? id,
    threadId: message.threadId ?? null,
    to: clampSentField(header(message, "To")),
    subject: clampSentField(header(message, "Subject")),
    sentAt,
    inbox,
  };
}
