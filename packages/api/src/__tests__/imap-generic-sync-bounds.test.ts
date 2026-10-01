/**
 * Step B4 review fix: what one generic poll session may cost. The real
 * syncImapInbox, with imapflow, the resolver and the persist chain faked:
 *
 *   - the body is fetched as a bounded slice of TEXT (imapflow's `bodyParts`
 *     accepts `{ key, start, maxLength }`, sent as BODY.PEEK[TEXT]<0.N>);
 *   - a server that keeps yielding messages is cut off at `limit`, so a lying
 *     server cannot make one poll unbounded;
 *   - a failed generic poll is reported once, by the account fan-out
 *     (imap-accounts.ts), not here, and its log line is one capped line;
 *   - Naver and iCloud are byte-identical: the whole TEXT, no cap, and the same
 *     report and log as before.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  connect: vi.fn(),
  getMailboxLock: vi.fn(),
  status: vi.fn(),
  fetchImpl: vi.fn(),
  logout: vi.fn(),
  close: vi.fn(),
  on: vi.fn(),
  release: vi.fn(),
  resolve: vi.fn(),
  persist: vi.fn(),
  captureError: vi.fn(),
}));

class FakeImapFlow {
  connect = fake.connect;
  getMailboxLock = fake.getMailboxLock;
  status = fake.status;
  fetch = (...args: unknown[]) => fake.fetchImpl(...args);
  logout = fake.logout;
  close = fake.close;
  on = fake.on;
  mailbox = { uidValidity: 7n };
}

vi.mock("imapflow", () => ({ ImapFlow: FakeImapFlow }));
vi.mock("../mail/host-resolver.js", () => ({
  DNS_QUERY_TIMEOUT_MS: 3000,
  resolveHostAddresses: (...args: unknown[]) => fake.resolve(...args),
}));
vi.mock("../db.js", () => ({ prisma: {} }));
vi.mock("../sentry.js", () => ({
  captureError: (...args: unknown[]) => fake.captureError(...args),
}));
vi.mock("../judge/email-firewall.js", () => ({
  persistGmailEmail: (...args: unknown[]) => fake.persist(...args),
}));

const { syncImapInbox } = await import("../mail/imap-sync.js");
const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");
const { GENERIC_TEXT_FETCH_BYTES } = await import("../mail/generic-imap-bounds.js");

const GENERIC = IMAP_PROVIDERS.IMAP;
const NAVER = IMAP_PROVIDERS.NAVER;

function args(provider = GENERIC, over: Record<string, unknown> = {}) {
  return {
    provider,
    userId: "u1",
    email: provider === NAVER ? "me@naver.com" : "me@example.com",
    password: "pw",
    host: provider === NAVER ? "imap.naver.com:993" : "imap.example.com:993",
    ...over,
  };
}

/** A server that yields `count` messages (as many as it is pulled for), recording how far it got. */
function yielding(count: number) {
  const state = { yielded: 0, returned: false };
  fake.fetchImpl.mockImplementation(() =>
    (async function* () {
      try {
        for (let uid = 1; uid <= count; uid++) {
          state.yielded = uid;
          yield { uid, flags: new Set<string>(), envelope: { subject: `m${uid}` } };
        }
      } finally {
        state.returned = true;
      }
    })(),
  );
  return state;
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.connect.mockResolvedValue(undefined);
  fake.getMailboxLock.mockResolvedValue({ release: fake.release });
  fake.status.mockResolvedValue({ messages: 5_000 });
  fake.logout.mockResolvedValue(undefined);
  fake.resolve.mockResolvedValue(["93.184.216.34"]);
  fake.persist.mockResolvedValue({ isNew: false });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("the body is a bounded slice", () => {
  it("generic: TEXT with a byte range, so a huge body is never transferred", async () => {
    yielding(1);
    await syncImapInbox(args());
    const query = fake.fetchImpl.mock.calls[0][1] as { bodyParts: unknown[] };
    expect(query.bodyParts).toEqual([
      { key: "TEXT", start: 0, maxLength: GENERIC_TEXT_FETCH_BYTES },
    ]);
    expect(GENERIC_TEXT_FETCH_BYTES).toBeGreaterThanOrEqual(50_000); // what persist keeps
    expect(GENERIC_TEXT_FETCH_BYTES).toBeLessThanOrEqual(256 * 1024);
  });

  it("Naver: the whole TEXT, exactly as before", async () => {
    yielding(1);
    await syncImapInbox(args(NAVER));
    const query = fake.fetchImpl.mock.calls[0][1];
    expect(query).toEqual({ envelope: true, flags: true, bodyParts: ["TEXT"] });
  });

  it("generic keeps the rest of the query unchanged", async () => {
    yielding(1);
    await syncImapInbox(args());
    expect(fake.fetchImpl.mock.calls[0][1]).toMatchObject({ envelope: true, flags: true });
    expect(fake.fetchImpl.mock.calls[0][2]).toEqual({ uid: false });
  });
});

describe("a lying server cannot yield more than the window", () => {
  it("generic: stops pulling at the default window of 50", async () => {
    const server = yielding(10_000);
    const result = await syncImapInbox(args());
    expect(result.fetched).toBe(50);
    expect(fake.persist).toHaveBeenCalledTimes(50);
    expect(server.yielded).toBe(50); // never asked for the 51st
    expect(server.returned).toBe(true); // the iteration was closed, not abandoned
  });

  it("generic: honours a smaller limit", async () => {
    const server = yielding(10_000);
    const result = await syncImapInbox(args(GENERIC, { limit: 5 }));
    expect(result.fetched).toBe(5);
    expect(server.yielded).toBe(5);
  });

  it("generic: an honest server with fewer messages than the window is untouched", async () => {
    yielding(7);
    const result = await syncImapInbox(args());
    expect(result.fetched).toBe(7);
  });

  it("generic: the session is still ended and the lock released after the cut-off", async () => {
    yielding(10_000);
    await syncImapInbox(args());
    expect(fake.release).toHaveBeenCalledTimes(1);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it("Naver: unchanged, there is no cap on what the loop consumes", async () => {
    const server = yielding(120);
    const result = await syncImapInbox(args(NAVER));
    expect(result.fetched).toBe(120);
    expect(server.yielded).toBe(120);
  });
});

describe("a failed poll", () => {
  const failWith = (message: string) => fake.connect.mockRejectedValue(new Error(message));
  const loggedLines = () =>
    (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((call) =>
      call.map(String).join(" "),
    );

  it("generic: is rethrown but NOT reported from here (the fan-out reports once per account and kind)", async () => {
    failWith("connect ECONNREFUSED 93.184.216.34:993");
    await expect(syncImapInbox(args())).rejects.toThrow("ECONNREFUSED");
    expect(fake.captureError).not.toHaveBeenCalled();
  });

  it("generic: logs one capped line whatever the server said", async () => {
    failWith(`bad\r\n[generic-imap] FORGED ${"Q".repeat(20_000)}`);
    await expect(syncImapInbox(args())).rejects.toThrow();
    const failed = loggedLines().filter((line) => line.includes("sync failed"));
    expect(failed).toHaveLength(1);
    expect(failed[0]).not.toMatch(/[\r\n]/);
    expect(failed[0].length).toBeLessThan(600);
  });

  it("Naver: reported from here exactly as before, with the raw message logged", async () => {
    failWith("boom\r\nraw text");
    await expect(syncImapInbox(args(NAVER))).rejects.toThrow("boom");
    expect(fake.captureError).toHaveBeenCalledTimes(1);
    expect(fake.captureError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { scope: "naver-imap.sync" },
      extra: { userId: "u1" },
    });
    const warn = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.find(
      (call) => String(call[0]).includes("sync failed"),
    );
    expect(warn?.[1]).toBe("boom\r\nraw text");
  });
});
