/**
 * Step B3: every IMAP session ends, and every mailbox lock is released, on every
 * path, for the three provider actions that open one (the Sent copy after a send,
 * drafts, reply headers). A leaked session holds one of the few global slots and
 * a login on a rate-limited provider; a leaked lock blocks the next command on
 * the connection.
 *
 * Session end means LOGOUT then a hard close, in that order, after the lock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  arm,
  draftInput,
  h,
  NAVER_MSG,
  resetHarness,
  settle,
} from "./helpers/imap-send-harness.js";

vi.mock("imapflow", async () => ({
  ImapFlow: (await import("./helpers/imap-send-harness.js")).FakeImapFlow,
}));
vi.mock("nodemailer", async () => {
  const { h } = await import("./helpers/imap-send-harness.js");
  h.nodemailerLoads += 1;
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

const { imapSendActions } = await import("../mail/providers/imap-send.js");
const { resetImapSessionState } = await import("../mail/providers/imap-session.js");

const naver = imapSendActions("NAVER");
const ROW = { linkedInboxAccountId: "row-1" };

/** Calls of interest across the fakes, in the order they happened. */
let calls: string[] = [];
function record() {
  calls = [];
  h.getMailboxLock.mockImplementation(async (path: string) => {
    calls.push(`lock:${path}`);
    return { release: () => calls.push(`release:${path}`) };
  });
  h.logout.mockImplementation(async () => {
    calls.push("logout");
  });
  h.close.mockImplementation(() => {
    calls.push("close");
  });
}

beforeEach(() => {
  resetHarness();
  resetImapSessionState();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  arm();
  record();
});
afterEach(() => vi.restoreAllMocks());

const endsSession = () => {
  expect(calls).toContain("logout");
  expect(calls[calls.length - 1]).toBe("close");
  expect(calls.indexOf("logout")).toBeLessThan(calls.indexOf("close"));
};
const everyLockReleased = () => {
  const locks = calls.filter((c) => c.startsWith("lock:")).map((c) => c.slice(5));
  const releases = calls.filter((c) => c.startsWith("release:")).map((c) => c.slice(8));
  expect(releases.sort()).toEqual(locks.sort());
};
const sendAndSettle = async () => {
  const result = await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], ROW);
  await settle();
  return result;
};

describe("the Sent copy after a send", () => {
  it("ends the session when connect() throws, and the send still succeeds", async () => {
    h.connect.mockRejectedValue(new Error("ECONNRESET"));
    expect(await sendAndSettle()).toHaveProperty("success", true);
    endsSession();
  });

  it("ends the session when the work throws (list fails)", async () => {
    h.list.mockRejectedValue(new Error("NO [SERVERBUG]"));
    expect(await sendAndSettle()).toHaveProperty("success", true);
    endsSession();
  });

  it("releases the Sent lock when the search throws, then ends the session", async () => {
    h.search.mockRejectedValue(new Error("NO search failed"));
    expect(await sendAndSettle()).toHaveProperty("success", true);
    expect(calls).toContain("lock:Sent Messages");
    everyLockReleased();
    expect(calls.indexOf("release:Sent Messages")).toBeLessThan(calls.indexOf("logout"));
    endsSession();
    expect(h.append).not.toHaveBeenCalled();
  });

  it("releases the Sent lock when the message is already stored", async () => {
    h.search.mockResolvedValue([42]);
    await sendAndSettle();
    everyLockReleased();
    endsSession();
  });

  it("releases the Sent lock and ends the session on the normal path", async () => {
    await sendAndSettle();
    expect(calls).toEqual(["lock:Sent Messages", "release:Sent Messages", "logout", "close"]);
  });

  it("still closes when logout itself fails", async () => {
    h.logout.mockRejectedValue(new Error("already closed"));
    await sendAndSettle();
    expect(calls).toContain("close");
  });
});

describe("drafts", () => {
  const draft = () => naver.createDraft("u1", { ...draftInput, ...ROW });

  it("ends the session when connect() throws", async () => {
    h.connect.mockRejectedValue(new Error("ECONNRESET"));
    expect(await draft()).toHaveProperty("error");
    endsSession();
  });

  it("ends the session when list() throws", async () => {
    h.list.mockRejectedValue(new Error("NO"));
    expect(await draft()).toHaveProperty("error");
    endsSession();
  });

  it("ends the session when the APPEND throws", async () => {
    h.append.mockRejectedValue(new Error("NO [OVERQUOTA]"));
    expect(await draft()).toHaveProperty("error");
    endsSession();
  });

  it("ends the session after a successful draft, taking no mailbox lock at all", async () => {
    expect(await draft()).toHaveProperty("success", true);
    expect(calls).toEqual(["logout", "close"]);
  });
});

describe("reply headers", () => {
  const read = () => naver.getReplyHeaders("u1", NAVER_MSG, "row-1");

  it("ends the session when connect() throws", async () => {
    h.connect.mockRejectedValue(new Error("ECONNRESET"));
    expect(await read()).toEqual({});
    endsSession();
  });

  it("releases the INBOX lock and ends the session when the fetch throws", async () => {
    h.fetchOne.mockRejectedValue(new Error("NO fetch failed"));
    expect(await read()).toEqual({});
    expect(calls).toContain("lock:INBOX");
    everyLockReleased();
    endsSession();
  });

  it("releases the INBOX lock when the message is gone", async () => {
    h.fetchOne.mockResolvedValue(false);
    expect(await read()).toEqual({});
    everyLockReleased();
    endsSession();
  });

  it("releases the INBOX lock and ends the session on the normal path", async () => {
    await read();
    expect(calls).toEqual(["lock:INBOX", "release:INBOX", "logout", "close"]);
  });

  it("does not leak a global session slot: a burst of failures never starves the next action", async () => {
    h.connect.mockRejectedValue(new Error("ECONNRESET"));
    for (let i = 0; i < 6; i++) await read();
    h.connect.mockResolvedValue(undefined);
    expect(await read()).toMatchObject({ messageId: expect.any(String) });
  });
});
