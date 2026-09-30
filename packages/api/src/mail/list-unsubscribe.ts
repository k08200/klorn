/**
 * List-Unsubscribe support — RFC 2369 header parsing plus the RFC 8058
 * one-click POST. The header is SENDER-CONTROLLED input: parsing is
 * defensive (bracketed entries only, first of each scheme, length-capped),
 * and the one-click POST is https-only through the same SSRF stack as
 * web-push delivery — isSafePushEndpoint for the hostname-string check,
 * ssrfSafeHttpsAgent's DNS-lookup guard at connect time for rebinding.
 */

import { request as httpsRequest } from "node:https";
import { isSafePushEndpoint } from "../notify/is-safe-push-endpoint.js";
import { ssrfSafeHttpsAgent } from "../notify/ssrf-safe-agent.js";

/** Longest header entry we will store — anything longer is dropped, not
 * truncated (a truncated URL is a different URL). */
const MAX_ENTRY_CHARS = 2048;

const ONE_CLICK_RE = /one-click/i;

export interface ParsedListUnsubscribe {
  /** Full mailto: URI (address + optional query), or null. */
  mailto: string | null;
  /** First http(s) URL, or null. */
  url: string | null;
  /** RFC 8058: post header present AND an https URL to POST to. */
  oneClick: boolean;
}

export function parseListUnsubscribe(
  header: string | null | undefined,
  postHeader: string | null | undefined,
): ParsedListUnsubscribe {
  let mailto: string | null = null;
  let httpsUrl: string | null = null;
  let httpUrl: string | null = null;
  if (header) {
    for (const match of header.matchAll(/<([^<>]+)>/g)) {
      const entry = match[1].trim();
      if (entry.length === 0 || entry.length > MAX_ENTRY_CHARS) continue;
      const lower = entry.toLowerCase();
      if (mailto === null && lower.startsWith("mailto:")) {
        mailto = entry;
      } else if (httpsUrl === null && lower.startsWith("https://")) {
        httpsUrl = entry;
      } else if (httpUrl === null && lower.startsWith("http://")) {
        httpUrl = entry;
      }
    }
  }
  // https beats http regardless of header order: a legacy list that names
  // both would otherwise lose its RFC 8058 eligibility to entry ordering.
  const url = httpsUrl ?? httpUrl;
  const oneClick =
    url !== null &&
    url.toLowerCase().startsWith("https://") &&
    typeof postHeader === "string" &&
    ONE_CLICK_RE.test(postHeader);
  return { mailto, url, oneClick };
}

const MAILTO_ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The subject and body of a stored mailto: come from the sender of the mail. A
// real unsubscribe request is a few words or a short token; anything past these
// is not sent (the caller falls back to the link) so a sender cannot have the
// user's own account mail a large payload to an address of their choosing.
export const MAX_MAILTO_SUBJECT_LENGTH = 250;
export const MAX_MAILTO_BODY_LENGTH = 1_000;

export interface MailtoTarget {
  to: string;
  subject: string;
  body: string;
}

/**
 * Resolve a stored mailto: target into a sendable message. Null when the
 * URI does not carry one plausible address, or a subject or body over the caps
 * above — the caller falls back to the browser link rather than sending mail to
 * a sender-controlled junk string.
 */
export function parseMailtoTarget(mailto: string): MailtoTarget | null {
  if (!mailto.toLowerCase().startsWith("mailto:")) return null;
  let url: URL;
  try {
    url = new URL(mailto);
  } catch {
    return null;
  }
  let to: string;
  try {
    to = decodeURIComponent(url.pathname).trim().toLowerCase();
  } catch {
    return null;
  }
  if (!MAILTO_ADDRESS_RE.test(to)) return null;
  const subject = url.searchParams.get("subject")?.trim() || "unsubscribe";
  const body = url.searchParams.get("body")?.trim() || "unsubscribe";
  if (subject.length > MAX_MAILTO_SUBJECT_LENGTH || body.length > MAX_MAILTO_BODY_LENGTH) {
    return null;
  }
  return { to, subject, body };
}

/** Default-OFF automation flag: when on, SILENT promotional mail with an
 * RFC 8058 target is unsubscribed at classification time (one-click only —
 * never mailto, which sends as the user, and never the browser link). */
export function autoUnsubscribeEnabled(): boolean {
  return process.env.AUTO_UNSUBSCRIBE_ENABLED === "true";
}

type PostFn = (
  url: string,
  body: string,
  headers: Record<string, string>,
) => Promise<{ statusCode: number }>;

const POST_TIMEOUT_MS = 10_000;

/** Default poster: node https with the SSRF-safe agent (its DNS lookup
 * rejects any resolution to a private address). Redirects are NOT followed
 * — a redirect target would bypass the pre-checked URL. */
function httpsPost(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ statusCode: number }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      { method: "POST", headers, agent: ssrfSafeHttpsAgent, timeout: POST_TIMEOUT_MS },
      (res) => {
        // Drain and discard: the response body is untrusted and unneeded.
        res.resume();
        resolve({ statusCode: res.statusCode ?? 0 });
      },
    );
    req.on("timeout", () => req.destroy(new Error("one-click unsubscribe timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

export type OneClickResult = { ok: true } | { ok: false; reason: string };

/**
 * Perform the RFC 8058 POST. Never throws — an unsubscribe failure is a
 * user-facing "try the link instead", not a 500. 2xx/3xx count as done
 * (some list providers 302 to a confirmation page after honoring the POST).
 */
export async function executeOneClickUnsubscribe(
  url: string,
  post: PostFn = httpsPost,
): Promise<OneClickResult> {
  if (!isSafePushEndpoint(url)) return { ok: false, reason: "unsafe-endpoint" };
  try {
    const res = await post(url, "List-Unsubscribe=One-Click", {
      "content-type": "application/x-www-form-urlencoded",
    });
    if (res.statusCode >= 200 && res.statusCode < 400) return { ok: true };
    return { ok: false, reason: `http-${res.statusCode}` };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "request-failed" };
  }
}
