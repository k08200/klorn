/**
 * Step B3: bounded time, and no double send.
 *
 * Every wait in a send has a deadline, and the order matters:
 *   1. waiting for the account's turn (and a global session slot) is bounded by
 *      TASK_QUEUE_WAIT_MS. Past it the caller gets `{ error }` saying the mailbox
 *      was busy and NOTHING was sent or saved, and the task never runs afterwards;
 *   2. how many tasks one user may have outstanding is capped, so a burst cannot
 *      queue unbounded work behind a slow mailbox;
 *   3. once a task runs, the whole of it is bounded by TASK_TOTAL_TIMEOUT_MS;
 *      past it the connection is closed and the caller is told the outcome is
 *      unconfirmed (the message may have gone out);
 *   4. the Sent copy, which happens after the message is gone, gets a hard
 *      SENT_COPY_DEADLINE_MS: the send's result never waits for it beyond that.
 * All of it under fake timers; no timer is left behind afterwards.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  arm,
  h,
  header,
  loggedText,
  NAVER_ROW,
  resetHarness,
  sentMime,
  settle,
} from "./helpers/imap-send-harness.js";

vi.mock("imapflow", async () => ({
  ImapFlow: (await import("./helpers/imap-send-harness.js")).FakeImapFlow,
}));
vi.mock("nodemailer", async () => {
  const { h } = await import("./helpers/imap-send-harness.js");
  return { createTransport: (...args: unknown[]) => h.createTransport(...args) };
});
vi.mock("../db.js", async () => {
  const { h } = await import("./helpers/imap-send-harness.js");
  const prisma = {
    linkedInboxAccount: { findFirst: (...args: unknown[]) => h.findFirst(...args) },
    emailMessage: { updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  return { prisma, db: prisma };
});
vi.mock("../crypto-tokens.js", async () => {
  const { h } = await import("./helpers/imap-send-harness.js");
  return { decryptToken: (...args: unknown[]) => h.decryptToken(...args) };
});
vi.mock("../sentry.js", async () => {
  const { h } = await import("./helpers/imap-send-harness.js");
  return { captureError: (...args: unknown[]) => h.captureError(...args) };
});

const { imapSendActions, SENT_COPY_DEADLINE_MS } = await import("../mail/providers/imap-send.js");
const {
  MAX_OUTSTANDING_TASKS_PER_USER,
  resetImapSessionState,
  TASK_QUEUE_WAIT_MS,
  TASK_TOTAL_TIMEOUT_MS,
} = await import("../mail/providers/imap-session.js");

const naver = imapSendActions("NAVER");
const send = (userId = "u1", rowId = "row-1", subject = "Hi") =>
  naver.sendEmail(userId, "bob@example.com", subject, "b", [], { linkedInboxAccountId: rowId });

/** A promise the test settles by hand. */
function gate<T = void>() {
  let open: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetHarness();
  resetImapSessionState();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  arm();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the queue-wait deadline: busy, and nothing sent", () => {
  it("answers busy after TASK_QUEUE_WAIT_MS and never runs the task later", async () => {
    const firstSend = gate();
    h.sendMail.mockImplementationOnce(() => firstSend.promise);
    const first = send("u1", "row-1", "first");
    await settle();
    expect(h.sendMail).toHaveBeenCalledTimes(1);

    const second = send("u1", "row-1", "second");
    let answered = false;
    void second.then(() => {
      answered = true;
    });
    await vi.advanceTimersByTimeAsync(TASK_QUEUE_WAIT_MS - 1);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const busy = await second;
    expect(busy).toEqual({
      error:
        "Naver is busy with your other requests. Nothing was sent or saved; try again shortly.",
    });

    // The first send finishes; the expired second one must not start now.
    firstSend.open({ accepted: ["bob@example.com"], rejected: [] });
    expect(await first).toHaveProperty("success", true);
    await settle();
    expect(h.createTransport).toHaveBeenCalledTimes(1);
    expect(h.sendMail).toHaveBeenCalledTimes(1);
    expect(header(sentMime(), "Subject")).toContain(Buffer.from("first").toString("base64"));
  });

  it("does not count time spent running against the wait: a task that starts in time is never 'busy'", async () => {
    const slow = gate();
    h.sendMail.mockImplementationOnce(() => slow.promise);
    const result = send();
    await vi.advanceTimersByTimeAsync(TASK_QUEUE_WAIT_MS + 1_000);
    slow.open({ accepted: ["x"], rejected: [] });
    expect(await result).toHaveProperty("success", true);
  });

  it("leaves no timer behind after a normal send", async () => {
    const result = await send();
    expect(result).toHaveProperty("success", true);
    await settle();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reply-header reads answer {} instead of waiting past the deadline", async () => {
    const firstSend = gate();
    h.sendMail.mockImplementationOnce(() => firstSend.promise);
    const first = send();
    await settle();
    const headers = naver.getReplyHeaders("u1", "naver-imap:me@naver.com:101", "row-1");
    await vi.advanceTimersByTimeAsync(TASK_QUEUE_WAIT_MS);
    expect(await headers).toEqual({});
    firstSend.open({ accepted: ["x"], rejected: [] });
    await first;
  });
});

describe("the per-user cap", () => {
  it("refuses a task beyond MAX_OUTSTANDING_TASKS_PER_USER at once, unsent, for that user only", async () => {
    const hold = gate();
    h.sendMail.mockImplementation(() => hold.promise);
    const outstanding = Array.from({ length: MAX_OUTSTANDING_TASKS_PER_USER }, (_, i) =>
      send("u1", "row-1", `s${i}`),
    );
    await settle();

    const over = await send("u1", "row-1", "one too many");
    expect(over).toEqual({
      error:
        "Naver is busy with your other requests. Nothing was sent or saved; try again shortly.",
    });

    // Another user, with their own account row, is unaffected.
    arm({ ...NAVER_ROW, id: "row-9", email: "other@naver.com" });
    const other = send("u2", "row-9");
    await settle();
    expect(h.createTransport.mock.calls.length).toBeGreaterThanOrEqual(2);

    hold.open({ accepted: ["x"], rejected: [] });
    await Promise.all([...outstanding, other]);
  });

  it("frees the slot as tasks finish", async () => {
    for (let i = 0; i < MAX_OUTSTANDING_TASKS_PER_USER + 3; i++) {
      expect(await send("u1", "row-1", `s${i}`)).toHaveProperty("success", true);
    }
  });
});

describe("the total task timeout", () => {
  it("closes the connection and reports an unconfirmed send after TASK_TOTAL_TIMEOUT_MS", async () => {
    h.sendMail.mockImplementationOnce(() => new Promise(() => {}));
    const result = send();
    await vi.advanceTimersByTimeAsync(TASK_TOTAL_TIMEOUT_MS - 1);
    expect(h.transportClose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({
      error:
        "Naver did not answer in time. The action may or may not have completed; check your mailbox before trying again.",
    });
    expect(h.transportClose).toHaveBeenCalled();
  });

  it("frees the account afterwards: the next send runs", async () => {
    h.sendMail.mockImplementationOnce(() => new Promise(() => {}));
    const stuck = send("u1", "row-1", "stuck");
    await vi.advanceTimersByTimeAsync(TASK_TOTAL_TIMEOUT_MS);
    await stuck;
    const next = await send("u1", "row-1", "next");
    expect(next).toHaveProperty("success", true);
  });

  it("does not report a timed-out send to Sentry as a transport failure", async () => {
    h.sendMail.mockImplementationOnce(() => new Promise(() => {}));
    const stuck = send();
    await vi.advanceTimersByTimeAsync(TASK_TOTAL_TIMEOUT_MS);
    await stuck;
    expect(h.captureError).not.toHaveBeenCalled();
  });
});

describe("the Sent copy deadline", () => {
  it("does not make the send's result wait: it arrives at SENT_COPY_DEADLINE_MS, with the IMAP client closed", async () => {
    h.connect.mockImplementation(() => new Promise(() => {}));
    const result = send();
    let answered = false;
    void result.then(() => {
      answered = true;
    });
    await vi.advanceTimersByTimeAsync(SENT_COPY_DEADLINE_MS - 1);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const sent = await result;
    expect(sent).toMatchObject({ success: true });
    expect(SENT_COPY_DEADLINE_MS).toBeLessThanOrEqual(10_000);
    expect(h.close).toHaveBeenCalled();
    expect(loggedText()).toContain("sent copy skipped");
    expect(loggedText()).toContain("deadline");
  });

  it("also bounds a server that connects but never answers a command", async () => {
    h.list.mockImplementation(() => new Promise(() => {}));
    const result = send();
    await vi.advanceTimersByTimeAsync(SENT_COPY_DEADLINE_MS);
    expect(await result).toMatchObject({ success: true });
    expect(h.close).toHaveBeenCalled();
  });

  it("leaves no timer behind when the copy finishes in time", async () => {
    const result = await send();
    expect(result).toHaveProperty("success", true);
    await settle();
    expect(vi.getTimerCount()).toBe(0);
  });
});
