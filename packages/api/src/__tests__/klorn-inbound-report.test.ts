/**
 * What reaches an operator from the Klorn mailbox's inbound webhook, and how
 * often (step E1b of docs/providers/unified-platform-plan.md): one Sentry event
 * per scope per hour, re-armed after it, and the forward budget's token bucket.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const captureError = vi.hoisted(() => vi.fn());
vi.mock("../sentry.js", () => ({ captureError }));

import { TokenBucket } from "../mail/klorn-inbound-forward.js";
import { createInboundReporter, REPORT_WINDOW_MS } from "../mail/klorn-inbound-report.js";

let clock = 0;
const now = () => clock;

beforeEach(() => {
  clock = 1_000_000;
  captureError.mockReset();
});

describe("createInboundReporter", () => {
  it("reports a scope once per hour, then re-arms", () => {
    const reporter = createInboundReporter(now);
    reporter.report("resend-auth", { status: 401 });
    reporter.report("resend-auth", { status: 403 });
    clock += REPORT_WINDOW_MS - 1;
    reporter.report("resend-auth", { status: 401 });
    expect(captureError).toHaveBeenCalledTimes(1);

    clock += 1;
    reporter.report("resend-auth", { status: 403 });
    expect(captureError).toHaveBeenCalledTimes(2);
    expect(captureError.mock.calls[1][1]).toEqual({
      tags: { scope: "klorn-mailbox.resend-auth" },
      extra: { status: 403 },
    });
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

describe("TokenBucket", () => {
  it("allows its capacity at once, then refills evenly over the hour", () => {
    const bucket = new TokenBucket(2, 60 * 60_000, now);
    expect([bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, false]);
    clock += 30 * 60_000;
    expect([bucket.take(), bucket.take()]).toEqual([true, false]);
    clock += 10 * 60 * 60_000;
    expect([bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, false]);
  });
});
