/**
 * What one generic-IMAP poll may ask of, and accept from, a host the user chose
 * (step B4 review fix). Fixed-host providers (Naver, iCloud) are trusted servers and
 * keep their unbounded behaviour byte for byte; everything here applies to the
 * generic provider only.
 *
 *   - The message body is fetched as a slice of TEXT, not the whole thing: imapflow's
 *     `bodyParts` accepts `{ key, start, maxLength }` and sends it as
 *     `BODY.PEEK[TEXT]<0.N>` (imapflow lib/commands/fetch.js, the `bodyParts` branch;
 *     typed at lib/imap-flow.d.ts `FetchQueryObject.bodyParts`). The poll keeps at most
 *     50 000 characters of it, so 64 KiB is enough.
 *   - The poll stops consuming FETCH results at its window, so a server that keeps
 *     yielding messages cannot make one poll unbounded. imapflow drains and discards
 *     what is still in flight once the loop exits early (its `aborted` flag).
 */

import type { ImapProviderConfig } from "./imap-providers.js";

/** More than `toPersistCall` keeps of a body (50 000 characters), far less than a large mail. */
export const GENERIC_TEXT_FETCH_BYTES = 64 * 1024;

type TextBodyPart = string | { key: string; start: number; maxLength: number };

const isUserHost = (provider: ImapProviderConfig): boolean =>
  provider.hostPolicy === "user-supplied";

/** The TEXT part to request: whole for a fixed host (as always), a bounded slice for a user host. */
export function textBodyPart(provider: ImapProviderConfig): TextBodyPart {
  return isUserHost(provider)
    ? { key: "TEXT", start: 0, maxLength: GENERIC_TEXT_FETCH_BYTES }
    : "TEXT";
}

/** Has a user-host poll already consumed its whole window? Never true for a fixed host. */
export function fetchCapReached(
  provider: ImapProviderConfig,
  fetched: number,
  limit: number,
): boolean {
  return isUserHost(provider) && fetched >= limit;
}
