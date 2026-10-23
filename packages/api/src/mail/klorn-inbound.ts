/**
 * Delivery of one signed Resend `email.received` event to the Klorn mailboxes it
 * names (step E1b of docs/providers/unified-platform-plan.md).
 *
 * Synchronous, with Resend's retries (about 28 h) as the queue: the outcome has
 * `retry` set only for a transient failure, and the route then answers 5xx.
 * Every copy is otherwise stored or deliberately dropped (2xx), so one hostile
 * message cannot make Resend disable the endpoint.
 *
 * - Routing reads the signed event; the content comes from Resend's API with
 *   Klorn's own key, never from the webhook body, so a replay cannot inject any.
 * - One `withSystem` lookup of the handles (handle and userId only). Per live
 *   recipient, under that user's tenant: the user's own KLORN row with exactly
 *   `<handle>@<domain>` (never found by email alone: generic IMAP lets a user
 *   name a row `victim@klorn.ai`), the data wipe, and whether the copy exists.
 * - Mail received before the recipient's data wipe is dropped; Resend retries
 *   for far longer than the fence window.
 * - A replay finds its row and is answered without fetching or rewriting it:
 *   Klorn holds this mailbox's state, so a re-sync would mark read mail unread.
 * - postmaster@ and abuse@ are forwarded (L18) in the SDK's wrapped mode, which
 *   attaches the original as .eml; its passthrough mode would run postal-mime
 *   on the raw message on the event loop.
 * - Nothing logged or reported here carries an address, subject or body.
 */

import { Prisma } from "@prisma/client";
import type {
  ErrorResponse,
  ForwardReceivingEmailOptions,
  ForwardReceivingEmailRequestOptions,
  ForwardReceivingEmailResponse,
  GetReceivingEmailResponse,
} from "resend";
import { withSystem, withTenant } from "../db-tenant.js";
import { persistGmailEmail } from "../judge/email-firewall.js";
import { isDataWipeFenceError } from "../privacy/data-wipe-fence.js";
import { captureError } from "../sentry.js";
import {
  klornMessageId,
  type ResendReceivedContent,
  type ResendReceivedEventData,
  resendToRawEmail,
} from "./klorn-inbound-map.js";
import { inboundRecipients } from "./klorn-inbound-recipients.js";
import { KLORN_PROVIDER } from "./klorn-mailbox.js";

/** The two calls made to Resend: `resend.emails.receiving`. */
export interface InboundReceivingApi {
  get(id: string): Promise<GetReceivingEmailResponse>;
  forward(
    options: ForwardReceivingEmailOptions,
    requestOptions?: ForwardReceivingEmailRequestOptions,
  ): Promise<ForwardReceivingEmailResponse>;
}

export interface InboundSettings {
  /** ASCII lowercase. */
  domain: string;
  forwardTo: string | null;
  timeoutMs: number;
}

export interface InboundOutcome {
  stored: number;
  dropped: number;
  forwarded: number;
  /** Why Resend should retry (a code, no mail data); null when every copy is settled. */
  retry: string | null;
}

/** Resend ids are UUIDs; the id goes into a URL path and the logs, so nothing else passes. */
const RESEND_EMAIL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_UNPROCESSABLE = 422;
const FORWARD_NOTE =
  "Received by Klorn for a system address. The original message is attached unchanged.";

const SETTLED: InboundOutcome = { stored: 0, dropped: 0, forwarded: 0, retry: null };

export function isResendEmailId(value: unknown): value is string {
  return typeof value === "string" && RESEND_EMAIL_ID.test(value);
}

function combine(a: InboundOutcome, b: InboundOutcome): InboundOutcome {
  return {
    stored: a.stored + b.stored,
    dropped: a.dropped + b.dropped,
    forwarded: a.forwarded + b.forwarded,
    retry: a.retry ?? b.retry,
  };
}

const count = (field: "stored" | "dropped" | "forwarded", n = 1): InboundOutcome => ({
  ...SETTLED,
  [field]: n,
});
const retryFor = (reason: string): InboundOutcome => ({ ...SETTLED, retry: reason });

function parseEventData(data: unknown): ResendReceivedEventData | null {
  if (typeof data !== "object" || data === null) return null;
  const event = data as ResendReceivedEventData;
  if (!isResendEmailId(event.email_id)) return null;
  if (typeof event.created_at !== "string") return null;
  return Number.isNaN(new Date(event.created_at).getTime()) ? null : event;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Resend did not answer in time")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 404: Resend no longer has the message. 400/422: Resend refuses this request
 * for good. Anything else (no status, 401/403 for a key that cannot read
 * received mail, 429, 5xx) is worth a retry.
 */
function isPermanentResendError(error: ErrorResponse | null): boolean {
  const status = error?.statusCode;
  return status === HTTP_NOT_FOUND || status === HTTP_BAD_REQUEST || status === HTTP_UNPROCESSABLE;
}

const resendRetryReason = (call: string, error: ErrorResponse | null) =>
  `resend-${call}-${error?.statusCode ?? "network"}`;

async function forwardOne(
  emailId: string,
  handle: string,
  settings: InboundSettings & { forwardTo: string },
  api: InboundReceivingApi,
): Promise<InboundOutcome> {
  try {
    const response = await withTimeout(
      api.forward(
        {
          emailId,
          to: settings.forwardTo,
          from: `${handle}@${settings.domain}`,
          passthrough: false,
          text: FORWARD_NOTE,
        },
        { idempotencyKey: `klorn-forward:${emailId}:${handle}` },
      ),
      settings.timeoutMs,
    );
    if (!response.error) return count("forwarded");
    if (isPermanentResendError(response.error)) return count("dropped");
    return retryFor(resendRetryReason("forward", response.error));
  } catch {
    return retryFor("resend-forward-network");
  }
}

async function forwardSystemMail(
  emailId: string,
  system: string[],
  settings: InboundSettings,
  api: InboundReceivingApi,
): Promise<InboundOutcome> {
  const { forwardTo } = settings;
  if (system.length === 0) return SETTLED;
  if (!forwardTo) return count("dropped", system.length);
  let outcome = SETTLED;
  for (const handle of system) {
    outcome = combine(outcome, await forwardOne(emailId, handle, { ...settings, forwardTo }, api));
  }
  return outcome;
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

type MailboxDecision = { kind: "drop" } | { kind: "exists" } | { kind: "deliver"; id: string };

function mailboxDecision(
  userId: string,
  address: string,
  emailId: string,
  receivedAt: Date,
): Promise<MailboxDecision> {
  return withTenant(userId, async (tx): Promise<MailboxDecision> => {
    const mailbox = await tx.linkedInboxAccount.findFirst({
      where: { userId, provider: KLORN_PROVIDER, email: address },
      select: { id: true },
    });
    if (!mailbox) return { kind: "drop" };
    const wipe = await tx.dataWipe.findUnique({ where: { userId }, select: { purgedAt: true } });
    if (wipe?.purgedAt && receivedAt < wipe.purgedAt) return { kind: "drop" };
    const existing = await tx.emailMessage.findUnique({
      where: { userId_gmailId: { userId, gmailId: klornMessageId(address, emailId) } },
      select: { id: true },
    });
    return existing ? { kind: "exists" } : { kind: "deliver", id: mailbox.id };
  });
}

async function resolveTargets(
  event: ResendReceivedEventData,
  handles: string[],
  domain: string,
): Promise<{ outcome: InboundOutcome; targets: Target[] }> {
  if (handles.length === 0) return { outcome: SETTLED, targets: [] };
  const owners = await lookupOwners(handles);
  const receivedAt = new Date(event.created_at);
  let outcome = count("dropped", handles.length - owners.size);
  const targets: Target[] = [];
  for (const [handle, userId] of owners) {
    const address = `${handle}@${domain}`;
    const decision = await mailboxDecision(userId, address, event.email_id, receivedAt);
    if (decision.kind === "deliver") {
      targets.push({ userId, address, linkedInboxAccountId: decision.id });
    } else {
      outcome = combine(outcome, count(decision.kind === "exists" ? "stored" : "dropped"));
    }
  }
  return { outcome, targets };
}

type ContentResult =
  | { kind: "ok"; content: ResendReceivedContent }
  | { kind: "gone" }
  | { kind: "retry"; reason: string };

async function fetchContent(
  api: InboundReceivingApi,
  emailId: string,
  timeoutMs: number,
): Promise<ContentResult> {
  try {
    const response = await withTimeout(api.get(emailId), timeoutMs);
    if (response.data) return { kind: "ok", content: response.data as ResendReceivedContent };
    if (isPermanentResendError(response.error)) return { kind: "gone" };
    return { kind: "retry", reason: resendRetryReason("get", response.error) };
  } catch {
    return { kind: "retry", reason: "resend-get-network" };
  }
}

/** Postgres refuses this value for good: a retry would fail the same way. */
const DETERMINISTIC_PRISMA_CODES = new Set([
  "P2000", // value too long for the column
  "P2005", // invalid stored value
  "P2006", // invalid value
  "P2007", // data validation error
  "P2011", // null constraint
  "P2012", // missing required value
  "P2019", // input error
  "P2020", // value out of range
  "P2023", // inconsistent column data
  "P2033", // number does not fit
]);
const PRISMA_RAW_QUERY_FAILED = "P2010";
/** SQLSTATE class 22, data exception (22021: invalid byte sequence, 22P05: untranslatable). */
const PG_DATA_EXCEPTION_CLASS = "22";
const PG_DATA_EXCEPTION_IN_MESSAGE = /\bcode: "22[0-9A-Z]{3}"/;

export type StoreErrorKind = "fenced" | "stored" | "rejected" | "unknown";

export function classifyStoreError(err: unknown): StoreErrorKind {
  if (isDataWipeFenceError(err)) return "fenced";
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") return "stored";
    if (DETERMINISTIC_PRISMA_CODES.has(err.code)) return "rejected";
    const sqlState = (err.meta as { code?: unknown } | undefined)?.code;
    const dataException =
      typeof sqlState === "string" && sqlState.startsWith(PG_DATA_EXCEPTION_CLASS);
    return err.code === PRISMA_RAW_QUERY_FAILED && dataException ? "rejected" : "unknown";
  }
  if (err instanceof Prisma.PrismaClientValidationError) return "rejected";
  if (err instanceof Prisma.PrismaClientUnknownRequestError) {
    return PG_DATA_EXCEPTION_IN_MESSAGE.test(err.message) ? "rejected" : "unknown";
  }
  return "unknown";
}

/** The class of an error and its Prisma code: what may be reported, never its message. */
export function errorKind(err: unknown): string {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return `${err.name} ${err.code}`;
  return err instanceof Error ? err.name : typeof err;
}

async function storeCopy(
  target: Target,
  content: ResendReceivedContent,
  event: ResendReceivedEventData,
): Promise<InboundOutcome> {
  const raw = resendToRawEmail(content, event, target.address);
  try {
    await persistGmailEmail(target.userId, raw, {
      userEmail: target.address,
      linkedInboxAccountId: target.linkedInboxAccountId,
    });
    return count("stored");
  } catch (err) {
    const kind = classifyStoreError(err);
    if (kind === "stored") return count("stored");
    if (kind === "rejected") return count("dropped");
    if (kind === "fenced") return retryFor("data-wipe");
    captureError(new Error(`Klorn inbound store failed: ${errorKind(err)}`), {
      tags: { scope: "klorn-inbound.store" },
      extra: { emailId: event.email_id },
    });
    return retryFor("store");
  }
}

async function deliverToUsers(
  event: ResendReceivedEventData,
  handles: string[],
  settings: InboundSettings,
  api: InboundReceivingApi,
): Promise<InboundOutcome> {
  const { outcome, targets } = await resolveTargets(event, handles, settings.domain);
  // With no live recipient, the content is never fetched.
  if (targets.length === 0) return outcome;
  const fetched = await fetchContent(api, event.email_id, settings.timeoutMs);
  if (fetched.kind === "retry") return combine(outcome, retryFor(fetched.reason));
  if (fetched.kind === "gone") return combine(outcome, count("dropped", targets.length));
  let delivered = outcome;
  for (const target of targets) {
    delivered = combine(delivered, await storeCopy(target, fetched.content, event));
  }
  return delivered;
}

/** `data` is the verified event's `data`; a malformed one is dropped (counted once). */
export async function deliverInboundEmail(
  data: unknown,
  settings: InboundSettings,
  api: InboundReceivingApi,
): Promise<InboundOutcome> {
  const event = parseEventData(data);
  if (!event) return count("dropped");
  const recipients = inboundRecipients(
    event as unknown as Record<string, unknown>,
    settings.domain,
  );
  const forwarded = await forwardSystemMail(event.email_id, recipients.system, settings, api);
  const delivered = await deliverToUsers(event, recipients.handles, settings, api);
  return combine(count("dropped", recipients.dropped), combine(forwarded, delivered));
}
