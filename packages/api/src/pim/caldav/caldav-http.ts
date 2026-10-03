/**
 * One CalDAV HTTP request, with the SSRF guard on every hop (step C3).
 *
 * For each hop, in order: the provider's host guard on the URL (https, no
 * userinfo, no IP literal, port 443, an allowlisted host), DNS resolved and EVERY
 * answer checked public, then the request sent to that one checked address (the
 * TLS name check still uses the host name). Redirects are never followed by the
 * transport: a 3xx comes back here, its Location is resolved against the URL that
 * answered, and the next hop goes through the same guard, at most
 * CALDAV_MAX_REDIRECTS times. The credentials therefore only ever travel to a host
 * the provider's own allowlist names.
 *
 * Bounds: a response body over CALDAV_MAX_RESPONSE_BYTES is cut off (the transport
 * stops reading), each request has a timeout, and every step, DNS included, also
 * stops at the connection's deadline: the one time budget of a whole sync or link.
 */

import {
  type HostResolver,
  type PinnedAddress,
  PinnedAddressError,
  resolvePinnedAddress,
} from "../../mail/pinned-address.js";
import { CaldavGuardError, CaldavHttpError, CaldavLimitError } from "./caldav-errors.js";
import { type CaldavProviderConfig, checkCaldavUrl } from "./caldav-providers.js";

/** Hops followed after the first request. iCloud sends at most one (to a partition host). */
export const CALDAV_MAX_REDIRECTS = 3;
/** Per response. A month of events is far below this; a larger answer is truncated, never parsed. */
export const CALDAV_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** Per request (DNS + connect + response), within the deadline. */
export const CALDAV_REQUEST_TIMEOUT_MS = 15_000;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 307, 308]);
/** WebDAV answers a PROPFIND or a REPORT with 207 Multi-Status; some servers answer a REPORT with 200. */
const OK_STATUSES: ReadonlySet<number> = new Set([200, 207]);

export interface TransportRequest {
  readonly url: URL;
  /** The checked address to connect to: the transport must not resolve the name itself. */
  readonly address: PinnedAddress;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly maxBytes: number;
  readonly signal: AbortSignal;
}

export interface TransportResponse {
  readonly status: number;
  readonly location: string | null;
  readonly body: string;
}

/** Sends one request as given, never following a redirect. The default is caldav-transport.ts. */
export type CaldavTransport = (request: TransportRequest) => Promise<TransportResponse>;

/** One account's credentials and budget, for every request of one operation (a sync, a link). */
export interface CaldavConnection {
  readonly provider: CaldavProviderConfig;
  readonly username: string;
  readonly password: string;
  /** Epoch ms after which no step starts and every pending one is abandoned. */
  readonly deadline: number;
  readonly requestTimeoutMs: number;
  readonly transport: CaldavTransport;
  readonly resolve: HostResolver;
  readonly now: () => number;
}

export interface CaldavHttpRequest {
  readonly method: "PROPFIND" | "REPORT";
  readonly url: string | URL;
  readonly depth: "0" | "1";
  readonly body: string;
}

export interface CaldavResponse {
  readonly status: number;
  /** The URL that finally answered (after any redirect): relative hrefs resolve against it. */
  readonly url: URL;
  readonly body: string;
}

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function requestHeaders(conn: CaldavConnection, depth: string): Record<string, string> {
  return {
    Authorization: basicAuth(conn.username, conn.password),
    "Content-Type": "application/xml; charset=utf-8",
    Depth: depth,
    // No compression: the size cap then bounds exactly what is read.
    "Accept-Encoding": "identity",
  };
}

/**
 * Run `work` until it settles, the request timeout passes, or the deadline does,
 * whichever is first. On a timeout `controller` is aborted, and the caller is
 * released even when the work ignores the abort.
 */
async function bounded<T>(
  conn: CaldavConnection,
  controller: AbortController,
  work: Promise<T>,
): Promise<T> {
  const remaining = conn.deadline - conn.now();
  if (remaining <= 0) throw new CaldavLimitError("deadline");
  const byDeadline = remaining <= conn.requestTimeoutMs;
  const wait = byDeadline ? remaining : conn.requestTimeoutMs;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new CaldavLimitError(byDeadline ? "deadline" : "timeout"));
    }, wait);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function pinnedAddressOf(conn: CaldavConnection, url: URL): Promise<PinnedAddress> {
  try {
    return await bounded(
      conn,
      new AbortController(),
      resolvePinnedAddress(url.hostname, conn.resolve),
    );
  } catch (err) {
    if (err instanceof PinnedAddressError) throw new CaldavGuardError(err.code);
    throw err;
  }
}

async function sendOnce(
  conn: CaldavConnection,
  url: URL,
  request: CaldavHttpRequest,
): Promise<TransportResponse> {
  const address = await pinnedAddressOf(conn, url);
  const controller = new AbortController();
  return bounded(
    conn,
    controller,
    conn.transport({
      url,
      address,
      method: request.method,
      headers: requestHeaders(conn, request.depth),
      body: request.body,
      maxBytes: CALDAV_MAX_RESPONSE_BYTES,
      signal: controller.signal,
    }),
  );
}

/** The next hop, resolved against the URL that answered; a Location that is no URL is refused. */
function redirectTarget(location: string, from: URL): URL {
  try {
    return new URL(location, from);
  } catch {
    throw new CaldavGuardError("malformed");
  }
}

/**
 * Send one CalDAV request through the guard (see the header). Resolves with a 2xx
 * multistatus answer; throws CaldavGuardError (refused before connecting),
 * CaldavLimitError, CaldavHttpError (any other status; 401 is a revoked credential
 * to the failure policy) or the transport's own error.
 */
export async function caldavRequest(
  conn: CaldavConnection,
  request: CaldavHttpRequest,
): Promise<CaldavResponse> {
  let target: string | URL = request.url;
  for (let hop = 0; hop <= CALDAV_MAX_REDIRECTS; hop += 1) {
    const url = checkCaldavUrl(target, conn.provider);
    const response = await sendOnce(conn, url, request);
    if (REDIRECT_STATUSES.has(response.status)) {
      if (!response.location) throw new CaldavGuardError("redirect-without-location");
      target = redirectTarget(response.location, url);
      continue;
    }
    if (!OK_STATUSES.has(response.status)) throw new CaldavHttpError(response.status);
    return { status: response.status, url, body: response.body };
  }
  throw new CaldavGuardError("redirect-limit");
}
