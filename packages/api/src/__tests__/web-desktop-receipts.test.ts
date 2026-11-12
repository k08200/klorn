/**
 * Windows desktop shell (apps/desktop-win, Tauri) — notification receipts
 * (packages/web/src/lib/native/desktop-receipts.ts), reported to
 * POST /api/notifications/desktop/receipts (routes/desktop-receipts.ts, #1720):
 *   - which banners have a receipt: a bell row id (a uuid) only — never the
 *     catch-up summary (`missed:<id>`), which stands for several rows;
 *   - fire-and-forget: `report` returns at once and never throws;
 *   - a network error or a 5xx is retried with backoff, then dropped;
 *     a 4xx (400 / 401 / 404 / 429) is never retried (the contract);
 *   - requests are paced under the server's 60 / min per user, and a 429
 *     pauses the queue for a window.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ prisma: {} }));

import {
  createReceiptReporter,
  type DesktopReceipt,
  installToastClickHandler,
  nextSendAtMs,
  RECEIPT_QUEUE_MAX,
  RECEIPT_RATE_MAX,
  RECEIPT_RATE_WINDOW_MS,
  RECEIPT_RETRY_DELAYS_MS,
  RECEIPT_SEND_TIMEOUT_MS,
  receiptFor,
  verdictForStatus,
} from "../../../web/src/lib/native/desktop-receipts";

const ID = "0b9f6c1e-4a51-4d1e-9c4f-2f7d1f0a9b3c";

function receipt(id = ID, event: DesktopReceipt["event"] = "shown"): DesktopReceipt {
  return { app: "windows", event, kind: "notification", id };
}

/** A transport on vitest's fake clock; `statuses` answers each send in turn
 *  (an Error rejects, as fetch does on a network failure). */
function transport(statuses: Array<number | Error> = []) {
  const sent: DesktopReceipt[] = [];
  const answers = [...statuses];
  const send = vi.fn(async (r: DesktopReceipt) => {
    sent.push(r);
    const next = answers.shift() ?? 204;
    if (next instanceof Error) throw next;
    return next;
  });
  return {
    sent,
    send,
    deps: {
      send,
      now: () => Date.now(),
      schedule: (run: () => void, delayMs: number) => {
        const timer = setTimeout(run, delayMs);
        return () => clearTimeout(timer);
      },
    },
  };
}

describe("receiptFor — which banners report", () => {
  it("a bell row id is a notification receipt for the Windows app", () => {
    expect(receiptFor("shown", ID)).toEqual({
      app: "windows",
      event: "shown",
      kind: "notification",
      id: ID,
    });
    expect(receiptFor("clicked", ID.toUpperCase())?.event).toBe("clicked");
  });

  it("the catch-up summary and anything not a uuid has no receipt", () => {
    for (const id of [
      `missed:${ID}`,
      "",
      "not-a-uuid",
      `${ID}x`,
      ID.slice(1),
      `${ID.slice(0, 35)}'`,
      undefined,
      null,
      42,
    ]) {
      expect(receiptFor("shown", id)).toBeNull();
    }
  });
});

describe("verdictForStatus — the contract's retry rule", () => {
  it("2xx is done, 5xx is retried, every 4xx is dropped", () => {
    expect(verdictForStatus(204)).toBe("done");
    expect(verdictForStatus(200)).toBe("done");
    expect(verdictForStatus(500)).toBe("retry");
    expect(verdictForStatus(503)).toBe("retry");
    for (const status of [400, 401, 403, 404, 429]) {
      expect(verdictForStatus(status)).toBe("drop");
    }
  });
});

describe("nextSendAtMs — pacing under the server's limit", () => {
  it("sends now while under the cap", () => {
    expect(nextSendAtMs([], 1_000)).toBe(1_000);
    const under = Array.from({ length: RECEIPT_RATE_MAX - 1 }, (_, i) => i);
    expect(nextSendAtMs(under, 1_000)).toBe(1_000);
  });

  it("at the cap, waits until the oldest send in the window ages out", () => {
    const full = Array.from({ length: RECEIPT_RATE_MAX }, (_, i) => 100 + i);
    expect(nextSendAtMs(full, 5_000)).toBe(100 + RECEIPT_RATE_WINDOW_MS);
  });

  it("sends older than the window do not count", () => {
    const old = Array.from({ length: RECEIPT_RATE_MAX }, () => 0);
    expect(nextSendAtMs(old, RECEIPT_RATE_WINDOW_MS + 1)).toBe(RECEIPT_RATE_WINDOW_MS + 1);
  });

  it("a clock moved back never stalls: sends in the future do not count", () => {
    const future = Array.from({ length: RECEIPT_RATE_MAX }, () => 10 * RECEIPT_RATE_WINDOW_MS);
    expect(nextSendAtMs(future, 1_000)).toBe(1_000);
  });

  it("stays under the server's 60 per minute", () => {
    expect(RECEIPT_RATE_MAX).toBeLessThan(60);
    expect(RECEIPT_RATE_WINDOW_MS).toBe(60_000);
  });
});

describe("createReceiptReporter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-11-12T09:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("report returns at once and the receipt goes out without waiting", async () => {
    const t = transport();
    const reporter = createReceiptReporter(t.deps);
    expect(reporter.report(receipt())).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent).toEqual([receipt()]);
    expect(reporter.pending()).toBe(0);
  });

  it("retries a network error with backoff, then drops it", async () => {
    const t = transport([new Error("offline"), new Error("offline"), new Error("offline")]);
    const reporter = createReceiptReporter(t.deps);
    reporter.report(receipt());
    await vi.advanceTimersByTimeAsync(0);
    expect(t.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RECEIPT_RETRY_DELAYS_MS[0] - 1);
    expect(t.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(RECEIPT_RETRY_DELAYS_MS[1]);
    expect(t.send).toHaveBeenCalledTimes(1 + RECEIPT_RETRY_DELAYS_MS.length);
    // Dropped: nothing left, and no further attempt however long we wait.
    expect(reporter.pending()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * RECEIPT_RATE_WINDOW_MS);
    expect(t.send).toHaveBeenCalledTimes(1 + RECEIPT_RETRY_DELAYS_MS.length);
  });

  it("retries a 5xx until it lands", async () => {
    const t = transport([503, 204]);
    const reporter = createReceiptReporter(t.deps);
    reporter.report(receipt());
    await vi.advanceTimersByTimeAsync(RECEIPT_RETRY_DELAYS_MS[0]);
    expect(t.send).toHaveBeenCalledTimes(2);
    expect(reporter.pending()).toBe(0);
  });

  it("never retries a 4xx", async () => {
    for (const status of [400, 401, 404]) {
      const t = transport([status]);
      const reporter = createReceiptReporter(t.deps);
      reporter.report(receipt());
      await vi.advanceTimersByTimeAsync(10 * RECEIPT_RATE_WINDOW_MS);
      expect(t.send).toHaveBeenCalledTimes(1);
      expect(reporter.pending()).toBe(0);
    }
  });

  it("a later receipt is not held up by one waiting to retry", async () => {
    const other = "1c2d3e4f-0000-4000-8000-000000000001";
    const t = transport([new Error("blip"), 204, 204]);
    const reporter = createReceiptReporter(t.deps);
    reporter.report(receipt());
    await vi.advanceTimersByTimeAsync(0);
    reporter.report(receipt(other, "clicked"));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent.map((r) => r.id)).toEqual([ID, other]);
    await vi.advanceTimersByTimeAsync(RECEIPT_RETRY_DELAYS_MS[0]);
    expect(t.sent.map((r) => r.id)).toEqual([ID, other, ID]);
  });

  it("paces a burst at RECEIPT_RATE_MAX per window", async () => {
    const t = transport();
    const reporter = createReceiptReporter(t.deps);
    const burst = RECEIPT_RATE_MAX + 5;
    for (let i = 0; i < burst; i++) {
      reporter.report(receipt(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`));
    }
    await vi.advanceTimersByTimeAsync(RECEIPT_RATE_WINDOW_MS - 1);
    expect(t.send).toHaveBeenCalledTimes(RECEIPT_RATE_MAX);
    expect(reporter.pending()).toBe(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.send).toHaveBeenCalledTimes(burst);
    expect(reporter.pending()).toBe(0);
  });

  it("a 429 drops that receipt and pauses the queue for a window", async () => {
    const other = "1c2d3e4f-0000-4000-8000-000000000002";
    const t = transport([429, 204]);
    const reporter = createReceiptReporter(t.deps);
    reporter.report(receipt());
    await vi.advanceTimersByTimeAsync(0);
    reporter.report(receipt(other));
    await vi.advanceTimersByTimeAsync(RECEIPT_RATE_WINDOW_MS - 1);
    expect(t.sent.map((r) => r.id)).toEqual([ID]);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.sent.map((r) => r.id)).toEqual([ID, other]);
  });

  it("drops past RECEIPT_QUEUE_MAX instead of growing without bound", async () => {
    const t = transport();
    // Hold the first send so everything after it queues.
    t.send.mockImplementationOnce(() => new Promise<number>(() => {}));
    const reporter = createReceiptReporter(t.deps);
    reporter.report(receipt());
    for (let i = 0; i < RECEIPT_QUEUE_MAX + 10; i++) reporter.report(receipt());
    expect(reporter.pending()).toBe(RECEIPT_QUEUE_MAX);
  });

  it("a send that never settles times out, is retried, and does not stall the queue", async () => {
    const other = "1c2d3e4f-0000-4000-8000-000000000003";
    const t = transport();
    t.send.mockImplementationOnce((r) => {
      t.sent.push(r);
      return new Promise<number>(() => {});
    });
    const reporter = createReceiptReporter(t.deps);
    reporter.report(receipt());
    reporter.report(receipt(other));
    await vi.advanceTimersByTimeAsync(RECEIPT_SEND_TIMEOUT_MS - 1);
    expect(t.sent.map((r) => r.id)).toEqual([ID]);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.sent.map((r) => r.id)).toEqual([ID, other]);
    await vi.advanceTimersByTimeAsync(RECEIPT_RETRY_DELAYS_MS[0]);
    expect(t.sent.map((r) => r.id)).toEqual([ID, other, ID]);
    expect(reporter.pending()).toBe(0);
  });

  it("never throws, even when the transport throws synchronously", async () => {
    const t = transport();
    t.send.mockImplementation(() => {
      throw new Error("boom");
    });
    const reporter = createReceiptReporter(t.deps);
    expect(() => reporter.report(receipt())).not.toThrow();
    await vi.advanceTimersByTimeAsync(10 * RECEIPT_RATE_WINDOW_MS);
    expect(t.send).toHaveBeenCalledTimes(1 + RECEIPT_RETRY_DELAYS_MS.length);
    expect(reporter.pending()).toBe(0);
  });
});

describe("installToastClickHandler — the click receipt hook", () => {
  it("exposes the hook the shell calls on a click, and removes only its own", () => {
    const report = vi.fn();
    const target: { __klornToastClicked?: (id: string) => void } = {};
    const uninstall = installToastClickHandler(target, report);
    target.__klornToastClicked?.(ID);
    expect(report).toHaveBeenCalledExactlyOnceWith("clicked", ID);
    uninstall();
    expect(target.__klornToastClicked).toBeUndefined();

    const first = installToastClickHandler(target, report);
    const second = installToastClickHandler(target, report);
    first();
    expect(target.__klornToastClicked).toBeDefined();
    second();
    expect(target.__klornToastClicked).toBeUndefined();
  });
});
