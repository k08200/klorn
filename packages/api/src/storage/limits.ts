/**
 * Storage limits (step D1 of docs/providers/unified-platform-plan.md). Every
 * number has a name here, and every store implementation enforces them through
 * these helpers, so the in-memory fake and the real bucket cannot disagree.
 */

import { StorageError } from "./errors.js";

/**
 * The most one object may hold. 25 MiB is the only size the plan has decided
 * (L14, 25 MB per message). A caller may pass a LOWER cap; nothing raises it.
 * The Klorn drive's own number is a flip-time decision (P3) and changes this
 * constant in its own step.
 */
export const MAX_OBJECT_BYTES = 25 * 1024 * 1024;

/** The longest a signed download URL may live. A link is minted per click. */
export const MAX_SIGNED_URL_EXPIRY_SECONDS = 300;

/**
 * The content type every signed download answers with, whatever was stored.
 * Together with `Content-Disposition: attachment` it keeps a stored HTML or SVG
 * file from rendering as a page on the storage origin.
 */
export const SIGNED_DOWNLOAD_CONTENT_TYPE = "application/octet-stream";

/** RFC 6838 restricted-name, lower-cased: `type/subtype`. */
const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/** Throws unless `size` is a whole number of bytes from 0 to `maxBytes`. */
export function assertUploadSize(size: number, maxBytes: number): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new StorageError("invalid-size", "object size must be a whole number of bytes");
  }
  if (size > maxBytes) {
    throw new StorageError(
      "object-too-large",
      `object size ${size} is over the ${maxBytes} byte cap`,
    );
  }
}

export interface ByteGuardOptions {
  /** What the caller said the object holds; sent as Content-Length. */
  declaredSize: number;
  /** The cap in force for this upload. */
  maxBytes: number;
}

/**
 * Count the bytes of an upload as they pass. The stream fails the moment it
 * runs past the cap or past its declared size, before the offending chunk is
 * handed on, and fails at the end if it came up short. The declared size is
 * only a claim; this counter is what holds the cap.
 *
 * The chunk that COMPLETES the declared size is held back until the source has
 * ended. Handing it on at once would give the bucket a whole body of the
 * declared length, which it commits, while a source that then sends more makes
 * the caller see a failed upload.
 */
export async function* guardBytes(
  source: AsyncIterable<Uint8Array>,
  options: ByteGuardOptions,
): AsyncGenerator<Uint8Array> {
  const { declaredSize, maxBytes } = options;
  let seen = 0;
  let held: Uint8Array | null = null;
  for await (const chunk of source) {
    if (chunk.byteLength === 0) continue;
    seen += chunk.byteLength;
    if (seen > maxBytes) {
      throw new StorageError("object-too-large", `upload ran past the ${maxBytes} byte cap`);
    }
    if (seen > declaredSize) {
      throw new StorageError("size-mismatch", "upload is longer than its declared size");
    }
    if (seen === declaredSize) held = chunk;
    else yield chunk;
  }
  if (seen !== declaredSize) {
    throw new StorageError("size-mismatch", "upload is shorter than its declared size");
  }
  if (held) yield held;
}

/** `type/subtype`, lower-cased, parameters dropped; null when it is not a media type. */
export function mediaTypeOf(value: unknown): string | null {
  const essence = typeof value === "string" ? (value.split(";")[0] ?? "").trim().toLowerCase() : "";
  return MEDIA_TYPE_PATTERN.test(essence) ? essence : null;
}

/**
 * The media type of an upload. Throws for anything that is not one, which also
 * keeps a line break out of a request header.
 */
export function normalizeContentType(value: string): string {
  const mediaType = mediaTypeOf(value);
  if (mediaType === null) {
    throw new StorageError("invalid-content-type", "content type is not a media type");
  }
  return mediaType;
}

/**
 * Decides whether an upload of this (normalised) content type goes ahead. The
 * storage module has no opinion: each caller passes the policy for its purpose.
 */
export type ContentTypePolicy = (contentType: string) => boolean;

/** For a caller that has decided any type may be stored. Say so explicitly. */
export const allowAnyContentType: ContentTypePolicy = () => true;

function matchesAny(contentType: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith("*") ? contentType.startsWith(pattern.slice(0, -1)) : contentType === pattern,
  );
}

/** Admit only the listed types. An entry ending in `*` matches by prefix (`image/*`). */
export function allowContentTypes(patterns: readonly string[]): ContentTypePolicy {
  const list = patterns.map((pattern) => pattern.toLowerCase());
  return (contentType) => matchesAny(contentType, list);
}

/** Admit every type except the listed ones. Same pattern rules as the allow list. */
export function denyContentTypes(patterns: readonly string[]): ContentTypePolicy {
  const list = patterns.map((pattern) => pattern.toLowerCase());
  return (contentType) => !matchesAny(contentType, list);
}

/** Throws unless the expiry is a whole number of seconds from 1 to the cap. */
export function assertSignedUrlExpiry(expiresInSeconds: number): void {
  if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 1) {
    throw new StorageError("invalid-expiry", "signed URL expiry must be a positive whole number");
  }
  if (expiresInSeconds > MAX_SIGNED_URL_EXPIRY_SECONDS) {
    throw new StorageError(
      "expiry-too-long",
      `signed URL expiry ${expiresInSeconds}s is over the ${MAX_SIGNED_URL_EXPIRY_SECONDS}s cap`,
    );
  }
}
