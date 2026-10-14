/**
 * The one error the Klorn drive's operations throw (step D3 of
 * docs/providers/unified-platform-plan.md). The route maps `code` to a status
 * and sends `{ error, code, retryable }`; the message is written for the person
 * and never names a key, a path or another user's anything.
 */

import type { DriveErrorCode } from "@klorn/contract";

export const KLORN_DRIVE_ERROR_STATUS: Readonly<Record<DriveErrorCode, number>> = {
  "invalid-upload": 400,
  "invalid-name": 400,
  "not-found": 404,
  "parent-not-found": 404,
  "read-only": 409,
  "is-folder": 409,
  cycle: 409,
  "too-deep": 409,
  "folder-too-large": 409,
  "account-purging": 409,
  "too-large": 413,
  "quota-exceeded": 413,
  "storage-unavailable": 503,
};

const MESSAGES: Readonly<Record<DriveErrorCode, string>> = {
  "invalid-upload": "The upload could not be read.",
  "invalid-name": "That name cannot be used.",
  "not-found": "File not found",
  "parent-not-found": "Folder not found",
  "read-only": "This file belongs to another service and is read-only in Klorn.",
  "is-folder": "A folder cannot be downloaded.",
  cycle: "A folder cannot be moved into itself or one of its own folders.",
  "too-deep": "Folders cannot be nested that deep.",
  "folder-too-large": "This folder holds too many items to do this at once.",
  "account-purging": "Your files are being deleted. Try again later.",
  "too-large": "The file is larger than the upload limit.",
  "quota-exceeded": "Your drive is full.",
  "storage-unavailable": "File storage is unavailable. Try again later.",
};

export class KlornDriveError extends Error {
  readonly code: DriveErrorCode;
  readonly retryable: boolean;

  constructor(code: DriveErrorCode, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(MESSAGES[code], options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "KlornDriveError";
    this.code = code;
    this.retryable = options.retryable ?? code === "storage-unavailable";
  }
}
