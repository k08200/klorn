/**
 * Mail to postmaster@ and abuse@ reaches the support inbox (L18), bounded (step
 * E1b of docs/providers/unified-platform-plan.md, security review H1).
 *
 * Anyone can send to these addresses, and each forward makes Resend's SDK
 * download the whole raw message and send it again from Klorn's account, so:
 * - a token bucket (FORWARDS_PER_HOUR); past it the mail is dropped, counted
 *   and reported;
 * - one forward at a time, process-wide;
 * - a message estimated over MAX_FORWARD_BYTES (text, HTML and attachment
 *   sizes from the content already fetched) is not forwarded: a notice with a
 *   fixed subject goes instead, carrying no sender-controlled text;
 * - the SDK's wrapped mode (`passthrough: false`, the original attached as
 *   .eml): its passthrough mode runs postal-mime on the raw message on the
 *   event loop.
 * Residual: the SDK's own download of the raw message takes no abort signal
 * (resend 6.20.0 `forwardWrapped` calls `fetch` with no options), so a call
 * past its budget answers retry here while that download may still run.
 */

import type { InboundContext, InboundOutcome, ParsedEvent } from "./klorn-inbound-outcome.js";
import {
  callBudget,
  combine,
  count,
  reportResendFailure,
  SETTLED,
} from "./klorn-inbound-outcome.js";
import { callResend } from "./klorn-inbound-resend.js";

export const FORWARDS_PER_HOUR = 20;
export const MAX_FORWARD_BYTES = 2 * 1024 * 1024;
const HOUR_MS = 60 * 60_000;
const FORWARD_NOTE =
  "Received by Klorn for a system address. The original message is attached; it may be re-encoded.";
const NOTICE_TEXT =
  "Received by Klorn for a system address, and too large to forward. Find it in Resend under the email id in the subject.";

/** `capacity` tokens, refilled evenly over `periodMs`. */
export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly capacity: number,
    private readonly periodMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.updatedAt = now();
  }

  take(): boolean {
    const at = this.now();
    const refill = ((at - this.updatedAt) / this.periodMs) * this.capacity;
    this.tokens = Math.min(this.capacity, this.tokens + refill);
    this.updatedAt = at;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export function forwardBucket(perHour: number, now: () => number): TokenBucket {
  return new TokenBucket(perHour, HOUR_MS, now);
}

/** What forwarding would carry, from the parsed content (not the raw message). */
export function estimatedSize(content: unknown): number {
  const { text, html, attachments } = (content ?? {}) as Record<string, unknown>;
  const length = (value: unknown) => (typeof value === "string" ? value.length : 0);
  const attached = Array.isArray(attachments)
    ? attachments.reduce<number>((sum, item) => {
        const size = (item as { size?: unknown } | null)?.size;
        return sum + (typeof size === "number" && size > 0 ? size : 0);
      }, 0)
    : 0;
  return length(text) + length(html) + attached;
}

async function forwardOne(
  handle: string,
  forwardTo: string,
  oversized: boolean,
  event: ParsedEvent,
  ctx: InboundContext,
): Promise<InboundOutcome> {
  const from = `${handle}@${ctx.domain}`;
  const result = oversized
    ? await callResend(
        () =>
          ctx.api.send(
            {
              from,
              to: forwardTo,
              subject: `Mail to ${from} too large to forward — Resend email ${event.emailId}`,
              text: NOTICE_TEXT,
            },
            { idempotencyKey: `klorn-forward-notice:${event.emailId}:${handle}` },
          ),
        callBudget(ctx),
      )
    : await callResend(
        () =>
          ctx.api.forward(
            { emailId: event.emailId, to: forwardTo, from, passthrough: false, text: FORWARD_NOTE },
            { idempotencyKey: `klorn-forward:${event.emailId}:${handle}` },
          ),
        callBudget(ctx),
      );
  if (result.ok) return count("forwarded");
  return reportResendFailure(oversized ? "send" : "forward", result, 1, event, ctx);
}

/** `content` is the message as fetched for this event (its size decides the mode). */
export async function forwardSystemMail(
  handles: string[],
  content: unknown,
  event: ParsedEvent,
  ctx: InboundContext,
): Promise<InboundOutcome> {
  const { forwardTo } = ctx;
  if (handles.length === 0 || !forwardTo) return count("dropped", handles.length);
  const oversized = estimatedSize(content) > MAX_FORWARD_BYTES;
  let outcome = SETTLED;
  for (const handle of handles) {
    if (!ctx.runtime.forwardBucket.take()) {
      ctx.reporter.report("forward-limit", { emailId: event.emailId });
      outcome = combine(outcome, count("dropped"));
      continue;
    }
    const forwarded = await ctx.runtime.forwardSlots.run(() =>
      forwardOne(handle, forwardTo, oversized, event, ctx),
    );
    outcome = combine(outcome, forwarded);
  }
  return outcome;
}
