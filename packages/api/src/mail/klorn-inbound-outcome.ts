/**
 * The outcome of delivering one Resend `email.received` event, and the context
 * delivery runs in (step E1b of docs/providers/unified-platform-plan.md). Shared
 * by mail/klorn-inbound.ts (users' copies) and mail/klorn-inbound-notice.ts
 * (system mail).
 */

import type { InboundReporter } from "./klorn-inbound-report.js";
import type { InboundResendApi, ResendResult } from "./klorn-inbound-resend.js";
import type { BoundedSlots } from "./klorn-inbound-slots.js";

export interface InboundOutcome {
  stored: number;
  dropped: number;
  /** System mail (postmaster@, abuse@) an operator was told of. */
  notified: number;
  /** Copies waiting for Resend's retry. */
  pending: number;
  /** Why Resend should retry (a code, no mail data); null when every copy is settled. */
  retry: string | null;
}

/** State shared by every delivery of one registered route: process-wide in production. */
export interface InboundRuntime {
  /**
   * Notices of system mail allowed per hour (anyone can send to these
   * addresses), keyed per `emailId:handle` so Resend's retries reuse a token.
   */
  noticeBucket: { take(key: string): boolean };
  /** One notice at a time. */
  noticeSlots: BoundedSlots;
  /** Concurrent lookups, content fetches and stores, with a bounded queue. */
  deliverySlots: BoundedSlots;
}

export interface InboundContext {
  /** ASCII lowercase. */
  domain: string;
  forwardTo: string | null;
  api: InboundResendApi;
  reporter: InboundReporter;
  runtime: InboundRuntime;
  /** One Resend call's budget. */
  timeoutMs: number;
  /** The request's overall deadline (epoch ms): no new work starts after it. */
  deadlineAt: number;
  now: () => number;
}

export interface ParsedEvent {
  emailId: string;
  receivedAt: Date;
  data: Record<string, unknown>;
}

/** Resend may not serve a message it has just announced: a 404 is retried until then. */
export const YOUNG_EVENT_MS = 10 * 60_000;

export const SETTLED: InboundOutcome = {
  stored: 0,
  dropped: 0,
  notified: 0,
  pending: 0,
  retry: null,
};

export function combine(a: InboundOutcome, b: InboundOutcome): InboundOutcome {
  return {
    stored: a.stored + b.stored,
    dropped: a.dropped + b.dropped,
    notified: a.notified + b.notified,
    pending: a.pending + b.pending,
    retry: a.retry ?? b.retry,
  };
}

export function count(field: "stored" | "dropped" | "notified", n = 1): InboundOutcome {
  return { ...SETTLED, [field]: n };
}

export function retryFor(reason: string, copies = 1): InboundOutcome {
  return { ...SETTLED, pending: copies, retry: reason };
}

/** What is left of the request for one call: never more than one call's budget. */
export function callBudget(ctx: InboundContext): number {
  return Math.min(ctx.timeoutMs, ctx.deadlineAt - ctx.now());
}

export function pastDeadline(ctx: InboundContext): boolean {
  return ctx.now() >= ctx.deadlineAt;
}

/** A refused or expired slot: every copy it covered waits for Resend's retry. */
export function slotRetry(reason: "busy" | "expired", copies: number): InboundOutcome {
  return retryFor(reason === "busy" ? "busy" : "deadline", copies);
}

/**
 * The outcome of a failed Resend call for `copies` copies, and its report. The
 * report is the side effect this names: see klorn-inbound-resend.ts for what
 * each failure means.
 */
export function reportResendFailure(
  call: "get" | "send",
  result: Extract<ResendResult<unknown>, { ok: false }>,
  copies: number,
  event: ParsedEvent,
  ctx: InboundContext,
): InboundOutcome {
  const { reporter } = ctx;
  const status = result.status ?? undefined;
  const reason = `resend-${call}-${result.status ?? result.kind}`;
  switch (result.failure) {
    case "auth":
      reporter.report("resend-auth", { status });
      return retryFor(reason, copies);
    case "account":
      reporter.report("resend-account", { status, kind: result.kind });
      return retryFor(reason, copies);
    case "missing":
      if (ctx.now() - event.receivedAt.getTime() < YOUNG_EVENT_MS) return retryFor(reason, copies);
      reporter.report("resend-missing", { emailId: event.emailId, status });
      return count("dropped", copies);
    case "permanent":
      reporter.report("resend-refused", { emailId: event.emailId, status, kind: call });
      return count("dropped", copies);
    case "unexpected":
      reporter.report("unexpected", { emailId: event.emailId, kind: result.kind });
      return retryFor(reason, copies);
    default:
      return retryFor(reason, copies);
  }
}
