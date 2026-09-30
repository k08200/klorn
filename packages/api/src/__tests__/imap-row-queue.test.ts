/**
 * Step B3: ONE per-account queue under every IMAP action, plus the one-shot task
 * runner (`runAccountTask`) that send, drafts and reply-header reads use.
 *
 * Pinned here, apart from the provider-level tests in imap-send-*.test.ts:
 *   - B1 flag work and B3 tasks for the same linked account run through the same
 *     queue, one at a time, in either order; other accounts are not held;
 *   - a failure is described by class, code, reply code and failing command only
 *     (server text can quote a recipient address);
 *   - tasks run in order even when one fails, a task never rejects, a cooling
 *     account never starts its task;
 *   - the reset hook forgets the queue.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  arm,
  CIPHER,
  h,
  NAVER_MSG,
  NAVER_ROW,
  resetHarness,
  settle,
} from "./helpers/imap-send-harness.js";

vi.mock("imapflow", async () => ({
  ImapFlow: (await import("./helpers/imap-send-harness.js")).FakeImapFlow,
}));
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

const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");
const { resetImapSessionState, runAccountTask } = await import("../mail/providers/imap-session.js");
const { describeFailure, sanitizedError } = await import("../mail/providers/action-failure.js");
const { imapMailActions } = await import("../mail/providers/imap.js");

const provider = IMAP_PROVIDERS.NAVER;
const account = {
  userId: "u1",
  rowId: "row-1",
  email: "me@naver.com",
  host: "imap.naver.com:993",
  password: "pw",
  credentialKey: `row-1:${CIPHER}`,
};
const otherAccount = { ...account, rowId: "row-2", credentialKey: `row-2:${CIPHER}` };

/** A promise the test settles by hand. */
function gate<T = void>() {
  let open: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Script the fakes so a B1 flag action on INBOX UID 101 succeeds. */
function armFlagServer() {
  h.messageFlagsAdd.mockResolvedValue(true);
  h.fetch.mockImplementation(() =>
    (async function* () {
      yield { uid: 101, flags: new Set(["\\Seen"]) };
    })(),
  );
}

beforeEach(() => {
  resetHarness();
  resetImapSessionState();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  arm();
  armFlagServer();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("describeFailure", () => {
  it("keeps the class, code, reply code and failing command", () => {
    const err = Object.assign(new Error("550 5.1.1 <bob@example.com> user unknown"), {
      code: "EENVELOPE",
      responseCode: 550,
      command: "RCPT TO",
      response: "550 5.1.1 <bob@example.com> user unknown",
    });
    expect(describeFailure(err)).toBe("Error code=EENVELOPE reply=550 command=RCPT TO");
    expect(describeFailure(err)).not.toContain("bob@example.com");
  });

  it("keeps the IMAP response code of imapflow errors", () => {
    const err = Object.assign(new Error("Command failed: me@naver.com"), {
      serverResponseCode: "AUTHENTICATIONFAILED",
    });
    expect(describeFailure(err)).toBe("Error imap=AUTHENTICATIONFAILED");
  });

  it("copes with values that are not errors", () => {
    expect(describeFailure(null)).toBe("NonError");
    expect(describeFailure("me@naver.com failed")).toBe("NonError");
    expect(describeFailure(undefined)).toBe("NonError");
    expect(describeFailure({})).toBe("Error");
  });

  it("bounds what a hostile code or command can put in a log line", () => {
    const text = describeFailure({
      code: "x".repeat(500),
      command: "y".repeat(500),
      name: "z".repeat(500),
    });
    expect(text.length).toBeLessThan(200);
  });

  it("sanitizedError carries only that description", () => {
    const safe = sanitizedError(Object.assign(new Error("secret text"), { code: "ETIMEDOUT" }));
    expect(safe.message).toBe("Error code=ETIMEDOUT");
  });
});

describe("runAccountTask", () => {
  it("runs tasks for one account strictly in order, even when an earlier one fails", async () => {
    const order: string[] = [];
    const first = gate();
    const firstResult = runAccountTask(provider, account, async () => {
      order.push("first:start");
      await first.promise;
      order.push("first:end");
      throw Object.assign(new Error("boom"), { code: "ETIMEDOUT" });
    });
    const secondResult = runAccountTask(provider, account, async () => {
      order.push("second:start");
      return "second-result";
    });
    await settle();
    expect(order).toEqual(["first:start"]);
    first.open();
    expect(await firstResult).toEqual({ error: "Could not reach Naver. Try again shortly." });
    expect(await secondResult).toBe("second-result");
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("never rejects: a throwing task becomes { error }", async () => {
    const result = await runAccountTask(provider, account, async () => {
      throw new Error("anything");
    });
    expect(result).toEqual({ error: "Could not reach Naver. Try again shortly." });
  });

  it("never rejects when the task throws synchronously", async () => {
    const result = await runAccountTask(provider, account, () => {
      throw new Error("sync");
    });
    expect(result).toEqual({ error: "Could not reach Naver. Try again shortly." });
  });

  it("does not start a task for an account whose login was rejected (shared cooldown)", async () => {
    await runAccountTask(provider, account, async () => {
      throw Object.assign(new Error("535"), { code: "EAUTH", responseCode: 535 });
    });
    const task = vi.fn(async () => "ran");
    const result = await runAccountTask(provider, account, task);
    expect(task).not.toHaveBeenCalled();
    expect(result).toEqual({
      error: "Naver rejected the saved app password. Reconnect your Naver mailbox in Settings.",
    });
  });

  it("re-checks the cooldown on its turn: a rejection seen by the task ahead stops the next", async () => {
    const second = vi.fn(async () => "ran");
    const first = runAccountTask(provider, account, async () => {
      throw Object.assign(new Error("535"), { code: "EAUTH", responseCode: 535 });
    });
    const next = runAccountTask(provider, account, second);
    expect(await first).toHaveProperty("error");
    expect(await next).toHaveProperty("error");
    expect(second).not.toHaveBeenCalled();
  });

  it("does not serialize different accounts against each other", async () => {
    const slowGate = gate<string>();
    const slow = runAccountTask(provider, account, () => slowGate.promise);
    expect(await runAccountTask(provider, otherAccount, async () => "fast")).toBe("fast");
    slowGate.open("slow");
    expect(await slow).toBe("slow");
  });
});

describe("one queue for B1 flag work and B3 tasks", () => {
  const flags = imapMailActions("NAVER");

  it("a B1 flag action waits for a running task on the same account", async () => {
    const hold = gate();
    const task = runAccountTask(provider, account, () => hold.promise);
    const flag = flags.toggleRead("u1", NAVER_MSG, true, "row-1");
    await settle();
    expect(h.connect).not.toHaveBeenCalled();

    hold.open();
    await task;
    expect(await flag).toEqual({ success: true });
    expect(h.connect).toHaveBeenCalledTimes(1);
  });

  it("a task waits for a B1 session that is running on the same account", async () => {
    const connecting = gate();
    h.connect.mockImplementation(() => connecting.promise);
    const flag = flags.toggleRead("u1", NAVER_MSG, true, "row-1");
    await settle();
    expect(h.connect).toHaveBeenCalledTimes(1);

    const started = vi.fn(async () => "ran");
    const task = runAccountTask(provider, account, started);
    await settle();
    expect(started).not.toHaveBeenCalled();

    connecting.open();
    expect(await flag).toEqual({ success: true });
    expect(await task).toBe("ran");
  });

  it("flag actions queued behind a task still coalesce into one session", async () => {
    const hold = gate();
    const task = runAccountTask(provider, account, () => hold.promise);
    const results = [
      flags.toggleRead("u1", NAVER_MSG, true, "row-1"),
      flags.toggleRead("u1", NAVER_MSG, true, "row-1"),
      flags.toggleRead("u1", NAVER_MSG, true, "row-1"),
    ];
    await settle();
    hold.open();
    await task;
    expect(await Promise.all(results)).toEqual([
      { success: true },
      { success: true },
      { success: true },
    ]);
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.messageFlagsAdd).toHaveBeenCalledTimes(1);
  });

  it("does not hold another account", async () => {
    arm(NAVER_ROW);
    const hold = gate();
    const task = runAccountTask(provider, otherAccount, () => hold.promise);
    const flag = flags.toggleRead("u1", NAVER_MSG, true, "row-1");
    expect(await flag).toEqual({ success: true });
    hold.open();
    await task;
  });

  it("the reset hook forgets the queue: a new task no longer waits for a stuck one", async () => {
    const stuck = gate();
    void runAccountTask(provider, account, () => stuck.promise);
    await settle();
    resetImapSessionState();
    expect(await runAccountTask(provider, account, async () => "fresh")).toBe("fresh");
    stuck.open();
  });
});
