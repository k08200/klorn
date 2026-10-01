/**
 * The default CalDAV transport (step C3): one HTTPS request over node:https to the
 * address the guard pinned, never following a redirect, reading at most
 * `maxBytes` of body.
 *
 * Pinning: the request names the host (so SNI and the certificate check use it)
 * but its `lookup` answers only the checked address, whatever it is asked, so DNS
 * is not consulted a second time between the check and the connect. `agent: false`
 * gives each request its own socket: a pooled socket to another address is never
 * reused.
 */

import type { IncomingHttpHeaders } from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import type { Readable } from "node:stream";
import type { PinnedAddress } from "../../net/pinned-host.js";
import { CaldavLimitError, CaldavProtocolError } from "./caldav-errors.js";
import type { CaldavTransport } from "./caldav-http.js";

const HTTPS_PORT = 443;

/** A `lookup` that answers the pinned address for any name, in both callback shapes. */
export function pinnedLookup(pinned: PinnedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    const cb = callback as (err: null, address: unknown, family?: number) => void;
    if ((options as { all?: boolean }).all) {
      cb(null, [{ address: pinned.address, family: pinned.family }]);
      return;
    }
    cb(null, pinned.address, pinned.family);
  };
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The body as UTF-8, or a rejection once more than `maxBytes` arrived (or were
 * announced): the stream is destroyed so nothing more is read. A compressed body is
 * refused; identity was asked for, so the cap bounds exactly what is decoded.
 */
export function readCappedBody(
  stream: Readable,
  headers: IncomingHttpHeaders,
  maxBytes: number,
): Promise<string> {
  const encoding = headerValue(headers, "content-encoding")?.trim().toLowerCase();
  if (encoding && encoding !== "identity") {
    stream.destroy();
    return Promise.reject(new CaldavProtocolError("encoding"));
  }
  const declared = Number(headerValue(headers, "content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    stream.destroy();
    return Promise.reject(new CaldavLimitError("too-large"));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    stream.on("data", (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      received += buffer.length;
      if (received > maxBytes) {
        stream.destroy();
        reject(new CaldavLimitError("too-large"));
        return;
      }
      chunks.push(buffer);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}

export const httpsPinnedTransport: CaldavTransport = (request) =>
  new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: "https:",
        hostname: request.url.hostname,
        port: HTTPS_PORT,
        path: `${request.url.pathname}${request.url.search}`,
        method: request.method,
        headers: { ...request.headers, "Content-Length": Buffer.byteLength(request.body) },
        servername: request.url.hostname,
        lookup: pinnedLookup(request.address),
        agent: false,
        signal: request.signal,
      },
      (res) => {
        readCappedBody(res, res.headers, request.maxBytes).then(
          (body) =>
            resolve({
              status: res.statusCode ?? 0,
              location: headerValue(res.headers, "location") ?? null,
              body,
            }),
          reject,
        );
      },
    );
    req.on("error", reject);
    req.end(request.body);
  });
