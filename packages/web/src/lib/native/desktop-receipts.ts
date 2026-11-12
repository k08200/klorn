// Notification receipts from the Windows desktop shell (apps/desktop-win):
// what became of an OS banner it posted, reported to
// POST /api/notifications/desktop/receipts (packages/api routes/desktop-receipts.ts).
//
//   shown   — `show_banner` posted the toast (./tauri-notify.ts)
//   clicked — the user clicked the toast while it was on screen (banner.rs
//             on_action → window.__klornToastClicked, desktop-toast-router.tsx)
//
// The shell toasts bell rows, so every receipt is `kind: "notification"` keyed
// on the bell row id. The catch-up summary (`missed:<id>`, decision N6) stands
// for several rows and has no single id: it reports nothing.
//
// Fire-and-forget: `report` returns at once, never throws, and never delays a
// banner. A network error or a 5xx is retried with backoff and then dropped;
// a 4xx is never retried (the endpoint's contract). Requests go one at a time,
// paced under the server's per-user limit (60 / minute, shared by the user's
// other devices), and a 429 pauses the queue for a window.

import { API_BASE, authHeaders } from "../api";

export const RECEIPTS_PATH = "/api/notifications/desktop/receipts";
/** Requests per window this app sends at most: half the server's 60 / minute
 *  per user, which the user's Mac and other PCs share. */
export const RECEIPT_RATE_MAX = 30;
export const RECEIPT_RATE_WINDOW_MS = 60_000;
/** Wait before each retry; one attempt more than there are delays, then drop. */
export const RECEIPT_RETRY_DELAYS_MS = [2_000, 10_000] as const;
/** Receipts waiting at most; more are dropped (a burst far past the pacing). */
export const RECEIPT_QUEUE_MAX = 100;
/** A request with no answer by then counts as a network error, so one hung
 *  request cannot hold the queue. */
export const RECEIPT_SEND_TIMEOUT_MS = 15_000;

export type DesktopReceiptEvent = "shown" | "clicked";

export interface DesktopReceipt {
  app: "windows";
  event: DesktopReceiptEvent;
  kind: "notification";
  id: string;
}

/** The server's own id pattern (routes/desktop-receipts.ts bodySchema). */
const RECEIPT_ID_PATTERN = /^[0-9a-fA-F-]{36}$/;

export function isReceiptId(value: unknown): value is string {
  return typeof value === "string" && RECEIPT_ID_PATTERN.test(value);
}

/** The receipt for a banner keyed on `id`, or null when it has none (the
 *  catch-up summary, or anything that is not a bell row id). Pure. */
export function receiptFor(event: DesktopReceiptEvent, id: unknown): DesktopReceipt | null {
  return isReceiptId(id) ? { app: "windows", event, kind: "notification", id } : null;
}

export type SendVerdict = "done" | "retry" | "drop";

/** What to do after the server answered `status`. Pure. */
export function verdictForStatus(status: number): SendVerdict {
  if (status >= 200 && status < 300) return "done";
  return status >= 500 ? "retry" : "drop";
}

/** The sends that count against the window at `nowMs`. One "in the future"
 *  (the clock was moved back) does not count, so it cannot stall the queue. */
function inWindow(sentAtMs: readonly number[], nowMs: number, windowMs: number): number[] {
  return sentAtMs.filter((at) => at > nowMs - windowMs && at <= nowMs);
}

/** When the next request may go, given when the recent ones went. Pure. */
export function nextSendAtMs(
  sentAtMs: readonly number[],
  nowMs: number,
  max: number = RECEIPT_RATE_MAX,
  windowMs: number = RECEIPT_RATE_WINDOW_MS,
): number {
  const recent = inWindow(sentAtMs, nowMs, windowMs);
  if (recent.length < max) return nowMs;
  return recent[recent.length - max] + windowMs;
}

export interface ReceiptTransport {
  /** POST one receipt; resolves to the HTTP status, rejects on a network error. */
  send(receipt: DesktopReceipt): Promise<number>;
  now(): number;
  /** Run `run` after `delayMs`; returns a function that cancels it. */
  schedule(run: () => void, delayMs: number): () => void;
}

export interface ReceiptReporter {
  /** Queue a receipt. Returns at once; never throws. */
  report(receipt: DesktopReceipt): void;
  /** Receipts waiting (not counting one in flight). */
  pending(): number;
}

interface Pending {
  receipt: DesktopReceipt;
  attempts: number;
  notBeforeMs: number;
}

const noop = () => {};

export function createReceiptReporter(t: ReceiptTransport): ReceiptReporter {
  let queue: readonly Pending[] = [];
  let sentAt: readonly number[] = [];
  let pausedUntilMs = 0;
  let inFlight = false;
  let cancelWake: () => void = noop;

  function wakeIn(delayMs: number): void {
    cancelWake = t.schedule(() => {
      cancelWake = noop;
      pump();
    }, delayMs);
  }

  function pump(): void {
    if (inFlight) return;
    cancelWake();
    cancelWake = noop;
    if (queue.length === 0) return;
    const now = t.now();
    sentAt = inWindow(sentAt, now, RECEIPT_RATE_WINDOW_MS);
    const gate = Math.max(nextSendAtMs(sentAt, now), pausedUntilMs);
    const ready = queue.find((p) => p.notBeforeMs <= now);
    const earliest = Math.min(...queue.map((p) => p.notBeforeMs));
    const sendAt = ready ? gate : Math.max(gate, earliest);
    if (!ready || sendAt > now) {
      wakeIn(sendAt - now);
      return;
    }
    queue = queue.filter((p) => p !== ready);
    sentAt = [...sentAt, now];
    inFlight = true;
    void attempt(ready);
  }

  /** The send's status, or a rejection after RECEIPT_SEND_TIMEOUT_MS. */
  function sendWithin(receipt: DesktopReceipt): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const cancel = t.schedule(
        () => reject(new Error("receipt request timed out")),
        RECEIPT_SEND_TIMEOUT_MS,
      );
      const settle =
        <T>(fn: (value: T) => void) =>
        (value: T) => {
          cancel();
          fn(value);
        };
      // Called now, not on a later tick: a click's request must leave before
      // the page can navigate away.
      let sent: Promise<number>;
      try {
        sent = t.send(receipt);
      } catch (err) {
        sent = Promise.reject(err);
      }
      sent.then(settle(resolve), settle(reject));
    });
  }

  async function attempt(p: Pending): Promise<void> {
    let verdict: SendVerdict = "retry";
    try {
      const status = await sendWithin(p.receipt);
      verdict = verdictForStatus(status);
      if (status === 429) pausedUntilMs = t.now() + RECEIPT_RATE_WINDOW_MS;
    } catch {
      // A network error or a timeout: retried below.
    }
    const attempts = p.attempts + 1;
    const delay = RECEIPT_RETRY_DELAYS_MS[attempts - 1];
    if (verdict === "retry" && delay !== undefined) {
      queue = [...queue, { ...p, attempts, notBeforeMs: t.now() + delay }];
    } else if (verdict !== "done") {
      console.warn(`[DESKTOP-RECEIPT] dropped a ${p.receipt.event} receipt (${verdict})`);
    }
    inFlight = false;
    pump();
  }

  return {
    report(receipt) {
      try {
        if (queue.length >= RECEIPT_QUEUE_MAX) {
          console.warn("[DESKTOP-RECEIPT] queue full, dropped a receipt");
          return;
        }
        queue = [...queue, { receipt, attempts: 0, notBeforeMs: 0 }];
        pump();
      } catch (err) {
        console.warn("[DESKTOP-RECEIPT] could not queue a receipt:", err);
      }
    },
    pending: () => queue.length,
  };
}

/** The shipped transport: fetch with the session's Bearer token. A raw fetch,
 *  not apiFetch: a 401 here must not start the sign-out redirect, and the
 *  status decides retry or drop. `keepalive` lets a click's receipt finish
 *  when the click navigates the page; the signal ends a request the reporter
 *  has already given up on. */
const fetchTransport: ReceiptTransport = {
  async send(receipt) {
    const res = await fetch(`${API_BASE}${RECEIPTS_PATH}`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(receipt),
      keepalive: true,
      signal: AbortSignal.timeout(RECEIPT_SEND_TIMEOUT_MS),
    });
    return res.status;
  },
  now: () => Date.now(),
  schedule(run, delayMs) {
    const timer = setTimeout(run, delayMs);
    return () => clearTimeout(timer);
  },
};

let shared: ReceiptReporter | null = null;

/** Report what became of the banner keyed on `id`. A no-op for a banner
 *  without a receipt (receiptFor). Never throws. */
export function reportDesktopReceipt(event: DesktopReceiptEvent, id: unknown): void {
  const receipt = receiptFor(event, id);
  if (!receipt) return;
  shared ??= createReceiptReporter(fetchTransport);
  shared.report(receipt);
}

export interface ToastClickTarget {
  /** Called by the shell when the user clicks a toast, with the id the toast
   *  was posted with (apps/desktop-win banner.rs click_script). */
  __klornToastClicked?: (id: string) => void;
}

/** Expose the click hook on `target` (the window); returns a function that
 *  removes it again unless another install replaced it. */
export function installToastClickHandler(
  target: ToastClickTarget,
  report: typeof reportDesktopReceipt = reportDesktopReceipt,
): () => void {
  const clicked = (id: string) => report("clicked", id);
  target.__klornToastClicked = clicked;
  return () => {
    if (target.__klornToastClicked === clicked) delete target.__klornToastClicked;
  };
}
