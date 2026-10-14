/**
 * Reading a file's bytes for its summary (step D4 of
 * docs/providers/unified-platform-plan.md) with the size cap checked while the
 * bytes stream, never after: a file that runs past the cap stops being read at
 * the chunk that crosses it, and the source is released (leaving a `for await`
 * early destroys a Node stream). A declared size is only a claim; this counter
 * is what holds the cap.
 *
 * The Klorn drive reads through D1's user-scoped storage (`get` refuses a key
 * outside the user's prefix); a connector (D5, D6) implements
 * `DriveProviderSession.fetchForSummary` with `readCappedBytes` underneath.
 */

import { getUserStorage } from "../storage/runtime.js";

export type CappedBytes =
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly reason: "too-large" };

/** Collect at most `maxBytes` from `source`; stop and answer `too-large` past it. */
export async function readCappedBytes(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<CappedBytes> {
  const chunks: Buffer[] = [];
  let seen = 0;
  for await (const chunk of source) {
    seen += chunk.byteLength;
    if (seen > maxBytes) return { ok: false, reason: "too-large" };
    chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  }
  return { ok: true, bytes: Buffer.concat(chunks, seen) };
}

export type KlornBytesResult =
  | CappedBytes
  | { readonly ok: false; readonly reason: "storage-unavailable" | "object-missing" };

/**
 * A Klorn file's bytes, capped. `storage-unavailable` while object storage is
 * off; `object-missing` when the key holds nothing. A storage failure throws
 * (the caller maps it to a retry).
 */
export async function readKlornBytesForSummary(
  userId: string,
  storageKey: string,
  maxBytes: number,
): Promise<KlornBytesResult> {
  const storage = await getUserStorage();
  if (storage === null) return { ok: false, reason: "storage-unavailable" };
  const stored = await storage.get(userId, storageKey);
  if (stored === null) return { ok: false, reason: "object-missing" };
  if (stored.size > maxBytes) {
    stored.body.destroy();
    return { ok: false, reason: "too-large" };
  }
  return await readCappedBytes(stored.body, maxBytes);
}
