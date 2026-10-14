/**
 * Object keys (step D1 of docs/providers/unified-platform-plan.md).
 *
 *   u/<userId>/<purpose>/<uuid>
 *
 * Every part is chosen by the server. The user id comes from the session, the
 * purpose is one of a fixed enum, and the last segment is a fresh UUID. Nothing
 * a client sends is ever a path segment: a display file name is metadata that a
 * later step stores in the database, never part of a key.
 *
 * The grammar is strict on purpose. A key that does not match it is refused
 * before any request is built, so `..`, `%2F`, a query string or a second
 * bucket path cannot reach the storage vendor through a key.
 */

import { randomUUID } from "node:crypto";
import { StorageError } from "./errors.js";

/** What an object is for. Adding a purpose is a code change, never an input. */
export const STORAGE_PURPOSES = ["drive", "attachment"] as const;
export type StoragePurpose = (typeof STORAGE_PURPOSES)[number];

const KEY_ROOT = "u";
const USER_ID_SOURCE = "[A-Za-z0-9_-]{1,64}";
const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PURPOSE_SOURCE = STORAGE_PURPOSES.join("|");

const USER_ID_PATTERN = new RegExp(`^${USER_ID_SOURCE}$`);
// `$` alone would also match before a trailing newline; `(?![\s\S])` does not.
const KEY_PATTERN = new RegExp(
  `^${KEY_ROOT}/(${USER_ID_SOURCE})/(${PURPOSE_SOURCE})/(${UUID_SOURCE})(?![\\s\\S])`,
);
const DELETABLE_PREFIX_PATTERN = new RegExp(
  `^${KEY_ROOT}/${USER_ID_SOURCE}/(?:(?:${PURPOSE_SOURCE})/)?(?![\\s\\S])`,
);

export interface ParsedObjectKey {
  userId: string;
  purpose: StoragePurpose;
  objectId: string;
}

function isStoragePurpose(value: unknown): value is StoragePurpose {
  return typeof value === "string" && (STORAGE_PURPOSES as readonly string[]).includes(value);
}

function assertUserId(userId: string): void {
  if (typeof userId !== "string" || !USER_ID_PATTERN.test(userId)) {
    throw new StorageError("invalid-key", "user id is not usable in an object key");
  }
}

/** `u/<userId>/` — always ends with the slash, so "abc" never covers "abcd". */
export function userPrefix(userId: string): string {
  assertUserId(userId);
  return `${KEY_ROOT}/${userId}/`;
}

/** `u/<userId>/<purpose>/`. */
export function purposePrefix(userId: string, purpose: StoragePurpose): string {
  if (!isStoragePurpose(purpose)) {
    throw new StorageError("invalid-key", "storage purpose is not in the enum");
  }
  return `${userPrefix(userId)}${purpose}/`;
}

/** Mint a new key. The only way a key comes into existence. */
export function newObjectKey(userId: string, purpose: StoragePurpose): string {
  return `${purposePrefix(userId, purpose)}${randomUUID()}`;
}

/** The parts of a well-formed key, or null. Never throws. */
export function parseObjectKey(key: string): ParsedObjectKey | null {
  if (typeof key !== "string") return null;
  const match = KEY_PATTERN.exec(key);
  if (!match) return null;
  const [, userId, purpose, objectId] = match;
  if (!userId || !objectId || !isStoragePurpose(purpose)) return null;
  return { userId, purpose, objectId };
}

/** Throws `invalid-key` unless the key matches the grammar. */
export function assertValidObjectKey(key: string): ParsedObjectKey {
  const parsed = parseObjectKey(key);
  if (!parsed) throw new StorageError("invalid-key", "object key does not match the key grammar");
  return parsed;
}

/**
 * True when the key is well-formed AND sits under this user's prefix. The check
 * compares the parsed user segment, which is the prefix test with the trailing
 * slash built in.
 */
export function keyBelongsToUser(key: string, userId: string): boolean {
  if (typeof userId !== "string" || !USER_ID_PATTERN.test(userId)) return false;
  return parseObjectKey(key)?.userId === userId;
}

/** Throws `invalid-key` for a malformed key and `key-not-owned` for another user's. */
export function assertKeyBelongsToUser(key: string, userId: string): ParsedObjectKey {
  const parsed = assertValidObjectKey(key);
  if (!keyBelongsToUser(key, userId)) {
    throw new StorageError("key-not-owned", "object key is outside this user's prefix");
  }
  return parsed;
}

/**
 * A prefix a bulk delete may run on: one user's whole tree or one purpose under
 * it. The empty prefix, `u/`, and a prefix without its trailing slash are not.
 */
export function isDeletablePrefix(prefix: string): boolean {
  return typeof prefix === "string" && DELETABLE_PREFIX_PATTERN.test(prefix);
}
