/**
 * Report a repeating generic-poll failure once, not on every tick (step B4 review
 * fix). The poll runs every five minutes per account, so an account that keeps
 * failing the same way would send Sentry hundreds of identical events a day. A
 * failure is reduced to a short kind; an account reports a kind once, and reports
 * again only when the kind changes or a poll has succeeded in between.
 *
 * In-process, like the other poll state: a restart re-reports once, which only errs
 * towards more visibility. Memory is bounded; past the cap the oldest account is
 * forgotten (it simply reports again).
 */

import { PinnedAddressError } from "./pinned-address.js";
import { isImapAuthFailure } from "./providers/imap-session.js";

export const MAX_TRACKED_POLL_FAILURES = 10_000;

/** A library error code worth keeping as a kind: short, letters digits and underscores only. */
const KIND_CODE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const GENERIC_KIND = "error";

/** What kind of failure this is: "auth", a refusal code, a library error code, or "error". */
export function pollFailureKind(err: unknown): string {
  if (err instanceof PinnedAddressError) return err.code;
  if (isImapAuthFailure(err)) return "auth";
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && KIND_CODE.test(code)) return code;
  return GENERIC_KIND;
}

/** rowId -> the kind last reported for it. */
const lastReported = new Map<string, string>();

/** True when this failure should be reported: the first of its kind for this account. */
export function shouldReportPollFailure(rowId: string, kind: string): boolean {
  if (lastReported.get(rowId) === kind) return false;
  if (!lastReported.has(rowId)) {
    for (const key of lastReported.keys()) {
      if (lastReported.size < MAX_TRACKED_POLL_FAILURES) break;
      lastReported.delete(key);
    }
  }
  lastReported.set(rowId, kind);
  return true;
}

/** A poll of this account succeeded: its next failure is news again. */
export function clearPollFailure(rowId: string): void {
  lastReported.delete(rowId);
}

/** Test hook. */
export function resetPollFailureState(): void {
  lastReported.clear();
}
