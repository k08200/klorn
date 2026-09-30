/**
 * The 60 s deadline can fire while the orphaned send has not even started talking
 * to the server: here, while nodemailer is still being imported. When the import
 * finally resolves, the orphan must do NOTHING: it closes the session it opened,
 * sends no message (the caller was already told delivery is unconfirmed, and a
 * late send would make that a lie), logs into IMAP for no Sent copy.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { arm, h, lastSmtpSocket, resetHarness, settle } from "./helpers/imap-send-harness.js";

const g = vi.hoisted(() => {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open: () => open() };
});

vi.mock("nodemailer", async () => {
  const { h } = await import("./helpers/imap-send-harness.js");
  await g.promise;
  return { createTransport: (...args: unknown[]) => h.createTransport(...args) };
});
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

const { imapSendActions, SENT_COPY_DEADLINE_MS } = await import("../mail/providers/imap-send.js");
const { resetImapSessionState, TASK_TOTAL_TIMEOUT_MS } = await import(
  "../mail/providers/imap-session.js"
);

const naver = imapSendActions("NAVER");

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

describe("a deadline that fires before the send has started", () => {
  it("leaves the orphan inert: session closed, nothing sent, no IMAP login", async () => {
    const result = naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    await settle();
    expect(h.createTransport).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TASK_TOTAL_TIMEOUT_MS);
    expect(await result).toEqual({
      error:
        "Naver did not confirm delivery. The message may or may not have been sent; check your Sent folder before trying again.",
    });

    g.open();
    await vi.advanceTimersByTimeAsync(SENT_COPY_DEADLINE_MS);
    await settle();

    // the orphan did open a session when the import came back, and closed it without using it
    expect(h.createTransport).toHaveBeenCalledTimes(1);
    expect(lastSmtpSocket().destroyed).toBe(true);
    expect(h.sendMail).not.toHaveBeenCalled();
    expect(h.imapCtorOpts).toHaveLength(0);
    expect(h.append).not.toHaveBeenCalled();
  });
});
