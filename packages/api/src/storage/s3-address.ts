/**
 * Where a bucket and an object live (step D1 of
 * docs/providers/unified-platform-plan.md). The host and the bucket come from
 * the operator's config; the key becomes path segments and nothing else.
 *
 * A key this code minted needs no escaping. A purge also deletes keys it did
 * not mint (anything under the user's prefix), so every segment is
 * percent-encoded, and the URL that comes out is checked: decoded, its path
 * must be exactly the bucket path followed by the key. A key with a `..`, a `.`
 * or an empty segment fails that check, because every URL parser rewrites such
 * a path, and the request would land on a different object.
 */

import { StorageError } from "./errors.js";
import type { S3StoreConfig } from "./s3-config.js";

/** RFC 3986 unreserved characters only; `encodeURIComponent` leaves `!'()*`. */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** The bucket's URL: the target of a list call. */
export function bucketUrlOf(config: S3StoreConfig): URL {
  const url = new URL(config.endpoint);
  const basePath = url.pathname.replace(/\/+$/, "");
  if (config.forcePathStyle) {
    url.pathname = `${basePath}/${config.bucket}`;
  } else {
    url.hostname = `${config.bucket}.${url.hostname}`;
    url.pathname = basePath || "/";
  }
  return url;
}

function unaddressable(): StorageError {
  return new StorageError("invalid-key", "object key cannot be addressed safely over HTTP");
}

/** The URL of one object. Throws `invalid-key` when the key cannot be addressed safely. */
export function objectUrlOf(config: S3StoreConfig, key: string): URL {
  const url = bucketUrlOf(config);
  const bucketPath = url.pathname.replace(/\/+$/, "");
  let encodedKey: string;
  try {
    encodedKey = key.split("/").map(encodeSegment).join("/");
  } catch {
    // encodeURIComponent refuses a lone surrogate.
    throw unaddressable();
  }
  url.pathname = `${bucketPath}/${encodedKey}`;
  let addressed: string;
  try {
    addressed = decodeURIComponent(url.pathname);
  } catch {
    throw unaddressable();
  }
  if (addressed !== `${decodeURIComponent(bucketPath)}/${key}`) throw unaddressable();
  return url;
}

/** True when `objectUrlOf` can build a URL that addresses exactly this key. */
export function isAddressableKey(config: S3StoreConfig, key: string): boolean {
  try {
    objectUrlOf(config, key);
    return true;
  } catch (err) {
    if (err instanceof StorageError && err.code === "invalid-key") return false;
    throw err;
  }
}
