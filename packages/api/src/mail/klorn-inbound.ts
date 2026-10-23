/**
 * Delivery of one signed Resend `email.received` event to the Klorn mailboxes it
 * names (step E1b of docs/providers/unified-platform-plan.md).
 *
 * Synchronous, with Resend's retries (about 28 h) as the queue: the outcome has
 * `retry` set only for a transient failure, and the route then answers 5xx.
 * Every copy is otherwise stored or deliberately dropped (2xx), so one hostile
 * message cannot make Resend disable the endpoint; and a drop that could hide a
 * systemic fault is reported (klorn-inbound-report.ts), so one bug or a wrong
 * setting cannot black-hole every message while Resend counts them delivered.
 *
 * - Routing reads the signed event; the content comes from Resend's API with
 *   Klorn's own key (`html_format: cid`), never from the webhook body, so a
 *   replay cannot inject any. It is fetched and mapped once per event.
 * - One `withSystem` lookup of the handles (handle and userId only). Per live
 *   recipient, under that user's tenant: the user's own KLORN row with exactly
 *   `<handle>@<domain>` (never found by email alone: generic IMAP lets a user
 *   name a row `victim@klorn.ai`), the data wipe, and whether the copy exists.
 * - Mail received before the recipient's data wipe is dropped; Resend retries
 *   for far longer than the fence window.
 * - A replay finds its row and is answered without fetching or rewriting it:
 *   Klorn holds this mailbox's state, so a re-sync would mark read mail unread.
 * - The self-sent comparison gets the Klorn address only for mail whose DKIM
 *   and DMARC pass, and otherwise "" (never the sign-in address the store
 *   would substitute for null), so a forged `From:` of either of the user's
 *   addresses cannot plant commitments the user owes.
 * - Bounded: lookups, fetch and store in bounded slots (a full queue answers
 *   retry at once), a per-call budget and the request's deadline; an event older
 *   than GIVE_UP_AGE_MS that would answer retry is dropped and reported instead
 *   (Resend stops at about 28 h anyway).
 * - postmaster@ and abuse@ get a notice to the support inbox, never the mail
 *   (klorn-inbound-notice.ts); an event naming nothing at the domain is
 *   reported (`domain-mismatch`).
 * - Nothing logged or reported here carries an address, subject or body.
 */

import { Prisma } from "@prisma/client";
import { withSystem, withTenant } from "../db-tenant.js";
import { persistGmailEmail } from "../judge/email-firewall.js";
import { isDataWipeFenceError } from "../privacy/data-wipe-fence.js";
import {
  klornMessageId,
  oversizedHeaders,
  type ResendReceivedContent,
  resendToRawEmail,
  selfSentAddress,
} from "./klorn-inbound-map.js";
import { sendNotices } from "./klorn-inbound-notice.js";
import {
  callBudget,
  combine,
  count,
  type InboundContext,
  type InboundOutcome,
  type ParsedEvent,
  pastDeadline,
  reportResendFailure,
  retryFor,
  SETTLED,
  slotRetry,
} from "./klorn-inbound-outcome.js";
import { inboundRecipients } from "./klorn-inbound-recipients.js";
import { callResend, errorClass } from "./klorn-inbound-resend.js";
import { KLORN_PROVIDER } from "./klorn-mailbox.js";

export type { InboundContext, InboundOutcome } from "./klorn-inbound-outcome.js";

/** Resend ids are UUIDs; the id goes into a URL path and the logs, so nothing else passes. */
const RESEND_EMAIL_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Resend's retries end at about 28 h: past this, a retry answer is a drop the operator sees. */
export const GIVE_UP_AGE_MS = 26 * 60 * 60_000;

export function isResendEmailId(value: unknown): value is string {
  return typeof value === "string" && RESEND_EMAIL_ID.test(value);
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The verified event's id and receive time. A shape Resend did not document
 * is schema drift: reported, and the time falls back to the envelope's, then now.
 */
function parseEvent(event: unknown, ctx: InboundContext): ParsedEvent | null {
  const envelope = (event ?? {}) as { created_at?: unknown; data?: unknown };
  const data = envelope.data;
  if (typeof data !== "object" || data === null) {
    ctx.reporter.report("event-schema", { kind: "data" });
    return null;
  }
  const fields = data as Record<string, unknown>;
  if (!isResendEmailId(fields.email_id)) {
    ctx.reporter.report("event-schema", { kind: "email_id" });
    return null;
  }
  const emailId = fields.email_id;
  const receivedAt = parseDate(fields.created_at);
  if (receivedAt) return { emailId, receivedAt, data: fields };
  ctx.reporter.report("event-schema", { emailId, kind: "created_at" });
  return {
    emailId,
    receivedAt: parseDate(envelope.created_at) ?? new Date(ctx.now()),
    data: fields,
  };
}

/** Live handles → their user. A tombstone (null user) or unknown handle is absent. */
async function lookupOwners(handles: string[]): Promise<Map<string, string>> {
  const rows = await withSystem((tx) =>
    tx.klornAddress.findMany({
      where: { handle: { in: handles } },
      select: { handle: true, userId: true },
    }),
  );
  return new Map(
    rows.flatMap((row) => (row.userId === null ? [] : [[row.handle, row.userId] as const])),
  );
}

interface Target {
  userId: string;
  address: string;
  linkedInboxAccountId: string;
}

type MailboxDecision =
  | { kind: "no-mailbox" }
  | { kind: "pre-wipe" }
  | { kind: "exists" }
  | { kind: "deliver"; id: string };

function mailboxDecision(
  userId: string,
  address: string,
  event: ParsedEvent,
): Promise<MailboxDecision> {
  return withTenant(userId, async (tx): Promise<MailboxDecision> => {
    const mailbox = await tx.linkedInboxAccount.findFirst({
      where: { userId, provider: KLORN_PROVIDER, email: address },
      select: { id: true },
    });
    if (!mailbox) return { kind: "no-mailbox" };
    const wipe = await tx.dataWipe.findUnique({ where: { userId }, select: { purgedAt: true } });
    if (wipe?.purgedAt && event.receivedAt < wipe.purgedAt) return { kind: "pre-wipe" };
    const existing = await tx.emailMessage.findUnique({
      where: { userId_gmailId: { userId, gmailId: klornMessageId(event.emailId) } },
      select: { id: true },
    });
    return existing ? { kind: "exists" } : { kind: "deliver", id: mailbox.id };
  });
}

async function resolveTargets(
  event: ParsedEvent,
  handles: string[],
  ctx: InboundContext,
): Promise<{ outcome: InboundOutcome; targets: Target[] }> {
  if (handles.length === 0) return { outcome: SETTLED, targets: [] };
  const owners = await lookupOwners(handles);
  let outcome = count("dropped", handles.length - owners.size);
  let targets: Target[] = [];
  for (const [index, [handle, userId]] of [...owners].entries()) {
    if (pastDeadline(ctx)) {
      return { outcome: combine(outcome, retryFor("deadline", owners.size - index)), targets: [] };
    }
    const address = `${handle}@${ctx.domain}`;
    const decision = await mailboxDecision(userId, address, event);
    if (decision.kind === "deliver") {
      targets = [...targets, { userId, address, linkedInboxAccountId: decision.id }];
      continue;
    }
    // A live address without its mailbox row is a data inconsistency (the claim
    // writes both in one transaction): dropped, but never silently.
    if (decision.kind === "no-mailbox") {
      ctx.reporter.report("mailbox-missing", { emailId: event.emailId });
    }
    outcome = combine(outcome, count(decision.kind === "exists" ? "stored" : "dropped"));
  }
  return { outcome, targets };
}

/** Postgres refuses this value for good: a retry would fail the same way. */
const REFUSED_PRISMA_CODES = new Set([
  "P2000", // value too long for the column
  "P2005", // invalid stored value
  "P2006", // invalid value
  "P2007", // data validation error
  "P2020", // value out of range
  "P2023", // inconsistent column data
  "P2033", // number does not fit
]);
/** Klorn built a query Prisma or the schema rejects: a bug to fix, so the mail waits. */
const BUG_PRISMA_CODES = new Set([
  "P2011", // null constraint
  "P2012", // missing required value
  "P2019", // input error
]);
const PRISMA_RAW_QUERY_FAILED = "P2010";
/** SQLSTATE class 22 (data exception: 22021 invalid byte sequence) and 54000 (index row too large). */
const REFUSED_SQLSTATE = /^(?:22[0-9A-Z]{3}|54000)$/;
const REFUSED_SQLSTATE_IN_MESSAGE = /\bcode: "(?:22[0-9A-Z]{3}|54000)"/;

export type StoreErrorKind = "fenced" | "stored" | "refused" | "bug" | "unknown";

function classifyKnownRequestError(err: Prisma.PrismaClientKnownRequestError): StoreErrorKind {
  if (err.code === "P2002") return "stored";
  if (REFUSED_PRISMA_CODES.has(err.code)) return "refused";
  if (BUG_PRISMA_CODES.has(err.code)) return "bug";
  const sqlState = (err.meta as { code?: unknown } | undefined)?.code;
  const refused = typeof sqlState === "string" && REFUSED_SQLSTATE.test(sqlState);
  return err.code === PRISMA_RAW_QUERY_FAILED && refused ? "refused" : "unknown";
}

export function classifyStoreError(err: unknown): StoreErrorKind {
  if (isDataWipeFenceError(err)) return "fenced";
  if (err instanceof Prisma.PrismaClientKnownRequestError) return classifyKnownRequestError(err);
  if (err instanceof Prisma.PrismaClientValidationError) return "bug";
  if (err instanceof Prisma.PrismaClientUnknownRequestError) {
    return REFUSED_SQLSTATE_IN_MESSAGE.test(err.message) ? "refused" : "unknown";
  }
  return "unknown";
}

/** The class of an error and its Prisma code: what may be reported, never its message. */
export function errorKind(err: unknown): string {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return `${err.name} ${err.code}`;
  return errorClass(err);
}

type RawEmail = ReturnType<typeof resendToRawEmail>;

async function storeCopy(target: Target, raw: RawEmail, ctx: InboundContext, emailId: string) {
  try {
    await persistGmailEmail(target.userId, raw, {
      userEmail: selfSentAddress(raw.authentication, target.address),
      linkedInboxAccountId: target.linkedInboxAccountId,
    });
    return count("stored");
  } catch (err) {
    const kind = classifyStoreError(err);
    if (kind === "stored") return count("stored");
    if (kind === "fenced") return retryFor("data-wipe");
    ctx.reporter.report(`store-${kind}`, { emailId, kind: errorKind(err) });
    return kind === "refused" ? count("dropped") : retryFor(`store-${kind}`);
  }
}

async function storeCopies(
  targets: Target[],
  content: ResendReceivedContent,
  event: ParsedEvent,
  ctx: InboundContext,
): Promise<InboundOutcome> {
  let raw: RawEmail;
  try {
    // Not parsed (no sender, no list): the message is still stored, and seen.
    const oversized = oversizedHeaders(content);
    if (oversized.length > 0) {
      ctx.reporter.report("header-oversize", { emailId: event.emailId, kind: oversized.join(",") });
    }
    raw = resendToRawEmail(
      content,
      { email_id: event.emailId, created_at: event.receivedAt.toISOString() },
      event.receivedAt,
    );
  } catch (err) {
    ctx.reporter.report("unexpected", { emailId: event.emailId, kind: errorClass(err) });
    return retryFor("map", targets.length);
  }
  let outcome = SETTLED;
  for (const [index, target] of targets.entries()) {
    if (pastDeadline(ctx)) return combine(outcome, retryFor("deadline", targets.length - index));
    outcome = combine(outcome, await storeCopy(target, raw, ctx, event.emailId));
  }
  return outcome;
}

/** Look the handles up, then fetch the content once and store every live user's copy. */
async function resolveAndStore(
  event: ParsedEvent,
  handles: string[],
  ctx: InboundContext,
): Promise<InboundOutcome> {
  const { outcome, targets } = await resolveTargets(event, handles, ctx);
  // With no live recipient, the content is never fetched.
  if (targets.length === 0) return outcome;
  const fetched = await callResend(
    () => ctx.api.get(event.emailId, { html_format: "cid" }),
    callBudget(ctx),
  );
  if (!fetched.ok) {
    return combine(outcome, reportResendFailure("get", fetched, targets.length, event, ctx));
  }
  const content = fetched.data as ResendReceivedContent;
  return combine(outcome, await storeCopies(targets, content, event, ctx));
}

/** The users' copies, under the bounded delivery slots and the request's deadline. */
async function deliverToUsers(
  event: ParsedEvent,
  handles: string[],
  ctx: InboundContext,
): Promise<InboundOutcome> {
  if (handles.length === 0) return SETTLED;
  const slot = await ctx.runtime.deliverySlots.run(
    () => resolveAndStore(event, handles, ctx),
    () => pastDeadline(ctx),
    () => ctx.deadlineAt - ctx.now(),
    // Past the deadline the slot is free and the answer is 503; a lookup that
    // fails later still reaches the operator.
    (err) => ctx.reporter.report("lookup", { emailId: event.emailId, kind: errorKind(err) }),
  );
  return slot.ran ? slot.value : slotRetry(slot.reason, handles.length);
}

function giveUpIfStale(outcome: InboundOutcome, event: ParsedEvent, ctx: InboundContext) {
  if (!outcome.retry || ctx.now() - event.receivedAt.getTime() <= GIVE_UP_AGE_MS) return outcome;
  ctx.reporter.report("give-up", { emailId: event.emailId, kind: outcome.retry });
  return { ...outcome, dropped: outcome.dropped + outcome.pending, pending: 0, retry: null };
}

/** `event` is the verified webhook payload; a malformed one is dropped (counted once). */
export async function deliverInboundEmail(
  event: unknown,
  ctx: InboundContext,
): Promise<InboundOutcome> {
  const parsed = parseEvent(event, ctx);
  if (!parsed) return count("dropped");
  const recipients = inboundRecipients(parsed.data, ctx.domain);
  if (recipients.matched === 0) {
    // Resend delivered mail that names nothing at this domain: a wrong
    // KLORN_MAILBOX_DOMAIN or receiving setup would drop everything this way.
    ctx.reporter.report("domain-mismatch", { emailId: parsed.emailId });
    return count("dropped");
  }
  const users = await deliverToUsers(parsed, recipients.handles, ctx);
  const notices = await sendNotices(recipients.system, parsed, ctx);
  const outcome = combine(count("dropped", recipients.dropped), combine(users, notices));
  return giveUpIfStale(outcome, parsed, ctx);
}
