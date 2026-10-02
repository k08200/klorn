/**
 * Reading the reply headers of an IMAP message (step B3 of
 * docs/providers/unified-platform-plan.md): the original's Message-ID and its
 * References chain, for the In-Reply-To and References of the answer.
 *
 * The header block is untrusted server text. It is parsed only as far as two
 * header values, and those go through `mail/reply-headers.ts`, which keeps
 * message ids and discards every other character. Only ids cross the seam.
 */

import type { ImapFlow } from "imapflow";

import { extractMessageIds, pickInReplyTo } from "../reply-headers.js";
import type { ReplyHeadersResult } from "./types.js";

/** The fetch asks for two headers; anything beyond this many bytes is not read. */
export const MAX_HEADER_BLOCK_BYTES = 64 * 1024;

const INBOX = "INBOX";
const HEADER_LINE_BREAK = /\r?\n/;

function isContinuation(line: string): boolean {
  return line.startsWith(" ") || line.startsWith("\t");
}

/**
 * Header fields of a raw header block, names lower-cased, folded lines joined
 * with one space, the first occurrence of a repeated name winning. Reading stops
 * at the blank line that ends the block. Anything that is not a Buffer yields no
 * fields.
 */
export function parseHeaderFields(block: unknown): Map<string, string> {
  const fields = new Map<string, string>();
  if (!Buffer.isBuffer(block)) return fields;

  const lines = block
    .subarray(0, MAX_HEADER_BLOCK_BYTES)
    .toString("utf-8")
    .split(HEADER_LINE_BREAK);
  let filling: string | null = null;
  for (const line of lines) {
    if (line === "") break;
    if (isContinuation(line)) {
      if (filling !== null) fields.set(filling, `${fields.get(filling)} ${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(":");
    const name = colon > 0 ? line.slice(0, colon).trim().toLowerCase() : "";
    if (name === "" || fields.has(name)) {
      filling = null;
      continue;
    }
    fields.set(name, line.slice(colon + 1).trim());
    filling = name;
  }
  return fields;
}

/** `{ messageId, references }` from a raw header block: parsed ids, absent when none. */
export function replyHeadersFromBlock(block: unknown): ReplyHeadersResult {
  const fields = parseHeaderFields(block);
  const messageId = pickInReplyTo(fields.get("message-id"));
  const references = extractMessageIds(fields.get("references"));
  return {
    ...(messageId !== undefined ? { messageId } : {}),
    ...(references.length > 0 ? { references: references.join(" ") } : {}),
  };
}

/** Fetch the two headers of the INBOX message with this UID. `{}` when it is gone. */
export async function fetchReplyHeaders(
  client: ImapFlow,
  uid: number,
): Promise<ReplyHeadersResult> {
  const lock = await client.getMailboxLock(INBOX);
  try {
    const message = await client.fetchOne(
      String(uid),
      { headers: ["message-id", "references"] },
      { uid: true },
    );
    return message ? replyHeadersFromBlock(message.headers) : {};
  } finally {
    lock.release();
  }
}
