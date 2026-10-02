/**
 * The grammar of a user-supplied IMAP host (step B4, design D1 in
 * docs/providers/unified-platform-plan.md). Pure, and checked before any network
 * work, at the connect route, at every stored-row boundary and again where a client
 * is built.
 *
 * A DNS name only: `host` or `host:993`. No IP literal in any spelling, no
 * userinfo, no path, no port but 993, no single label (`localhost`, `metadata`), no
 * internal suffix. The name is folded with `url.domainToASCII` (UTS 46: case,
 * full-width forms, ideographic dots, punycode) and only the ASCII result is
 * stored and connected to, so an IDN look-alike stays its own `xn--` host and can
 * never equal its ASCII twin. The WHATWG host parser inside `domainToASCII` also
 * folds the odd IPv4 spellings (`2130706433`, `0x7f.1`, `127.1`) into dotted form,
 * which is what lets the `net.isIP` check below see them.
 *
 * This says nothing about where the name POINTS. That is checked on every
 * connection (pinned-address.ts): a public-looking name may resolve anywhere.
 */

import net from "node:net";
import { domainToASCII } from "node:url";

import { isAllowedImapHost } from "./is-allowed-imap-host.js";

/** The only port a generic host is reached on: IMAP over implicit TLS. */
export const GENERIC_IMAP_PORT = 993;

/** Bounds the folding work: the longest input worth looking at (a DNS name is at most 253). */
const MAX_INPUT_LENGTH = 512;
const MAX_NAME_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
/** A real top-level label: letters, or an IDN `xn--` label. Never a number. */
const TOP_LEVEL_LABEL = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
/** Whitespace and the separators of a URL (userinfo, path, query, fragment, zone id, brackets). */
const FORBIDDEN_CHARS = /[\s@/\\?#%[\]]/;

/**
 * Names that are never a public mail server. The matching is by whole trailing
 * labels: `db.internal` and `internal` match `internal`, `internal.example.com` and
 * `fakeinternal` do not.
 */
const INTERNAL_SUFFIXES: readonly string[] = [
  "local",
  "localhost",
  "internal",
  "localdomain",
  "lan",
  "home",
  "corp",
  "intranet",
  "private",
  "home.arpa",
  "arpa",
  "test",
  "invalid",
  "example",
  "onion",
  "metadata.goog",
];

/**
 * Hosts of providers Klorn already has a built-in connection for. Typed here as a
 * generic host they would bypass that provider's own flow (Google and Microsoft
 * connect through OAuth, Naver and iCloud through a pinned host), so they are refused
 * with a pointer to it. Naver and iCloud come from the exact allowlist itself
 * (`isAllowedImapHost`), so a provider added there is refused here without a second
 * edit; the others have no entry in that list and are named.
 */
const BUILT_IN_HOSTS: ReadonlySet<string> = new Set([
  "imap.gmail.com",
  "imap.googlemail.com",
  "outlook.office365.com",
  "imap-mail.outlook.com",
]);

const isBuiltInHost = (name: string): boolean =>
  BUILT_IN_HOSTS.has(name) || isAllowedImapHost(name);

export type HostRejection =
  | "empty"
  | "too-long"
  | "invalid-format"
  | "ip-literal"
  | "port-not-allowed"
  | "single-label"
  | "internal-suffix"
  | "built-in-provider";

export type ParsedGenericHost =
  | {
      ok: true;
      /** The ASCII (punycode) name. */
      hostname: string;
      port: typeof GENERIC_IMAP_PORT;
      /** The stored form, `hostname:993`. */
      stored: string;
    }
  | { ok: false; reason: HostRejection };

const reject = (reason: HostRejection): ParsedGenericHost => ({ ok: false, reason });

/** `::1`, `fe80::1`, `[::1]`, `[::1]:993`, `[::ffff:10.0.0.1]:993`. */
function looksLikeIPv6(text: string): boolean {
  const bare = text.replace(/^\[/, "").replace(/\](?::\d+)?$/, "");
  return net.isIPv6(bare) || net.isIPv6(text);
}

function hasControlCharacter(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function hasInternalSuffix(name: string): boolean {
  return INTERNAL_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

/** Split `host[:port]` and require the port, when present, to be exactly 993. */
function splitHostAndPort(text: string): { rawHost: string } | { rejection: HostRejection } {
  const parts = text.split(":");
  if (parts.length > 2) return { rejection: "invalid-format" };
  const [rawHost, port] = parts;
  if (port !== undefined) {
    if (!/^\d+$/.test(port)) return { rejection: "invalid-format" };
    if (port !== String(GENERIC_IMAP_PORT)) return { rejection: "port-not-allowed" };
  }
  return { rawHost };
}

/** The reason an ASCII name is not a usable public host name, or null when it is. */
function nameRejection(name: string): HostRejection | null {
  if (net.isIP(name) !== 0) return "ip-literal";
  if (name.endsWith(".")) return "invalid-format";
  if (name.length > MAX_NAME_LENGTH) return "too-long";
  const labels = name.split(".");
  const badLabel = labels.some(
    (label) => label.length === 0 || label.length > MAX_LABEL_LENGTH || !LABEL.test(label),
  );
  if (badLabel) return "invalid-format";
  if (labels.length < 2) return "single-label";
  if (!TOP_LEVEL_LABEL.test(labels[labels.length - 1])) return "invalid-format";
  if (hasInternalSuffix(name)) return "internal-suffix";
  if (isBuiltInHost(name)) return "built-in-provider";
  return null;
}

export function parseGenericImapHost(input: unknown): ParsedGenericHost {
  if (typeof input !== "string") return reject("invalid-format");
  const text = input.trim();
  if (text.length === 0) return reject("empty");
  if (text.length > MAX_INPUT_LENGTH) return reject("too-long");
  if (looksLikeIPv6(text)) return reject("ip-literal");
  if (FORBIDDEN_CHARS.test(text) || hasControlCharacter(text)) return reject("invalid-format");

  const split = splitHostAndPort(text);
  if ("rejection" in split) return reject(split.rejection);

  const hostname = domainToASCII(split.rawHost);
  if (hostname === "") return reject("invalid-format");
  const rejection = nameRejection(hostname);
  if (rejection !== null) return reject(rejection);

  return {
    ok: true,
    hostname,
    port: GENERIC_IMAP_PORT,
    stored: `${hostname}:${GENERIC_IMAP_PORT}`,
  };
}
