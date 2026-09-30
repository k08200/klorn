/**
 * IMAP flag actions must not turn one burst of callers into a burst of LOGINs.
 * Naver and iCloud rate-limit parallel logins from one IP (see
 * imap-scheduler.ts), and a ban on our egress IP would stop polling for every
 * user of that provider. The callers that burst:
 *   - bulk read/unread (routes/email-bulk.ts: Promise.all over up to 100 ids),
 *   - promo auto-read (one call per new SILENT marketing mail),
 *   - MCP batches (the SDK dispatches a JSON-RPC batch concurrently),
 *   - plain PATCH read/star.
 *
 * These pin the session layer in providers/imap-session.ts: per-account
 * coalescing (one login drains every queued operation for that account), a
 * global cap on concurrent action sessions, per-caller results (including a
 * mixed success/failure drain), a per-account auth-failure cooldown, and
 * throttled error reporting. imapflow is a stateful fake.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  connect: vi.fn(),
  getMailboxLock: vi.fn(),
  messageFlagsAdd: vi.fn(),
  messageFlagsRemove: vi.fn(),
  fetch: vi.fn(),
  logout: vi.fn(),
  close: vi.fn(),
  on: vi.fn(),
  release: vi.fn(),
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  decryptToken: vi.fn(),
  captureError: vi.fn(),
  server: new Map<number, Set<string>>(),
  ignoreStore: false,
  active: 0,
  maxActive: 0,
}));

class FakeImapFlow {
  mailbox = { path: "INBOX", uidValidity: 7n };
  connect = h.connect;
  getMailboxLock = h.getMailboxLock;
  messageFlagsAdd = h.messageFlagsAdd;
  messageFlagsRemove = h.messageFlagsRemove;
  fetch = h.fetch;
  logout = h.logout;
  close = h.close;
  on = h.on;
}

vi.mock("imapflow", () => ({ ImapFlow: FakeImapFlow }));
vi.mock("../db.js", () => {
  const prisma = {
    linkedInboxAccount: { findFirst: h.findFirst },
    emailMessage: { updateMany: h.updateMany },
  };
  return { prisma, db: prisma };
});
vi.mock("../crypto-tokens.js", () => ({ decryptToken: h.decryptToken }));
vi.mock("../sentry.js", () => ({ captureError: h.captureError }));

const { imapMailActions } = await import("../mail/providers/imap.js");
const {
  IMAP_AUTH_COOLDOWN_MS,
  IMAP_TRANSPORT_CAPTURE_INTERVAL_MS,
  MAX_CONCURRENT_IMAP_ACTION_SESSIONS,
  MAX_OPS_PER_IMAP_SESSION,
  resetImapSessionState,
} = await import("../mail/providers/imap-session.js");

const actions = imapMailActions("NAVER");

const authError = () =>
  Object.assign(new Error("Command failed"), {
    authenticationFailed: true,
    serverResponseCode: "AUTHENTICATIONFAILED",
  });

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// A caller gets its result as soon as its run settles, before LOGOUT and the
// hard close finish; teardown assertions wait one macrotask first.
const uidsOf = (range: string) => range.split(",").map(Number);
const msg = (account: string, uid: number) => `naver-imap:${account}@naver.com:${uid}`;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Every account id resolves to a NAVER row; `cipherOf` lets a test rotate a password. */
let cipherOf: (id: string) => string;

function armAccounts() {
  cipherOf = (id) => `cipher-${id}`;
  h.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => ({
    id: where.id,
    email: `${where.id}@naver.com`,
    imapHost: "imap.naver.com:993",
    imapPasswordCipher: cipherOf(where.id),
    inboxUidValidity: "7",
  }));
  h.decryptToken.mockReturnValue("pw");
  h.updateMany.mockResolvedValue({ count: 1 });
}

function armServer(uids: number[]) {
  h.server = new Map(uids.map((uid) => [uid, new Set<string>()]));
  h.ignoreStore = false;
  h.active = 0;
  h.maxActive = 0;
  h.connect.mockImplementation(async () => {
    h.active += 1;
    h.maxActive = Math.max(h.maxActive, h.active);
  });
  h.getMailboxLock.mockResolvedValue({ release: h.release });
  h.logout.mockImplementation(async () => {
    h.active -= 1;
  });
  const store = (add: boolean) => async (range: string, flags: string[]) => {
    if (!h.ignoreStore) {
      for (const uid of uidsOf(range)) {
        for (const flag of flags) {
          if (add) h.server.get(uid)?.add(flag);
          else h.server.get(uid)?.delete(flag);
        }
      }
    }
    return true;
  };
  h.messageFlagsAdd.mockImplementation(store(true));
  h.messageFlagsRemove.mockImplementation(store(false));
  h.fetch.mockImplementation((range: string) =>
    (async function* () {
      for (const uid of uidsOf(range)) {
        const held = h.server.get(uid);
        if (held) yield { uid, flags: new Set(held) };
      }
    })(),
  );
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

function warnedText(): string {
  return (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
  resetImapSessionState();
  armAccounts();
  armServer([]);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe("coalescing: one login per account per burst", () => {
  it("serves 100 concurrent toggleRead calls on one account with exactly one connect", async () => {
    const uids = range(1, 100);
    armServer(uids);

    const results = await Promise.all(
      uids.map((uid) => actions.toggleRead("u1", msg("a", uid), true, "a")),
    );

    expect(results).toHaveLength(100);
    for (const result of results) expect(result).toEqual({ success: true });
    expect(h.connect).toHaveBeenCalledTimes(1);
    await flush();
    expect(h.logout).toHaveBeenCalledTimes(1);
    // One STORE and one read-back for the whole burst, not 100 of each.
    expect(h.messageFlagsAdd).toHaveBeenCalledTimes(1);
    expect(h.messageFlagsAdd).toHaveBeenCalledWith(uids.join(","), ["\\Seen"], { uid: true });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    for (const uid of uids) expect(h.server.get(uid)?.has("\\Seen")).toBe(true);
    expect(h.updateMany).toHaveBeenCalledTimes(100);
  });

  it("gives every caller its own local update, scoped by userId and its own message id", async () => {
    armServer([1, 2]);
    await Promise.all([
      actions.markAsRead("u1", msg("a", 1), "a"),
      actions.markAsRead("u1", msg("a", 2), "a"),
    ]);
    expect(h.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", gmailId: msg("a", 1) },
      data: { isRead: true },
    });
    expect(h.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", gmailId: msg("a", 2) },
      data: { isRead: true },
    });
  });

  it("lets an operation queued while the login is still in flight join the same session", async () => {
    armServer([1, 2]);
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    h.connect.mockImplementation(async () => {
      h.active += 1;
      await gate;
    });

    const first = actions.markAsRead("u1", msg("a", 1), "a");
    await tick();
    expect(h.connect).toHaveBeenCalledTimes(1);
    const second = actions.markAsRead("u1", msg("a", 2), "a");
    await tick();
    openGate();

    expect(await Promise.all([first, second])).toEqual([{ success: true }, { success: true }]);
    expect(h.connect).toHaveBeenCalledTimes(1);
    await flush();
    expect(h.logout).toHaveBeenCalledTimes(1);
  });

  it("lets an operation queued while a STORE is in flight be drained by the same session", async () => {
    armServer([1, 2]);
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const realAdd = h.messageFlagsAdd.getMockImplementation();
    h.messageFlagsAdd.mockImplementationOnce(async (r: string, f: string[]) => {
      await gate;
      return realAdd?.(r, f);
    });

    const first = actions.markAsRead("u1", msg("a", 1), "a");
    await tick();
    await tick();
    const second = actions.markAsRead("u1", msg("a", 2), "a");
    await tick();
    openGate();

    expect(await Promise.all([first, second])).toEqual([{ success: true }, { success: true }]);
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.messageFlagsAdd).toHaveBeenCalledTimes(2);
  });

  it("stops one session at the per-session cap and logs in again for the rest", async () => {
    const total = MAX_OPS_PER_IMAP_SESSION + 50;
    const uids = range(1, total);
    armServer(uids);

    const results = await Promise.all(
      uids.map((uid) => actions.markAsRead("u1", msg("a", uid), "a")),
    );

    for (const result of results) expect(result).toEqual({ success: true });
    expect(h.connect).toHaveBeenCalledTimes(2);
    await flush();
    expect(h.logout).toHaveBeenCalledTimes(2);
    expect(h.messageFlagsAdd).toHaveBeenCalledTimes(2);
    expect(uidsOf(h.messageFlagsAdd.mock.calls[0][0])).toHaveLength(MAX_OPS_PER_IMAP_SESSION);
  });

  it("applies operations in the order they were queued, even when they alternate", async () => {
    armServer([1]);
    const results = await Promise.all([
      actions.toggleRead("u1", msg("a", 1), true, "a"),
      actions.toggleRead("u1", msg("a", 1), false, "a"),
      actions.toggleRead("u1", msg("a", 1), true, "a"),
    ]);

    for (const result of results) expect(result).toEqual({ success: true });
    expect(h.connect).toHaveBeenCalledTimes(1);
    const order = [
      ...h.messageFlagsAdd.mock.invocationCallOrder.map((n: number) => [n, "add"] as const),
      ...h.messageFlagsRemove.mock.invocationCallOrder.map((n: number) => [n, "remove"] as const),
    ]
      .sort(([a], [b]) => a - b)
      .map(([, kind]) => kind);
    expect(order).toEqual(["add", "remove", "add"]);
    expect(h.server.get(1)?.has("\\Seen")).toBe(true);
  });
});

describe("session cap across accounts", () => {
  it("opens one session per account when two accounts burst at once", async () => {
    armServer([1, 2]);
    const results = await Promise.all([
      actions.markAsRead("u1", msg("a", 1), "a"),
      actions.markAsRead("u1", msg("b", 2), "b"),
    ]);
    expect(results).toEqual([{ success: true }, { success: true }]);
    expect(h.connect).toHaveBeenCalledTimes(2);
    await flush();
    expect(h.logout).toHaveBeenCalledTimes(2);
  });

  it("never runs more than the named number of action sessions at the same time", async () => {
    const accounts = ["a", "b", "c", "d", "e", "f"];
    armServer([1]);
    h.connect.mockImplementation(async () => {
      h.active += 1;
      h.maxActive = Math.max(h.maxActive, h.active);
      await tick();
    });

    const results = await Promise.all(
      accounts.map((id) => actions.markAsRead("u1", msg(id, 1), id)),
    );

    for (const result of results) expect(result).toEqual({ success: true });
    expect(h.connect).toHaveBeenCalledTimes(accounts.length);
    expect(MAX_CONCURRENT_IMAP_ACTION_SESSIONS).toBe(3);
    expect(h.maxActive).toBe(MAX_CONCURRENT_IMAP_ACTION_SESSIONS);
  });
});

describe("per-caller results", () => {
  it("returns each caller its own outcome in a mixed success/failure drain", async () => {
    armServer([1, 3]); // UID 2 is gone from INBOX
    const [ok, gone, starred] = await Promise.all([
      actions.markAsRead("u1", msg("a", 1), "a"),
      actions.markAsRead("u1", msg("a", 2), "a"),
      actions.toggleStar("u1", msg("a", 3), true, "a"),
    ]);

    expect(ok).toEqual({ success: true });
    expect(gone).toMatchObject({ error: expect.stringMatching(/no longer/i) });
    expect(starred).toEqual({ success: true });
    expect(h.connect).toHaveBeenCalledTimes(1);
    // Only the confirmed callers touched their local rows.
    expect(h.updateMany).toHaveBeenCalledTimes(2);
    expect(h.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u1", gmailId: msg("a", 2) } }),
    );
  });

  it("fails only the callers whose change the server refused", async () => {
    armServer([1, 2]);
    const realAdd = h.messageFlagsAdd.getMockImplementation();
    h.messageFlagsAdd.mockImplementation(async (r: string, f: string[]) =>
      f[0] === "\\Flagged" ? false : realAdd?.(r, f),
    );

    const [read, star] = await Promise.all([
      actions.markAsRead("u1", msg("a", 1), "a"),
      actions.toggleStar("u1", msg("a", 2), true, "a"),
    ]);

    expect(read).toEqual({ success: true });
    expect(star).toMatchObject({ error: expect.any(String) });
    expect(h.updateMany).toHaveBeenCalledTimes(1);
  });

  it("keeps the results of finished runs when a later run throws, and fails the rest softly", async () => {
    armServer([1, 2]);
    const realAdd = h.messageFlagsAdd.getMockImplementation();
    h.messageFlagsAdd.mockImplementation(async (r: string, f: string[]) => {
      if (f[0] === "\\Flagged") throw new Error("socket hang up");
      return realAdd?.(r, f);
    });

    const [read, star] = await Promise.all([
      actions.markAsRead("u1", msg("a", 1), "a"),
      actions.toggleStar("u1", msg("a", 2), true, "a"),
    ]);

    expect(read).toEqual({ success: true });
    expect(star).toMatchObject({ error: expect.any(String) });
    expect(star).not.toHaveProperty("success");
    await flush();
    expect(h.logout).toHaveBeenCalledTimes(1);
    expect(h.captureError).toHaveBeenCalledTimes(1);
  });

  it("never leaves a caller hanging when the session cannot even lock INBOX", async () => {
    armServer([1, 2, 3]);
    h.getMailboxLock.mockRejectedValue(new Error("NO [UNAVAILABLE]"));

    const results = await Promise.all(
      [1, 2, 3].map((uid) => actions.markAsRead("u1", msg("a", uid), "a")),
    );

    for (const result of results) expect(result).toMatchObject({ error: expect.any(String) });
    expect(h.connect).toHaveBeenCalledTimes(1);
    await flush();
    expect(h.logout).toHaveBeenCalledTimes(1);
  });
});

describe("auth-failure cooldown", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
  });

  it("fails a burst with one login, then refuses without connecting until the cooldown ends", async () => {
    armServer([1]);
    h.connect.mockRejectedValue(authError());

    const burst = await Promise.all(
      [1, 1, 1].map((uid) => actions.markAsRead("u1", msg("a", uid), "a")),
    );
    for (const result of burst) {
      expect(result).toMatchObject({ error: expect.stringMatching(/reconnect/i) });
    }
    expect(h.connect).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 5; i += 1) {
      const blocked = await actions.markAsRead("u1", msg("a", 1), "a");
      expect(blocked).toMatchObject({ error: expect.stringMatching(/reconnect/i) });
    }
    expect(h.connect).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + IMAP_AUTH_COOLDOWN_MS - 1);
    await actions.markAsRead("u1", msg("a", 1), "a");
    expect(h.connect).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 1);
    await actions.markAsRead("u1", msg("a", 1), "a");
    expect(h.connect).toHaveBeenCalledTimes(2);
  });

  it("logs the refusal once per cooldown, not once per call", async () => {
    armServer([1]);
    h.connect.mockRejectedValue(authError());

    await actions.markAsRead("u1", msg("a", 1), "a");
    for (let i = 0; i < 10; i += 1) await actions.markAsRead("u1", msg("a", 1), "a");

    const refusals = warnedText()
      .split("\n")
      .filter((line) => /login rejected/i.test(line));
    expect(refusals).toHaveLength(1);
    expect(h.captureError).not.toHaveBeenCalled();
  });

  it("is per account: another mailbox still connects", async () => {
    armServer([1]);
    h.connect.mockRejectedValueOnce(authError());

    const bad = await actions.markAsRead("u1", msg("a", 1), "a");
    const other = await actions.markAsRead("u1", msg("b", 1), "b");

    expect(bad).toMatchObject({ error: expect.any(String) });
    expect(other).toEqual({ success: true });
    expect(h.connect).toHaveBeenCalledTimes(2);
  });

  it("ends as soon as the user reconnects with a new password (new stored cipher)", async () => {
    armServer([1]);
    h.connect.mockRejectedValueOnce(authError());
    await actions.markAsRead("u1", msg("a", 1), "a");
    expect(h.connect).toHaveBeenCalledTimes(1);

    cipherOf = (id) => `rotated-${id}`;
    const result = await actions.markAsRead("u1", msg("a", 1), "a");

    expect(result).toEqual({ success: true });
    expect(h.connect).toHaveBeenCalledTimes(2);
  });

  it("does not start a cooldown for a transport failure", async () => {
    armServer([1]);
    h.connect.mockRejectedValueOnce(new Error("connect ETIMEDOUT"));
    await actions.markAsRead("u1", msg("a", 1), "a");
    const result = await actions.markAsRead("u1", msg("a", 1), "a");
    expect(result).toEqual({ success: true });
    expect(h.connect).toHaveBeenCalledTimes(2);
  });
});

describe("transport-failure reporting", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
  });

  it("captures to Sentry at most once per account per interval, and warns otherwise", async () => {
    armServer([1]);
    h.connect.mockRejectedValue(new Error("connect ETIMEDOUT"));

    await actions.markAsRead("u1", msg("a", 1), "a");
    expect(h.captureError).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 60_000);
    const warnsBefore = warnedText()
      .split("\n")
      .filter((l) => /ETIMEDOUT/.test(l)).length;
    await actions.markAsRead("u1", msg("a", 1), "a");
    expect(h.captureError).toHaveBeenCalledTimes(1);
    const warnsAfter = warnedText()
      .split("\n")
      .filter((l) => /ETIMEDOUT/.test(l)).length;
    expect(warnsAfter).toBe(warnsBefore + 1);

    vi.setSystemTime(Date.now() + IMAP_TRANSPORT_CAPTURE_INTERVAL_MS);
    await actions.markAsRead("u1", msg("a", 1), "a");
    expect(h.captureError).toHaveBeenCalledTimes(2);
  });

  it("captures once for a whole failed burst, not once per caller", async () => {
    armServer([1, 2, 3]);
    h.connect.mockRejectedValue(new Error("connect ETIMEDOUT"));
    await Promise.all([1, 2, 3].map((uid) => actions.markAsRead("u1", msg("a", uid), "a")));
    expect(h.captureError).toHaveBeenCalledTimes(1);
  });

  it("tracks accounts independently", async () => {
    armServer([1]);
    h.connect.mockRejectedValue(new Error("connect ETIMEDOUT"));
    await actions.markAsRead("u1", msg("a", 1), "a");
    await actions.markAsRead("u1", msg("b", 1), "b");
    expect(h.captureError).toHaveBeenCalledTimes(2);
  });
});

describe("a refused coalesced STORE does not fail the valid UIDs", () => {
  it("serves 99 of 100 concurrent callers when the server NOs any set containing one bad UID", async () => {
    const uids = range(1, 100);
    const BAD = 42;
    armServer(uids);
    const realAdd = h.messageFlagsAdd.getMockImplementation();
    h.messageFlagsAdd.mockImplementation(async (r: string, f: string[]) =>
      uidsOf(r).includes(BAD) ? false : realAdd?.(r, f),
    );

    const results = await Promise.all(
      uids.map((uid) => actions.markAsRead("u1", msg("a", uid), "a")),
    );

    results.forEach((result, i) => {
      if (uids[i] === BAD) expect(result).toMatchObject({ error: expect.any(String) });
      else expect(result).toEqual({ success: true });
    });
    expect(results.filter((r) => "success" in r)).toHaveLength(99);
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.logout).toHaveBeenCalledTimes(1);
    expect(h.updateMany).toHaveBeenCalledTimes(99);
    expect(h.messageFlagsAdd.mock.calls.length).toBeLessThanOrEqual(20);
  });
});

describe("a throwing failure handler never leaves callers hanging", () => {
  it("settles a failed burst even when captureError itself throws, and the worker recovers", async () => {
    armServer([1, 2, 3]);
    h.connect.mockRejectedValueOnce(new Error("connect ETIMEDOUT"));
    h.captureError.mockImplementation(() => {
      throw new Error("sentry transport down");
    });

    const results = await Promise.all(
      [1, 2, 3].map((uid) => actions.markAsRead("u1", msg("a", uid), "a")),
    );

    for (const result of results) expect(result).toMatchObject({ error: expect.any(String) });
    expect(h.captureError).toHaveBeenCalledTimes(1);

    // The queue is not stuck: the next call opens a fresh session and works.
    expect(await actions.markAsRead("u1", msg("a", 1), "a")).toEqual({ success: true });
    expect(h.connect).toHaveBeenCalledTimes(2);
  });

  it("settles callers when something else inside the failure handler throws, without an unhandled rejection", async () => {
    armServer([1, 2]);
    h.connect.mockRejectedValueOnce(new Error("connect ETIMEDOUT"));
    const realWarn = console.warn as unknown as {
      mockImplementation: (f: (...a: unknown[]) => void) => void;
    };
    realWarn.mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes("action session failed")) throw new Error("log sink exploded");
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      const results = await Promise.all(
        [1, 2].map((uid) => actions.markAsRead("u1", msg("a", uid), "a")),
      );
      await tick();
      for (const result of results) expect(result).toMatchObject({ error: expect.any(String) });
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(await actions.markAsRead("u1", msg("a", 1), "a")).toEqual({ success: true });
  });
});
