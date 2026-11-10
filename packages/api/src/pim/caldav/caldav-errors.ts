/**
 * The CalDAV connector's errors (step C3). Every message is a constant: no URL (it
 * carries the account's principal id), no server text and no credential can reach
 * a log line, Sentry or a user through one of these. The `code` or `status` field
 * says what happened, for the server log and the failure policy.
 */

/** A URL or host the guard refused, before any connection was made. */
export type CaldavGuardCode =
  | "malformed"
  | "scheme"
  | "userinfo"
  | "ip-literal"
  | "port"
  | "host"
  | "unresolvable"
  | "blocked-address"
  | "redirect-limit"
  | "redirect-without-location";

export class CaldavGuardError extends Error {
  constructor(readonly code: CaldavGuardCode) {
    super(`CalDAV request refused by the host guard (${code})`);
    this.name = "CaldavGuardError";
  }
}

/**
 * The server answered with a status the client does not accept. `status` is what
 * the shared failure policy reads: 401 is a revoked credential (the app-specific
 * password was revoked or is wrong) and flags the account for reconnect.
 */
export class CaldavHttpError extends Error {
  constructor(readonly status: number) {
    super(`CalDAV request failed with HTTP ${status}`);
    this.name = "CaldavHttpError";
  }
}

/** A bound was hit: a response over the size cap, a request or the whole sync over time. */
export type CaldavLimitKind = "too-large" | "timeout" | "deadline";

export class CaldavLimitError extends Error {
  constructor(readonly kind: CaldavLimitKind) {
    super(`CalDAV request stopped at a limit (${kind})`);
    this.name = "CaldavLimitError";
  }
}

/** The server's answer could not be read as the protocol says it should be. */
export type CaldavProtocolCode = "bad-xml" | "no-principal" | "no-home-set" | "encoding";

export class CaldavProtocolError extends Error {
  constructor(readonly code: CaldavProtocolCode) {
    super(`CalDAV response unreadable (${code})`);
    this.name = "CaldavProtocolError";
  }
}

/** A short, constant description of any error, safe for a log line. */
export function caldavErrorClass(err: unknown): string {
  if (err instanceof CaldavGuardError) return `guard:${err.code}`;
  if (err instanceof CaldavHttpError) return `http:${err.status}`;
  if (err instanceof CaldavLimitError) return `limit:${err.kind}`;
  if (err instanceof CaldavProtocolError) return `protocol:${err.code}`;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,39}$/.test(code) ? `net:${code}` : "other";
}
