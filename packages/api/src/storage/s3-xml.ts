/**
 * The two pieces of S3 XML the store reads (step D1 of
 * docs/providers/unified-platform-plan.md): a ListObjectsV2 answer and the
 * `<Code>` of an error body. Both come from the storage vendor, never from a
 * user. The reads are narrow on purpose, so no XML parser is needed.
 */

import { StorageError } from "./errors.js";

export interface ListPage {
  keys: string[];
  /** True when the prefix holds more keys than this page. */
  truncated: boolean;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

const MAX_CODE_POINT = 0x10ffff;
const SURROGATE_MIN = 0xd800;
const SURROGATE_MAX = 0xdfff;

/**
 * A character reference's character. Zero, the surrogate range and anything
 * past U+10FFFF are not characters at all, so an answer carrying one is
 * malformed: the whole page fails as an upstream StorageError rather than a
 * RangeError from String.fromCodePoint (or a lone surrogate). Other code points
 * XML 1.0 disallows (e.g. U+0001) are still decoded on purpose: S3 writes such
 * key characters as references because the list request does not ask for
 * URL-encoded keys.
 */
function xmlCharFromCodePoint(code: number): string {
  const valid =
    Number.isInteger(code) &&
    code > 0 &&
    code <= MAX_CODE_POINT &&
    (code < SURROGATE_MIN || code > SURROGATE_MAX);
  if (!valid) {
    throw new StorageError("upstream", "object storage answer has an invalid character reference");
  }
  return String.fromCodePoint(code);
}

/** Decode the entities XML text may carry. One pass, so `&amp;lt;` stays `&lt;`. */
function decodeXmlText(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, entity: string) => {
    if (entity.startsWith("#x")) return xmlCharFromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return xmlCharFromCodePoint(Number.parseInt(entity.slice(1), 10));
    // Own keys only: `&constructor;` must not find the object prototype's.
    return Object.hasOwn(NAMED_ENTITIES, entity) ? (NAMED_ENTITIES[entity] as string) : whole;
  });
}

/** Keys and the truncation flag of a ListObjectsV2 answer. */
export function parseListObjectsXml(xml: string): ListPage {
  if (typeof xml !== "string" || !xml.includes("<ListBucketResult")) {
    throw new StorageError("upstream", "object storage list answer is not a ListBucketResult");
  }
  const keys = [...xml.matchAll(/<Contents>[\s\S]*?<Key>([\s\S]*?)<\/Key>[\s\S]*?<\/Contents>/g)]
    .map((match) => decodeXmlText(match[1] ?? ""))
    .filter((key) => key.length > 0);
  return { keys, truncated: /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml) };
}

/**
 * The vendor's error code (`NoSuchBucket`, `AccessDenied`, …), or undefined. The
 * character set is restricted so the value is safe to put in a log line.
 */
export function s3ErrorCodeOf(body: string): string | undefined {
  if (typeof body !== "string") return undefined;
  return /<Code>([A-Za-z0-9._-]{1,64})<\/Code>/.exec(body)?.[1];
}
