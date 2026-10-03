/**
 * DriveProviderActions — the provider-agnostic surface of a drive source (step
 * D2 of docs/providers/unified-platform-plan.md; mirrors
 * pim/calendar-providers/types.ts).
 *
 * v1 of an external connector reads only (decision V4): it lists a folder,
 * searches by name and reads one file's metadata. There is no method that changes
 * anything in the source, and none that fetches a file's bytes: reading content
 * for a summary arrives with D4, which adds it together with a streaming size
 * check. drive-provider-dispatch.test.ts fails if a method is added here.
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
 *
 * Two rules for a connector (D5, D6): `connect` must check that the `sourceKey`
 * it is given names an account of that user, and it must never fetch a URL the
 * provider supplied (a download link, a thumbnail, a redirect) unless the host is
 * on an allowlist of that provider's own hosts.
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
  /** The folder to list; null lists the source's root, as the PROVIDER defines it. */
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
  /** Null when the provider names no parent, or one this grant cannot see. */
  readonly parentExternalId: string | null;
  readonly modifiedAt: Date;
  readonly webUrl: string | null;
  /** The provider's own version of the file (etag, version, content hash); null when it has none. */
  readonly etag: string | null;
  readonly trashed: boolean;
}

export interface ProviderDrivePage {
  readonly files: ProviderDriveFile[];
  /** Null on the last page. */
  readonly nextPageToken: string | null;
}

export interface DriveProviderSession {
  readonly provider: DriveProviderName;
  list(query: DriveListQuery): Promise<ProviderDrivePage>;
  search(query: DriveSearchQuery): Promise<ProviderDrivePage>;
  /** Null when the source has no such file. */
  getMetadata(externalId: string): Promise<ProviderDriveFile | null>;
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
