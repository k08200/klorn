/**
 * DriveProviderActions — the provider-agnostic surface of a drive source (step
 * D2 of docs/providers/unified-platform-plan.md; mirrors
 * pim/calendar-providers/types.ts).
 *
 * v1 of an external connector reads only (decision V4): it lists a folder,
 * searches by name, reads one file's metadata and fetches one file's bytes for a
 * summary, under a size cap. There is no method that changes anything in the
 * source, and drive-provider-dispatch.test.ts fails if one is added here.
 *
 * Shape: `connect` resolves a source's credentials ONCE and answers a session
 * bound to them.
 *
 * Result contract, in caller-priority order:
 *   - `{ unsupported: true }` from `connect` - this provider has no drive
 *     implementation, or its flag is off. Callers refuse loudly; they must NOT
 *     read it as "not connected".
 *   - `null` from `connect` - the source is not connected (no grant, a stale id,
 *     an undecryptable token).
 *   - a session - its methods resolve with data and THROW on a hard failure
 *     (network, 4xx/5xx). Each caller owns its error policy.
 *
 * Everything a session returns is what the source said, uncleaned. A row is
 * written only through drive/drive-rows.ts, which cleans it, and a name reaches
 * a model only inside `wrapUntrusted`.
 */

import type { DriveProviderName } from "../drive-providers.js";

/** Which source an operation targets: its user and the `sourceKey` of its rows. */
export interface DriveSourceRef {
  readonly userId: string;
  readonly sourceKey: string;
}

export type DriveUnsupported = { unsupported: true; error: string };

interface DrivePageQuery {
  /** At most this many files. */
  readonly pageSize: number;
  /** The provider's own continuation token from the previous page; opaque. */
  readonly pageToken?: string;
}

export interface DriveListQuery extends DrivePageQuery {
  /** The folder to list; null lists the source's root. */
  readonly parentExternalId: string | null;
}

export interface DriveSearchQuery extends DrivePageQuery {
  /** Matched against file names. */
  readonly text: string;
}

/** One file or folder of a source, as the provider reported it. */
export interface ProviderDriveFile {
  /** The id in the source; '' when the provider sent none. */
  readonly externalId: string;
  readonly name: string;
  readonly mimeType: string | null;
  readonly isFolder: boolean;
  readonly sizeBytes: number | null;
  readonly parentExternalId: string | null;
  readonly modifiedAt: Date;
  readonly webUrl: string | null;
  readonly trashed: boolean;
}

export interface ProviderDrivePage {
  readonly files: ProviderDriveFile[];
  /** Null on the last page. */
  readonly nextPageToken: string | null;
}

/**
 * The most bytes of one file a summary may read: what the attachment analysis
 * pipeline D4 reuses accepts (mail/email-attachment-text.ts,
 * mail/vision-attachment-policy.ts). The dispatcher enforces it on every session.
 */
export const DRIVE_SUMMARY_MAX_BYTES = 8_000_000;

export interface DriveSummaryFetchOptions {
  /** The caller's own limit; the dispatcher clamps it to DRIVE_SUMMARY_MAX_BYTES. */
  readonly maxBytes: number;
}

/**
 * A file's bytes for a summary, or why there are none. A connector checks the
 * size BEFORE it downloads and answers `too-large` instead of reading past
 * `maxBytes`; `unavailable` covers a file that is gone or has no readable form.
 */
export type DriveSummaryResult =
  | { readonly kind: "content"; readonly bytes: Uint8Array; readonly mimeType: string | null }
  | { readonly kind: "too-large"; readonly sizeBytes: number | null }
  | { readonly kind: "unavailable" };

export interface DriveProviderSession {
  readonly provider: DriveProviderName;
  list(query: DriveListQuery): Promise<ProviderDrivePage>;
  search(query: DriveSearchQuery): Promise<ProviderDrivePage>;
  /** Null when the source has no such file. */
  getMetadata(externalId: string): Promise<ProviderDriveFile | null>;
  fetchForSummary(
    externalId: string,
    options: DriveSummaryFetchOptions,
  ): Promise<DriveSummaryResult>;
}

export interface DriveProviderActions {
  readonly provider: DriveProviderName;
  connect(source: DriveSourceRef): Promise<DriveProviderSession | DriveUnsupported | null>;
}

/** True when `connect` answered the explicit unsupported result. */
export function isDriveUnsupported(
  result: DriveProviderSession | DriveUnsupported | null,
): result is DriveUnsupported {
  return result !== null && "unsupported" in result;
}
