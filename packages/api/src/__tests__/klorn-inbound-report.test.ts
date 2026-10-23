/**
 * The Klorn mailbox inbound webhook's process-wide limits (step E1b of
 * docs/providers/unified-platform-plan.md): what reaches an operator and how
 * often, the notice budget's keyed token bucket, and the bounded slots that
 * queue fetch-and-store and notices.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const captureError = vi.hoisted(() => vi.fn());
vi.mock("../sentry.js", () => ({ captureError }));

import { NoticeBucket, sendNotices } from "../mail/klorn-inbound-notice.js";
import type { InboundContext } from "../mail/klorn-inbound-outcome.js";
import { createInboundReporter, REPORT_WINDOW_MS } from "../mail/klorn-inbound-report.js";
import { BoundedSlots } from "../mail/klorn-inbound-slots.js";

let clock = 0;
const now = () => clock;

beforeEach(() => {
  clock = 1_000_000;
  captureError.mockReset();
});

describe("createInboundReporter", () => {
  it("reports a scope once per hour, then re-arms with the count it held back", () => {
    const reporter = createInboundReporter(now);
    reporter.report("resend-auth", { status: 401 });
    reporter.report("resend-auth", { status: 403 });
    clock += REPORT_WINDOW_MS - 1;
    reporter.report("resend-auth", { status: 401 });
    expect(captureError).toHaveBeenCalledTimes(1);
    expect(captureError.mock.calls[0][1].extra).toEqual({ status: 401 });

    clock += 1;
    reporter.report("resend-auth", { status: 403 });
    expect(captureError).toHaveBeenCalledTimes(2);
    expect(captureError.mock.calls[1][1]).toEqual({
      tags: { scope: "klorn-mailbox.resend-auth" },
      extra: { status: 403, suppressed: 2 },
    });

    clock += REPORT_WINDOW_MS;
    reporter.report("resend-auth", { status: 401 });
    expect(captureError.mock.calls[2][1].extra).toEqual({ status: 401 });
  });

  it("limits each scope on its own", () => {
    const reporter = createInboundReporter(now);
    reporter.report("resend-auth", { status: 401 });
    reporter.report("store-refused", { emailId: "e1" });
    reporter.report("store-refused", { emailId: "e2" });
    expect(captureError.mock.calls.map(([, c]) => c.tags.scope)).toEqual([
      "klorn-mailbox.resend-auth",
      "klorn-mailbox.store-refused",
    ]);
  });

  it("names the scope and the kind in the event, never anything else", () => {
    const reporter = createInboundReporter(now);
    reporter.report("unexpected", { emailId: "e1", kind: "TypeError" });
    const [error] = captureError.mock.calls[0];
    expect(String(error)).toBe("Error: [klorn-mailbox] unexpected: TypeError");
  });

  it("logs a line once per key per hour", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reporter = createInboundReporter(now);
    reporter.log("warn", "signature:bad", "[klorn-inbound] rejected reason=bad-signature");
    reporter.log("warn", "signature:bad", "[klorn-inbound] rejected reason=bad-signature");
    reporter.log("warn", "signature:missing", "[klorn-inbound] rejected reason=missing-headers");
    clock += REPORT_WINDOW_MS;
    reporter.log("warn", "signature:bad", "[klorn-inbound] rejected reason=bad-signature");
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });
});

describe("NoticeBucket", () => {
  it("allows its capacity at once, then refills evenly over the period", () => {
    const bucket = new NoticeBucket(2, 60 * 60_000, now);
    expect([bucket.take("a"), bucket.take("b"), bucket.take("c")]).toEqual([true, true, false]);
    clock += 30 * 60_000;
    expect([bucket.take("d"), bucket.take("e")]).toEqual([true, false]);
    clock += 10 * 60 * 60_000;
    expect([bucket.take("f"), bucket.take("g"), bucket.take("h")]).toEqual([true, true, false]);
  });

  it("lets a key that holds a token take it again within the period", () => {
    const bucket = new NoticeBucket(1, 60 * 60_000, now);
    expect(bucket.take("e1:postmaster")).toBe(true);
    expect(bucket.take("e1:postmaster")).toBe(true);
    expect(bucket.take("e2:postmaster")).toBe(false);
    clock += 60 * 60_000;
    expect(bucket.take("e2:postmaster")).toBe(true);
  });
});

describe("BoundedSlots", () => {
  it("runs up to its concurrency, queues up to its limit, and refuses past it at once", async () => {
    const slots = new BoundedSlots(1, 1);
    let release = () => {};
    const first = slots.run(
      () => new Promise<string>((resolve) => (release = () => resolve("first"))),
      () => false,
    );
    const second = slots.run(
      async () => "second",
      () => false,
    );
    const third = await slots.run(
      async () => "third",
      () => false,
    );
    expect(third).toEqual({ ran: false, reason: "busy" });
    release();
    expect(await first).toEqual({ ran: true, value: "first" });
    expect(await second).toEqual({ ran: true, value: "second" });
  });

  it("skips queued work whose deadline passed while it waited", async () => {
    const slots = new BoundedSlots(1, 4);
    let release = () => {};
    const first = slots.run(
      () => new Promise<void>((resolve) => (release = resolve)),
      () => false,
    );
    let expired = false;
    const work = vi.fn(async () => "late");
    const queued = slots.run(work, () => expired);
    expired = true;
    release();
    await first;
    expect(await queued).toEqual({ ran: false, reason: "expired" });
    expect(work).not.toHaveBeenCalled();
    // The slot was handed on: new work still runs.
    expect(
      await slots.run(
        async () => "next",
        () => false,
      ),
    ).toEqual({ ran: true, value: "next" });
  });
});

describe("BoundedSlots under a deadline", () => {
  it("frees the slot at the deadline when the work hangs, and reports a late failure", async () => {
    const slots = new BoundedSlots(1, 4);
    let fail: (err: Error) => void = () => {};
    const late = vi.fn();
    const hung = slots.run(
      () => new Promise<string>((_resolve, reject) => (fail = reject)),
      () => false,
      () => 20,
      late,
    );
    expect(await hung).toEqual({ ran: false, reason: "expired" });
    expect(
      await slots.run(
        async () => "next",
        () => false,
      ),
    ).toEqual({ ran: true, value: "next" });
    fail(new Error("db"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(late).toHaveBeenCalledWith(expect.any(Error));
  });

  it("returns the work's own failure when it fails in time", async () => {
    const slots = new BoundedSlots(1, 4);
    const late = vi.fn();
    await expect(
      slots.run(
        async () => Promise.reject(new Error("boom")),
        () => false,
        () => 1_000,
        late,
      ),
    ).rejects.toThrow("boom");
    expect(late).not.toHaveBeenCalled();
  });
});

describe("sendNotices", () => {
  it("takes no token and sends nothing once the request's deadline has passed", async () => {
    const take = vi.fn(() => true);
    const send = vi.fn();
    const ctx = {
      domain: "klorn.ai",
      forwardTo: "support@example.com",
      api: { get: vi.fn(), send },
      reporter: createInboundReporter(now),
      runtime: {
        noticeBucket: { take },
        noticeSlots: new BoundedSlots(1, 4),
        deliverySlots: new BoundedSlots(4, 32),
      },
      timeoutMs: 1_000,
      deadlineAt: clock - 1,
      now,
    } as unknown as InboundContext;
    const event = { emailId: "e1", receivedAt: new Date(clock), data: {} };

    const outcome = await sendNotices(["postmaster", "abuse"], event, ctx);
    expect(outcome).toMatchObject({ retry: "deadline", pending: 2, notified: 0 });
    expect(take).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
