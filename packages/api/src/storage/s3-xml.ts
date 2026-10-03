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

/** Decode the entities XML text may carry. One pass, so `&amp;lt;` stays `&lt;`. */
function decodeXmlText(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return NAMED_ENTITIES[entity] ?? whole;
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
