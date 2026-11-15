/**
 * A mail address as a log line or a Sentry event may carry it: a short keyed
 * tag, never the address.
 *
 * An address is personal data, and logs and Sentry keep it beyond the account
 * (a wipe or deletion does not reach them). Where the line needs to say which
 * account, prefer the internal row id. Where there is no row (an address no
 * account matches), use this tag: stable for one address, so repeats of the
 * same one line up, and keyed with the server secret, so it cannot be checked
 * against a list of guessed addresses the way a plain hash can. An operator
 * who needs to know whether a given address produced a line computes
 * `addressLogTag(candidate)` on the server and compares.
 *
 * Same key construction as notify/push-later-token.ts, with its own purpose
 * string, so this key signs nothing else.
 */
import { createHmac } from "node:crypto";
import { resolveEffectiveJwtSecret } from "../auth.js";

const TAG_KEY = createHmac("sha256", resolveEffectiveJwtSecret())
  .update("log-address-tag-v1")
  .digest();

/** 48 bits: no collision in practice across one deployment's addresses, short enough to scan. */
const TAG_HEX_CHARS = 12;

/** `addr_3f9c0a1b7e2d` for an address; case and surrounding space do not change it. */
export function addressLogTag(address: string): string {
  const normalized = address.trim().toLowerCase();
  const digest = createHmac("sha256", TAG_KEY).update(normalized).digest("hex");
  return `addr_${digest.slice(0, TAG_HEX_CHARS)}`;
}
