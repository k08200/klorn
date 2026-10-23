/**
 * Mail to postmaster@ and abuse@ (L18): the support inbox gets a NOTICE, never
 * the mail itself (step E1b of docs/providers/unified-platform-plan.md, security
 * re-verification N3). The original stays readable in the Resend dashboard
 * (Receiving), under the email id the notice names.
 *
 * Why not forward: anyone can send to these addresses, and a forward re-sends
 * the sender's subject ("Fwd: <subject>") and content DKIM-signed from Klorn's
 * own domain, a phishing channel straight to the operator; and the SDK's
 * forward downloads the whole raw message with no abort. A notice carries no
 * sender-controlled field: a fixed subject built from the handle, the domain
 * and the validated email id, and a constant text.
 *
 * Bounded: a token bucket (NOTICES_PER_HOUR) keyed per `emailId:handle`, so
 * Resend's retries of one event reuse its token; past it the mail is dropped,
 * counted and reported. One notice at a time, with a bounded queue. No token
 * is taken once the request's deadline has passed.
 */

import type { InboundContext, InboundOutcome, ParsedEvent } from "./klorn-inbound-outcome.js";
import {
  callBudget,
  combine,
  count,
  pastDeadline,
  reportResendFailure,
  retryFor,
  SETTLED,
  slotRetry,
} from "./klorn-inbound-outcome.js";
import { callResend } from "./klorn-inbound-resend.js";

export const NOTICES_PER_HOUR = 20;
/**
 * RFC 3834 and the de facto equivalents: the support inbox's auto-replies and
 * vacation answers must not come back to postmaster@ or abuse@ and start a loop.
 */
const LOOP_PREVENTION_HEADERS: Readonly<Record<string, string>> = {
  "Auto-Submitted": "auto-generated",
  "X-Auto-Response-Suppress": "All",
  Precedence: "bulk",
};
const HOUR_MS = 60 * 60_000;
const NOTICE_TEXT = [
  "Klorn received mail for a system address.",
  "The message itself is not attached or quoted: open it in the Resend dashboard,",
  "under Emails > Receiving, by the email id in the subject.",
].join("\n");

/**
 * `capacity` tokens, refilled evenly over `periodMs`. A key that took a token in
 * the last period takes it again for free, so a retried event costs one token.
 */
export class NoticeBucket {
  private tokens: number;
  private updatedAt: number;
  private readonly held = new Map<string, number>();

  constructor(
    private readonly capacity: number,
    private readonly periodMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.updatedAt = now();
  }

  take(key: string): boolean {
    const at = this.now();
    for (const [heldKey, takenAt] of this.held) {
      if (at - takenAt >= this.periodMs) this.held.delete(heldKey);
    }
    if (this.held.has(key)) return true;
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((at - this.updatedAt) / this.periodMs) * this.capacity,
    );
    this.updatedAt = at;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    this.held.set(key, at);
    return true;
  }
}

export function noticeBucket(perHour: number, now: () => number): NoticeBucket {
  return new NoticeBucket(perHour, HOUR_MS, now);
}

async function sendNotice(
  handle: string,
  noticeTo: string,
  event: ParsedEvent,
  ctx: InboundContext,
): Promise<InboundOutcome> {
  const from = `${handle}@${ctx.domain}`;
  const result = await callResend(
    () =>
      ctx.api.send(
        {
          from,
          to: noticeTo,
          subject: `Mail to ${from} — Resend email ${event.emailId}`,
          text: NOTICE_TEXT,
          headers: LOOP_PREVENTION_HEADERS,
        },
        { idempotencyKey: `klorn-notice:${event.emailId}:${handle}` },
      ),
    callBudget(ctx),
  );
  if (result.ok) return count("notified");
  return reportResendFailure("send", result, 1, event, ctx);
}

async function noticeOne(
  handle: string,
  noticeTo: string,
  event: ParsedEvent,
  ctx: InboundContext,
): Promise<InboundOutcome> {
  if (!ctx.runtime.noticeBucket.take(`${event.emailId}:${handle}`)) {
    ctx.reporter.report("notice-limit", { emailId: event.emailId });
    return count("dropped");
  }
  const sent = await ctx.runtime.noticeSlots.run(
    () => sendNotice(handle, noticeTo, event, ctx),
    () => pastDeadline(ctx),
    () => ctx.deadlineAt - ctx.now(),
  );
  return sent.ran ? sent.value : slotRetry(sent.reason, 1);
}

/** One notice per system handle the event names; `ctx.forwardTo` is the support inbox. */
export async function sendNotices(
  handles: string[],
  event: ParsedEvent,
  ctx: InboundContext,
): Promise<InboundOutcome> {
  const noticeTo = ctx.forwardTo;
  if (handles.length === 0 || !noticeTo) return count("dropped", handles.length);
  let outcome = SETTLED;
  for (const [index, handle] of handles.entries()) {
    // No token is taken for work that can no longer finish in this request.
    if (pastDeadline(ctx)) return combine(outcome, retryFor("deadline", handles.length - index));
    outcome = combine(outcome, await noticeOne(handle, noticeTo, event, ctx));
  }
  return outcome;
}
