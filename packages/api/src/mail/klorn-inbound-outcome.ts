/**
 * The outcome of delivering one Resend `email.received` event, and the context
 * delivery runs in (step E1b of docs/providers/unified-platform-plan.md). Shared
 * by mail/klorn-inbound.ts (users' copies) and mail/klorn-inbound-forward.ts
 * (system mail).
 */

import type { Semaphore } from "../semaphore.js";
import type { InboundReporter } from "./klorn-inbound-report.js";
import type { InboundResendApi, ResendResult } from "./klorn-inbound-resend.js";

export interface InboundOutcome {
  stored: number;
  dropped: number;
  forwarded: number;
  /** Copies waiting for Resend's retry. */
  pending: number;
  /** Why Resend should retry (a code, no mail data); null when every copy is settled. */
  retry: string | null;
}

/** State shared by every delivery of one registered route: process-wide in production. */
export interface InboundRuntime {
  /** Forwards of system mail allowed per hour (an unauthenticated sender's amplifier). */
  forwardBucket: { take(): boolean };
  /** One forward at a time: each makes Resend download and re-send the raw message. */
  forwardSlots: Semaphore;
  /** Concurrent content fetches and stores. */
  deliverySlots: Semaphore;
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
  forwarded: 0,
  pending: 0,
  retry: null,
};

export function combine(a: InboundOutcome, b: InboundOutcome): InboundOutcome {
  return {
    stored: a.stored + b.stored,
    dropped: a.dropped + b.dropped,
    forwarded: a.forwarded + b.forwarded,
    pending: a.pending + b.pending,
    retry: a.retry ?? b.retry,
  };
}

export function count(field: "stored" | "dropped" | "forwarded", n = 1): InboundOutcome {
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

/**
 * The outcome of a failed Resend call for `copies` copies, and its report. The
 * report is the side effect this names: see klorn-inbound-resend.ts for what
 * each failure means.
 */
export function reportResendFailure(
  call: "get" | "forward" | "send",
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
