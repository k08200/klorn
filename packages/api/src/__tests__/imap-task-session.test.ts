/**
 * Step B3: the one-shot task layer under send, drafts and reply-header reads.
 *
 * Pinned here, apart from the provider-level tests in imap-send-actions.test.ts:
 * a failure is described by class, code, reply code and failing command only
 * (server text can quote a recipient address), tasks for one account run in
 * order even when one fails, a task never rejects, and a cooling account never
 * starts its task.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("imapflow", () => ({ ImapFlow: class {} }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");
const { resetImapSessionState, rejectLogin } = await import("../mail/providers/imap-session.js");
const { describeFailure, sanitizedError, runAccountTask } = await import(
  "../mail/providers/imap-task-session.js"
);

const provider = IMAP_PROVIDERS.NAVER;
const account = {
  userId: "u1",
  rowId: "row-1",
  email: "me@naver.com",
  host: "imap.naver.com:993",
  password: "pw",
  credentialKey: "row-1:cipher",
};
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  resetImapSessionState();
  vi.spyOn(console, "warn").mockImplementation(() => {});
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
    const gate: { open: () => void } = { open: () => {} };
    const first = runAccountTask(provider, account, async () => {
      order.push("first:start");
      await new Promise<void>((resolve) => {
        gate.open = resolve;
      });
      order.push("first:end");
      throw Object.assign(new Error("boom"), { code: "ETIMEDOUT" });
    });
    const second = runAccountTask(provider, account, async () => {
      order.push("second:start");
      return "second-result";
    });
    await flush();
    expect(order).toEqual(["first:start"]);
    gate.open();
    expect(await first).toEqual({ error: "Could not reach Naver. Try again shortly." });
    expect(await second).toBe("second-result");
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("never rejects: a throwing task becomes { error }", async () => {
    const result = await runAccountTask(provider, account, async () => {
      throw new Error("anything");
    });
    expect(result).toEqual({ error: "Could not reach Naver. Try again shortly." });
  });

  it("does not start a task for an account whose login was rejected", async () => {
    rejectLogin(provider, account);
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
    const gate: { open: () => void } = { open: () => {} };
    const slow = runAccountTask(
      provider,
      account,
      () =>
        new Promise<string>((resolve) => {
          gate.open = () => resolve("slow");
        }),
    );
    const other = { ...account, rowId: "row-2", credentialKey: "row-2:cipher" };
    expect(await runAccountTask(provider, other, async () => "fast")).toBe("fast");
    gate.open();
    expect(await slow).toBe("slow");
  });
});
