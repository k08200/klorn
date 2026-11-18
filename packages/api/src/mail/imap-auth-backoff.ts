/**
 * Back off a refused IMAP login, then stop (follow-up to #1756).
 *
 * The poll used to send a fixed-host mailbox's stored app password (Naver,
 * iCloud, the app-password presets) every five minutes, whatever the last
 * login answered: once revoked, the password was refused 288 times a day, and
 * providers such as Yahoo, Daum and Naver lock or challenge an account after
 * repeated failures. Now each consecutive refusal waits longer before the next
 * login (15 min, 1 h, 6 h after the 1st, 2nd and 3rd), and the 4th stops the
 * poll until the user reconnects.
 *
 * Why four. The first refusal already flags the row for reconnect and alerts
 * the user (imap-accounts.ts `flagForReconnect`), so the later logins exist
 * only to recover by themselves from a refusal that was the provider's fault.
 * Four refusals over about 7¼ hours ride out a provider-side login outage of
 * several hours, and stay under five consecutive failures, where providers
 * commonly start challenging or locking an account. Three would give up after
 * 1¼ hours.
 *
 * Only a refusal of the credentials counts (sync-error-code.ts
 * `isCredentialRefusal`). A refusal for the moment (RFC 5530 UNAVAILABLE,
 * LIMIT, INUSE, SERVERBUG) or a network failure says nothing about the
 * password: it keeps today's schedule and neither advances nor resets the
 * count.
 *
 * Persisted on the row (LinkedInboxAccount.imapAuthFailures, imapAuthRetryAt),
 * so a restart or a deploy does not forget it and log in again at once. A
 * login that works (imap-accounts.ts) and a reconnect with a new password
 * (routes/imap-connect.ts) start over. The stop asks for the reconnect alert
 * once more (imap-accounts.ts; keyed by the stop, so it is not swallowed by the
 * 1st refusal's alert of the same UTC day), and
 * the mail actions and the undo re-ingest refuse a stopped row without
 * connecting (providers/imap-account.ts `findCheckedAccount`); while the poll is
 * only waiting, an action may still try, under its own 15-minute cooldown.
 */

import { prisma } from "../db.js";
import { logDbFailure } from "../report-db-failure.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** The wait before the next login after the 1st, 2nd and 3rd consecutive refusal. */
export const IMAP_AUTH_RETRY_DELAYS_MS: readonly number[] = [15 * MINUTE_MS, HOUR_MS, 6 * HOUR_MS];

/** The consecutive refusal that stops the poll until the user reconnects. */
export const IMAP_AUTH_FAILURE_LIMIT = IMAP_AUTH_RETRY_DELAYS_MS.length + 1;

/** The persisted backoff of one mailbox. */
export interface AuthBackoffState {
  imapAuthFailures: number;
  imapAuthRetryAt: Date | null;
}

/** No refusal on record: what a working login and a reconnect write. */
export const AUTH_BACKOFF_CLEARED: Readonly<AuthBackoffState> = Object.freeze({
  imapAuthFailures: 0,
  imapAuthRetryAt: null,
});

/** A stored count, or 0 for a row that has none (or a value that is not a count). */
function storedFailures(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** The state after one more consecutive refusal, from `failuresBefore`, at `now`. */
export function nextAuthBackoff(failuresBefore: number, now: Date): AuthBackoffState {
  const failures = Math.min(storedFailures(failuresBefore) + 1, IMAP_AUTH_FAILURE_LIMIT);
  const delay = IMAP_AUTH_RETRY_DELAYS_MS[failures - 1];
  return {
    imapAuthFailures: failures,
    imapAuthRetryAt: delay === undefined ? null : new Date(now.getTime() + delay),
  };
}

export type AuthBackoffVerdict = "poll" | "wait" | "stopped";

/** May the poll log in to this mailbox now? */
export function authBackoffVerdict(
  row: { imapAuthFailures?: number | null; imapAuthRetryAt?: Date | null },
  now: Date,
): AuthBackoffVerdict {
  const failures = storedFailures(row.imapAuthFailures);
  if (failures >= IMAP_AUTH_FAILURE_LIMIT) return "stopped";
  if (failures > 0 && row.imapAuthRetryAt && now < row.imapAuthRetryAt) return "wait";
  return "poll";
}

/**
 * Record one more refused login of the user's own mailbox. Written only against
 * the password the poll used and the count it read: a user who reconnected
 * meanwhile has a new password, which this refusal says nothing about, and a
 * count another writer changed is not counted twice. Resolves with the state
 * written, or null when nothing was. Best-effort: never throws.
 */
export async function recordImapAuthRefusal(args: {
  userId: string;
  rowId: string;
  passwordCipher: string;
  failuresBefore: number | null | undefined;
  now: Date;
}): Promise<AuthBackoffState | null> {
  const { userId, rowId, passwordCipher, now } = args;
  const failuresBefore = storedFailures(args.failuresBefore);
  const next = nextAuthBackoff(failuresBefore, now);
  try {
    const { count } = await prisma.linkedInboxAccount.updateMany({
      where: {
        id: rowId,
        userId,
        imapPasswordCipher: passwordCipher,
        imapAuthFailures: failuresBefore,
      },
      data: next,
    });
    return count > 0 ? next : null;
  } catch (err) {
    logDbFailure("[imap] could not record the refused login", err, { ids: { rowId } });
    return null;
  }
}
