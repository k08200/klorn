/**
 * An independent AWS Signature Version 4 implementation for the storage tests
 * (step D1). It shares no code with the signer the store uses (aws4fetch), so a
 * request the store builds is checked against the specification rather than
 * against itself. `storage-sigv4-reference.test.ts` pins it to the signatures
 * AWS publishes in the S3 documentation.
 */

import { createHash, createHmac } from "node:crypto";

const UNRESERVED = /[A-Za-z0-9\-_.~]/;

/** AWS `UriEncode`: every byte except the unreserved set becomes %XX. */
export function uriEncode(value: string, encodeSlash = true): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const char = String.fromCharCode(byte);
    if (UNRESERVED.test(char) || (char === "/" && !encodeSlash)) out += char;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

export interface ReferenceSigningInput {
  method: string;
  /** The decoded request path, starting with a slash. */
  path: string;
  /** Decoded query pairs, without X-Amz-Signature. */
  query: ReadonlyArray<readonly [string, string]>;
  /** The signed headers: lower-case name to value. */
  headers: Readonly<Record<string, string>>;
  /** A hex SHA-256 of the payload, or UNSIGNED-PAYLOAD. */
  payloadHash: string;
  /** `YYYYMMDD'T'HHMMSS'Z'`. */
  datetime: string;
  region: string;
  service: string;
  secretAccessKey: string;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalQuery(query: ReferenceSigningInput["query"]): string {
  return query
    .map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
    .sort((a, b) => compare(a[0], b[0]) || compare(a[1], b[1]))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** The hex signature the specification gives for this request. */
export function referenceSignature(input: ReferenceSigningInput): string {
  const names = Object.keys(input.headers).sort(compare);
  const canonicalHeaders = names
    .map((name) => `${name}:${(input.headers[name] ?? "").trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const canonicalRequest = [
    input.method,
    uriEncode(input.path, false),
    canonicalQuery(input.query),
    canonicalHeaders,
    names.join(";"),
    input.payloadHash,
  ].join("\n");

  const date = input.datetime.slice(0, 8);
  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    input.datetime,
    scope,
    createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
  ].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, date), input.region), input.service),
    "aws4_request",
  );
  return hmac(signingKey, stringToSign).toString("hex");
}
