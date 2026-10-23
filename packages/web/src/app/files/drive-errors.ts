/**
 * A failed Klorn drive request (D3's web UI step) as the message the person
 * reads. The API answers `{ error, code, retryable }` (contract DriveErrorCode,
 * api drive/klorn-errors.ts); the page branches on `code` and never shows the
 * server's English `error`. apiFetch throws "API <status>: <body>", so the code
 * is read back out of that text, and only a code this table knows is trusted.
 */

import type { DriveErrorCode } from "@klorn/contract";

const CODE_KEYS = {
  "invalid-upload": "files.drive.error.invalidUpload",
  "invalid-name": "files.drive.error.invalidName",
  "multipart-malformed": "files.drive.error.malformed",
  "not-found": "files.drive.error.notFound",
  "parent-not-found": "files.drive.error.parentNotFound",
  "read-only": "files.drive.error.readOnly",
  "is-folder": "files.drive.error.isFolder",
  cycle: "files.drive.error.cycle",
  "too-deep": "files.drive.error.tooDeep",
  "folder-too-large": "files.drive.error.folderTooLarge",
  "account-purging": "files.drive.error.purging",
  "too-large": "files.drive.error.tooLarge",
  "quota-exceeded": "files.drive.error.full",
  "rate-limited": "files.drive.error.rateLimited",
  "quota-not-configured": "files.drive.error.notConfigured",
  "storage-unavailable": "files.drive.error.storage",
} as const satisfies Record<DriveErrorCode, string>;

/**
 * Answers that carry no drive code: the route is dark, the session is over
 * (requireAuth's 401, with or without its own `code`), offline, or anything else.
 */
const FALLBACK_KEYS = {
  unavailable: "files.drive.error.unavailable",
  signedOut: "files.drive.error.signedOut",
  offline: "files.drive.error.offline",
  generic: "files.drive.error.generic",
} as const;

export type DriveMessageKey =
  | (typeof CODE_KEYS)[DriveErrorCode]
  | (typeof FALLBACK_KEYS)[keyof typeof FALLBACK_KEYS];

/** Every key driveErrorKey can answer, for the locale guard. */
export const DRIVE_MESSAGE_KEYS: readonly DriveMessageKey[] = [
  ...Object.values(CODE_KEYS),
  ...Object.values(FALLBACK_KEYS),
];

const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_LARGE = 413;
const HTTP_TOO_MANY = 429;
const HTTP_UNAVAILABLE = 503;

/** A status the body did not explain, read the way the server would have coded it. */
const STATUS_KEYS: Readonly<Record<number, DriveMessageKey>> = {
  [HTTP_UNAUTHORIZED]: FALLBACK_KEYS.signedOut,
  [HTTP_NOT_FOUND]: FALLBACK_KEYS.unavailable,
  [HTTP_TOO_LARGE]: CODE_KEYS["too-large"],
  [HTTP_TOO_MANY]: CODE_KEYS["rate-limited"],
  [HTTP_UNAVAILABLE]: CODE_KEYS["storage-unavailable"],
};

interface DriveFailure {
  status: number | null;
  code: DriveErrorCode | null;
}

function isDriveErrorCode(value: unknown): value is DriveErrorCode {
  return typeof value === "string" && Object.hasOwn(CODE_KEYS, value);
}

/** The body's `code`, only when it is JSON and the code is a drive code. */
function bodyCode(body: string): DriveErrorCode | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return null;
    const code = (parsed as { code?: unknown }).code;
    return isDriveErrorCode(code) ? code : null;
  } catch {
    return null;
  }
}

/** The status and code out of apiFetch's "API <status>: <body>" error. */
function driveFailure(err: unknown): DriveFailure {
  const message = err instanceof Error ? err.message : "";
  const match = /^API (\d{3}): ([\s\S]*)$/.exec(message);
  if (!match) return { status: null, code: null };
  return { status: Number(match[1]), code: bodyCode(match[2] ?? "") };
}

/**
 * What fetch rejects with when the request got no answer, in each engine's
 * words (Chromium, Firefox, WebKit, the React Native and Node fetches). Any
 * other TypeError is a bug in the page, not the network.
 */
const NETWORK_FAILURE_MESSAGES: ReadonlySet<string> = new Set([
  "Failed to fetch",
  "NetworkError when attempting to fetch resource.",
  "Load failed",
  "Network request failed",
  "fetch failed",
]);

function isNetworkFailure(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  if (NETWORK_FAILURE_MESSAGES.has(err.message)) return true;
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/** The message key for a failed drive request. */
export function driveErrorKey(err: unknown): DriveMessageKey {
  if (isNetworkFailure(err)) return FALLBACK_KEYS.offline;
  const { status, code } = driveFailure(err);
  if (code !== null) return CODE_KEYS[code];
  if (status === null) return FALLBACK_KEYS.generic;
  return STATUS_KEYS[status] ?? FALLBACK_KEYS.generic;
}

/**
 * The drive is off for this person: a 404 with no drive code, which is
 * Fastify's default answer of a dark route (the flag is off, or the person is
 * not in the rollout). A drive 404 (`not-found`) is about one row instead.
 */
export function isDriveOff(err: unknown): boolean {
  const { status, code } = driveFailure(err);
  return status === HTTP_NOT_FOUND && code === null;
}

/** A failure worth reporting: not the person's news (a full drive, a bad name). */
export function isUnexpectedDriveError(key: DriveMessageKey): boolean {
  return key === FALLBACK_KEYS.generic;
}
