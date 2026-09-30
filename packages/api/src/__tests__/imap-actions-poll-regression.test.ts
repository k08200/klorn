/**
 * Phase 0b regression shape, for the B1 flag actions: an action reports
 * success, the next poll runs, and the message state reverts or the message
 * reappears.
 *
 * Nothing in the chain is stubbed except the network edge and the database:
 *   - the REAL provider action (dispatch -> providers/imap.ts),
 *   - the REAL poll (syncImapInbox),
 *   - the REAL shared persist path (persistGmailEmail), which on an existing row
 *     overwrites isRead / isStarred / labels from whatever the poll read.
 * The IMAP server is a small stateful fake (one flag set per UID) behind a
 * faked imapflow; the database is an in-memory EmailMessage table.
 *
 * What the tests establish:
 *   - a confirmed change is what the server holds, so the next poll agrees with
 *     the local mirror (no revert) and never creates a second row;
 *   - a change the server did not really apply is reported as an error, never
 *     as success, so there is no "success then revert";
 *   - a poll that read its flags BEFORE the action landed can briefly show the
 *     old state; the following poll converges to the server (self-healing).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PASSWORD = "app-pw";
const EMAIL = "me@naver.com";
const HOST = "imap.naver.com:993";
const ROW_ID = "row-1";

const world = vi.hoisted(() => ({
  /** UID -> flag set on the fake server. */
  server: new Map<number, Set<string>>(),
  /** When true the server acknowledges STORE but never applies it. */
  ignoreStore: false,
  /** Runs once inside the next FETCH, after the flags were read. */
  midFetchHook: null as null | (() => Promise<void>),
  /** In-memory EmailMessage table keyed by id. */
  rows: new Map<string, Record<string, unknown>>(),
  creates: 0,
  nextId: 1,
}));

class FakeImapFlow {
  connect = async () => undefined;
  logout = async () => undefined;
  close = () => undefined;
  on = () => this;
  getMailboxLock = async () => ({ release: () => undefined });
  status = async () => ({ messages: world.server.size });

  fetch(range: string, _query?: unknown, opts?: { uid?: boolean }) {
    return opts?.uid ? this.readFlags(range) : this.readWindow();
  }

  /** The action's read-back: FLAGS of exactly the requested UIDs that exist. */
  private async *readFlags(range: string) {
    for (const uid of range.split(",").map(Number)) {
      const held = world.server.get(uid);
      if (held) yield { uid, flags: new Set(held) };
    }
  }

  /** The poll's window fetch: everything, with the flags read up front. */
  private async *readWindow() {
    const snapshot = [...world.server.entries()]
      .sort(([a], [b]) => a - b)
      .map(([uid, flags]) => ({ uid, flags: new Set(flags) }));
    const hook = world.midFetchHook;
    world.midFetchHook = null;
    if (hook) await hook();
    for (const { uid, flags } of snapshot) {
      yield {
        uid,
        envelope: {
          from: [{ name: "Kim", address: "kim@example.com" }],
          to: [{ name: "", address: EMAIL }],
          cc: null,
          subject: `Subject ${uid}`,
          date: new Date("2026-08-01T09:00:00Z"),
        },
        flags,
        bodyParts: new Map(),
      };
    }
  }

  private store(range: string, flags: string[], add: boolean) {
    // Like a real server: STORE on a missing UID still answers OK.
    if (world.ignoreStore) return true;
    for (const uid of range.split(",").map(Number)) {
      const held = world.server.get(uid);
      if (!held) continue;
      for (const flag of flags) {
        if (add) held.add(flag);
        else held.delete(flag);
      }
    }
    return true;
  }

  messageFlagsAdd = async (range: string, flags: string[]) => this.store(range, flags, true);
  messageFlagsRemove = async (range: string, flags: string[]) => this.store(range, flags, false);
}

vi.mock("imapflow", () => ({ ImapFlow: FakeImapFlow }));

vi.mock("../db.js", () => {
  const findRow = (userId: string, gmailId: string) =>
    [...world.rows.values()].find((r) => r.userId === userId && r.gmailId === gmailId);
  const prisma = {
    linkedInboxAccount: {
      findFirst: async ({ where }: { where: Record<string, string> }) => {
        if (where.userId !== "u1") return null;
        if (where.id === "row-1" && where.provider === "NAVER") {
          return {
            id: "row-1",
            email: "me@naver.com",
            imapHost: "imap.naver.com:993",
            imapPasswordCipher: "cipher",
          };
        }
        if (where.id === "row-2" && where.provider === "ICLOUD") {
          return {
            id: "row-2",
            email: "me@icloud.com",
            imapHost: "imap.mail.me.com:993",
            imapPasswordCipher: "cipher",
          };
        }
        return null;
      },
      updateMany: async () => ({ count: 1 }),
    },
    emailMessage: {
      findUnique: async ({
        where,
      }: {
        where: { userId_gmailId: { userId: string; gmailId: string } };
      }) => findRow(where.userId_gmailId.userId, where.userId_gmailId.gmailId) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        world.creates += 1;
        const row = { ...data, id: `e${world.nextId++}` };
        world.rows.set(row.id as string, row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const next = { ...(world.rows.get(where.id) ?? {}), ...data };
        world.rows.set(where.id, next);
        return next;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { userId: string; gmailId: string };
        data: Record<string, unknown>;
      }) => {
        const row = findRow(where.userId, where.gmailId);
        if (!row) return { count: 0 };
        world.rows.set(row.id as string, { ...row, ...data });
        return { count: 1 };
      },
    },
  };
  return { prisma, db: prisma };
});

vi.mock("../crypto-tokens.js", () => ({ decryptToken: () => "app-pw" }));

// Collaborators persistGmailEmail fires on a NEW row (same stubs as
// email-firewall-from-address.test.ts): nothing reaches an LLM or a real DB.
vi.mock("../judge/attention-mirror.js", () => ({ upsertAttentionForEmailJudgement: vi.fn() }));
vi.mock("../pim/commitment-ingestion.js", () => ({
  extractAndUpsertCommitmentsFromText: vi.fn(() => Promise.resolve()),
}));
vi.mock("../agentcore/email-action-trigger.js", () => ({
  scheduleAgentForActionableEmail: vi.fn(() => Promise.resolve()),
}));
vi.mock("../mail/email-attachments.js", () => ({
  analyzePendingEmailAttachments: vi.fn(() => Promise.resolve()),
  upsertEmailAttachments: vi.fn(() => Promise.resolve()),
}));
vi.mock("../mail/email-priority.js", () => ({
  classifyNeedsReplyFromSignals: vi.fn(() => ({ needsReply: false, reason: null, confidence: 0 })),
  classifyPriority: vi.fn(() => "NORMAL"),
}));
vi.mock("../mail/gmail.js", () => ({ markAsRead: vi.fn(() => Promise.resolve()) }));
vi.mock("../judge/judge-context.js", () => ({
  buildJudgeContext: vi.fn(() => Promise.resolve({})),
}));
vi.mock("../judge/judge-health.js", () => ({ recordJudgeSource: vi.fn() }));
vi.mock("../judge/keyword-policy.js", () => ({ isClearMarketing: vi.fn(() => false) }));
vi.mock("../llm/llm-credentials.js", () => ({
  getUserLlmCredentials: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("../judge/poc-judge.js", () => ({ judgeEmail: vi.fn(() => Promise.resolve("QUEUE")) }));
vi.mock("../resolve-user-email.js", () => ({
  resolveUserEmail: vi.fn(() => Promise.resolve("me@naver.com")),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const { syncImapInbox } = await import("../mail/imap-sync.js");
const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");
const { mailActionsForProvider } = await import("../mail/providers/dispatch.js");
const { resetImapSessionState } = await import("../mail/providers/imap-session.js");

const MSG_101 = `naver-imap:${EMAIL}:101`;
const MSG_102 = `naver-imap:${EMAIL}:102`;

const ORIGINAL_FLAG = process.env.IMAP_ACTIONS_ENABLED;
const ORIGINAL_ICLOUD_FLAG = process.env.ICLOUD_INBOX_ENABLED;

function poll() {
  return syncImapInbox({
    provider: IMAP_PROVIDERS.NAVER,
    userId: "u1",
    email: EMAIL,
    password: PASSWORD,
    host: HOST,
    linkedInboxAccountId: ROW_ID,
  });
}

function localRow(gmailId: string) {
  return [...world.rows.values()].find((r) => r.gmailId === gmailId);
}

const actions = () => mailActionsForProvider("NAVER");

beforeEach(() => {
  world.server = new Map([
    [101, new Set<string>()],
    [102, new Set<string>(["\\Seen", "\\Flagged"])],
  ]);
  world.ignoreStore = false;
  world.midFetchHook = null;
  world.rows = new Map();
  world.creates = 0;
  world.nextId = 1;
  process.env.IMAP_ACTIONS_ENABLED = "true";
  process.env.ICLOUD_INBOX_ENABLED = "true";
  resetImapSessionState();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.IMAP_ACTIONS_ENABLED;
  else process.env.IMAP_ACTIONS_ENABLED = ORIGINAL_FLAG;
  if (ORIGINAL_ICLOUD_FLAG === undefined) delete process.env.ICLOUD_INBOX_ENABLED;
  else process.env.ICLOUD_INBOX_ENABLED = ORIGINAL_ICLOUD_FLAG;
  vi.restoreAllMocks();
});

describe("action reports success -> next poll (flag ON)", () => {
  it("keeps a message read after the next poll, without re-creating it", async () => {
    await poll();
    expect(localRow(MSG_101)).toMatchObject({ isRead: false, labels: ["INBOX", "UNREAD"] });
    expect(world.creates).toBe(2);

    expect(await actions().markAsRead("u1", MSG_101, ROW_ID)).toEqual({ success: true });
    expect(localRow(MSG_101)).toMatchObject({ isRead: true });
    expect(world.server.get(101)?.has("\\Seen")).toBe(true);

    await poll();

    expect(localRow(MSG_101)).toMatchObject({ isRead: true, labels: ["INBOX"] });
    expect(world.rows.size).toBe(2);
    expect(world.creates).toBe(2);
  });

  it("keeps a star and an unstar across polls", async () => {
    await poll();

    expect(await actions().toggleStar("u1", MSG_101, true, ROW_ID)).toEqual({ success: true });
    await poll();
    expect(localRow(MSG_101)).toMatchObject({ isStarred: true });
    expect(localRow(MSG_101)?.labels).toContain("IMPORTANT");

    expect(await actions().toggleStar("u1", MSG_101, false, ROW_ID)).toEqual({ success: true });
    await poll();
    expect(localRow(MSG_101)).toMatchObject({ isStarred: false });
    expect(localRow(MSG_101)?.labels).not.toContain("IMPORTANT");
    expect(world.creates).toBe(2);
  });

  it("keeps a message unread after marking a read message unread", async () => {
    await poll();
    expect(localRow(MSG_102)).toMatchObject({ isRead: true });

    expect(await actions().toggleRead("u1", MSG_102, false, ROW_ID)).toEqual({ success: true });
    await poll();

    expect(localRow(MSG_102)).toMatchObject({ isRead: false });
    expect(localRow(MSG_102)?.labels).toContain("UNREAD");
    expect(world.server.get(102)?.has("\\Seen")).toBe(false);
  });

  it("does not report success when the server acknowledges the STORE but never applies it", async () => {
    await poll();
    world.ignoreStore = true;

    const result = await actions().markAsRead("u1", MSG_101, ROW_ID);
    expect(result).toMatchObject({ error: expect.any(String) });
    expect(result).not.toHaveProperty("success");
    expect(localRow(MSG_101)).toMatchObject({ isRead: false });

    await poll();
    expect(localRow(MSG_101)).toMatchObject({ isRead: false });
  });

  it("does not report success for a message that left INBOX, and the poll does not resurrect it", async () => {
    await poll();
    world.server.delete(101);

    const result = await actions().markAsRead("u1", MSG_101, ROW_ID);
    expect(result).toMatchObject({ error: expect.any(String) });
    expect(result).not.toHaveProperty("success");

    await poll();
    expect(world.rows.size).toBe(2);
    expect(world.creates).toBe(2);
  });

  it("never touches another user's row that happens to share a message id", async () => {
    await poll();
    world.rows.set("other", {
      id: "other",
      userId: "u2",
      gmailId: MSG_101,
      isRead: false,
    });

    await actions().markAsRead("u1", MSG_101, ROW_ID);

    expect(world.rows.get("other")).toMatchObject({ isRead: false });
    expect(localRow(MSG_101)).toBeDefined();
  });
});

describe("a poll that read its flags before the action landed", () => {
  it("can briefly show the old state, and the next poll converges to the server", async () => {
    await poll();

    // The action lands while the second poll is mid-flight: the poll already
    // read UID 101 as unread, then persists that stale read over the local row.
    world.midFetchHook = async () => {
      expect(await actions().markAsRead("u1", MSG_101, ROW_ID)).toEqual({ success: true });
    };
    await poll();
    // Characterisation of a known, self-healing window (documented in the plan):
    expect(localRow(MSG_101)).toMatchObject({ isRead: false });
    expect(world.server.get(101)?.has("\\Seen")).toBe(true);

    await poll();
    expect(localRow(MSG_101)).toMatchObject({ isRead: true });
    expect(world.creates).toBe(2);
  });
});

describe("flag flipped off in the same process", () => {
  it("answers unsupported without touching the server, and works again once flipped back on", async () => {
    await poll();

    expect(await actions().markAsRead("u1", MSG_101, ROW_ID)).toEqual({ success: true });
    expect(world.server.get(101)?.has("\\Seen")).toBe(true);

    process.env.IMAP_ACTIONS_ENABLED = "false";
    const refused = await actions().toggleRead("u1", MSG_101, false, ROW_ID);
    expect(refused).toMatchObject({ unsupported: true });
    expect(world.server.get(101)?.has("\\Seen")).toBe(true);
    await poll();
    expect(localRow(MSG_101)).toMatchObject({ isRead: true });

    process.env.IMAP_ACTIONS_ENABLED = "true";
    expect(await actions().toggleRead("u1", MSG_101, false, ROW_ID)).toEqual({ success: true });
    expect(world.server.get(101)?.has("\\Seen")).toBe(false);
  });
});

describe("ICLOUD: action reports success -> next poll", () => {
  const ICLOUD_EMAIL = "me@icloud.com";
  const ICLOUD_ROW = "row-2";
  const ICLOUD_MSG = (uid: number) => `icloud-imap:${ICLOUD_EMAIL}:${uid}`;

  function pollIcloud() {
    return syncImapInbox({
      provider: IMAP_PROVIDERS.ICLOUD,
      userId: "u1",
      email: ICLOUD_EMAIL,
      password: PASSWORD,
      host: "imap.mail.me.com:993",
      linkedInboxAccountId: ICLOUD_ROW,
    });
  }

  it("keeps a read and a star across the next poll without re-creating rows", async () => {
    await pollIcloud();
    expect(localRow(ICLOUD_MSG(101))).toMatchObject({ isRead: false, isStarred: false });
    const created = world.creates;

    const icloud = mailActionsForProvider("ICLOUD");
    expect(await icloud.markAsRead("u1", ICLOUD_MSG(101), ICLOUD_ROW)).toEqual({ success: true });
    expect(await icloud.toggleStar("u1", ICLOUD_MSG(101), true, ICLOUD_ROW)).toEqual({
      success: true,
    });
    await pollIcloud();

    expect(localRow(ICLOUD_MSG(101))).toMatchObject({ isRead: true, isStarred: true });
    expect(world.creates).toBe(created);
  });

  it("does not report success when the server never applies the change", async () => {
    await pollIcloud();
    world.ignoreStore = true;

    const result = await mailActionsForProvider("ICLOUD").markAsRead(
      "u1",
      ICLOUD_MSG(101),
      ICLOUD_ROW,
    );

    expect(result).toMatchObject({ error: expect.any(String) });
    await pollIcloud();
    expect(localRow(ICLOUD_MSG(101))).toMatchObject({ isRead: false });
  });
});
