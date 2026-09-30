/**
 * The failure vocabulary of the provider actions: how a soft failure is built
 * (`fail`), and how an error is described for a log or for Sentry.
 *
 * imapflow and nodemailer errors can quote the server's reply, which may hold a
 * recipient address or a mailbox name. Nothing built from `err.message` may be
 * logged or reported for them: `describeFailure` keeps only the error's class,
 * code, reply code and failing command, each bounded in length.
 */

import type { MailActionFailure } from "./types.js";

export const fail = (error: string): MailActionFailure => ({ error });

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const MAX_DESCRIBED_FIELD_LENGTH = 40;

export function describeFailure(err: unknown): string {
  if (typeof err !== "object" || err === null) return "NonError";
  const e = err as Record<string, unknown>;
  const fields: Array<[string, unknown]> = [
    ["code", e.code],
    ["reply", e.responseCode],
    ["imap", e.serverResponseCode],
    ["command", e.command],
  ];
  const known = fields
    .filter(([, value]) => typeof value === "string" || typeof value === "number")
    .map(([name, value]) => `${name}=${String(value).slice(0, MAX_DESCRIBED_FIELD_LENGTH)}`);
  const name = typeof e.name === "string" ? e.name.slice(0, MAX_DESCRIBED_FIELD_LENGTH) : "Error";
  return [name, ...known].join(" ");
}

/** A fresh error built from `describeFailure`, safe to log and to send to Sentry. */
export function sanitizedError(err: unknown): Error {
  return new Error(describeFailure(err));
}
