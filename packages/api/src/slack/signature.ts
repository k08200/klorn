/**
 * Slack request signing, v0 (https://docs.slack.dev/authentication/verifying-requests-from-slack):
 * `X-Slack-Signature` is `v0=` + hex HMAC-SHA256 of `v0:{timestamp}:{raw body}`
 * keyed with the app's signing secret. Verified over the exact bytes Slack
 * sent, before anything parses them, and compared in constant time. A
 * timestamp more than five minutes from now is refused even when correctly
 * signed, so a captured request cannot be replayed later.
 */

import crypto from "node:crypto";
import { timingSafeEqualStr } from "../timing-safe-equal.js";

export const SLACK_MAX_SKEW_SECONDS = 300;
const SIGNATURE_VERSION = "v0";
/** Unix seconds: 10 digits today; anything longer than this is not a timestamp. */
const MAX_TIMESTAMP_DIGITS = 12;
/** `v0=` + 64 hex characters; a little headroom, never unbounded. */
const MAX_SIGNATURE_LENGTH = 128;
const MS_PER_SECOND = 1000;

export type SlackSignatureFailure = "missing-headers" | "stale-timestamp" | "bad-signature";
export type SlackSignatureResult = { ok: true } | { ok: false; reason: SlackSignatureFailure };

export interface SlackSignatureInput {
  rawBody: Buffer;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  signingSecret: string;
  nowMs: number;
}

function isDigits(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return value.length > 0;
}

/** `v0=` + hex HMAC-SHA256 of `v0:{timestamp}:{raw body}`. */
export function signSlackRequest(
  rawBody: Buffer,
  timestamp: string,
  signingSecret: string,
): string {
  const hmac = crypto.createHmac("sha256", signingSecret);
  hmac.update(`${SIGNATURE_VERSION}:${timestamp}:`);
  hmac.update(rawBody);
  return `${SIGNATURE_VERSION}=${hmac.digest("hex")}`;
}

export function verifySlackSignature(input: SlackSignatureInput): SlackSignatureResult {
  const { timestamp, signature } = input;
  if (
    typeof timestamp !== "string" ||
    timestamp.length > MAX_TIMESTAMP_DIGITS ||
    !isDigits(timestamp) ||
    typeof signature !== "string" ||
    signature.length > MAX_SIGNATURE_LENGTH ||
    !signature.startsWith(`${SIGNATURE_VERSION}=`)
  ) {
    return { ok: false, reason: "missing-headers" };
  }
  if (input.signingSecret.length === 0) return { ok: false, reason: "bad-signature" };
  const skewSeconds = Math.abs(Math.floor(input.nowMs / MS_PER_SECOND) - Number(timestamp));
  if (skewSeconds > SLACK_MAX_SKEW_SECONDS) return { ok: false, reason: "stale-timestamp" };
  const expected = signSlackRequest(input.rawBody, timestamp, input.signingSecret);
  return timingSafeEqualStr(expected, signature)
    ? { ok: true }
    : { ok: false, reason: "bad-signature" };
}
