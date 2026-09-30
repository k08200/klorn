/**
 * Phase 0b regression shape, for the B2 move actions: an action reports success,
 * the next poll runs, and the message reappears, is duplicated or is lost. Plus the
 * UIDVALIDITY half of step B2: the poller records the INBOX value, and a server
 * that renumbers the mailbox cannot make a stale row act on the wrong message.
 *
 * Nothing in the chain is stubbed except the network edge and the judge:
 *   - the REAL provider actions through the REAL dispatch (flag ON),
 *   - the REAL poll fan-out (syncImapAccountsForUser -> syncImapInbox),
 *   - the REAL shared persist path (persistGmailEmail) writing to the strict
 *     in-memory database, which validates every column against the real schema.
 * The server is the stateful fake: folders with their own UIDVALIDITY, a MOVE that
 * assigns a new UID in the destination, a renumbering that reuses UIDs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-db.js";
import { fakeServer } from "./helpers/fake-imap-server.js";
import { accountRow, idOf, localIds, NAVER, newDb, USER } from "./helpers/imap-move-harness.js";

let db: FakeDb;

vi.mock("imapflow", async () => ({
  ImapFlow: (await import("./helpers/fake-imap-server.js")).FakeImapFlow,
}));
vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(() => db);
  return { prisma, db: prisma };
});
vi.mock("../crypto-tokens.js", () => ({ decryptToken: () => "app-pw" }));

// Collaborators persistGmailEmail fires on a NEW row: nothing reaches an LLM.
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

const { syncImapAccountsForUser, syncImapMessageForUser } = await import(
  "../mail/imap-accounts.js"
);
const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");
const { mailActionsForProvider } = await import("../mail/providers/dispatch.js");
const { resetImapSessionState } = await import("../mail/providers/imap-session.js");

const FLAGS = [
  "IMAP_MOVE_ACTIONS_ENABLED",
  "IMAP_ACTIONS_ENABLED",
  "ICLOUD_INBOX_ENABLED",
] as const;
const original = Object.fromEntries(FLAGS.map((name) => [name, process.env[name]]));

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const poll = () => syncImapAccountsForUser(USER, IMAP_PROVIDERS.NAVER);
const actions = () => mailActionsForProvider("NAVER");
const creates = () => (db.writes.emailMessage ?? []).filter((w) => w.op === "create").length;
const storedValidity = () =>
  (db.tables.linkedInboxAccount ?? []).find((row) => row.id === NAVER.rowId)?.inboxUidValidity;
const rowFor = (gmailId: string) =>
  (db.tables.emailMessage ?? []).find((r) => r.gmailId === gmailId);

function arm(storedInboxValidity: string | null = "1000") {
  db = newDb({ accounts: [accountRow(NAVER, storedInboxValidity)] });
}

/** Put messages in the server's INBOX with UIDs 101.. and let the REAL poll ingest them. */
async function ingest(count: number): Promise<string[]> {
  const uids = Array.from({ length: count }, (_, i) => 101 + i);
  for (const uid of uids) fakeServer.add("INBOX", { uid, subject: `Mail ${uid}` });
  await poll();
  return uids.map((uid) => idOf(NAVER, uid));
}

beforeEach(() => {
  fakeServer.reset();
  arm();
  resetImapSessionState();
  process.env.IMAP_MOVE_ACTIONS_ENABLED = "true";
  delete process.env.IMAP_ACTIONS_ENABLED;
  delete process.env.ICLOUD_INBOX_ENABLED;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await flush();
  expect(fakeServer.destructiveCommands).toEqual([]);
  expect(fakeServer.openLocks).toBe(0);
  for (const name of FLAGS) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.restoreAllMocks();
});

describe("the poller records the INBOX UIDVALIDITY", () => {
  it("stores the first value it sees for a mailbox", async () => {
    arm(null);
    await ingest(1);

    expect(storedValidity()).toBe("1000");
  });

  it("does not write it again while it is unchanged", async () => {
    await ingest(1);
    await poll();

    const writes = (db.writes.linkedInboxAccount ?? []).filter(
      (w) => w.data && "inboxUidValidity" in w.data,
    );
    expect(writes).toEqual([]);
  });

  it("keeps working, and writes nothing, when the server reports no usable value", async () => {
    arm(null);
    // 0 is not a valid UIDVALIDITY (RFC 3501: non-zero), i.e. nothing usable.
    fakeServer.folder("INBOX").uidValidity = 0n;

    await ingest(2);

    expect(storedValidity()).toBeNull();
    expect(localIds(db)).toHaveLength(2);
  });
});

describe("a server that renumbers the mailbox", () => {
  it("refuses an action on a now-stale row, then the poll re-baselines and retires the stale rows", async () => {
    await ingest(2);
    fakeServer.renumber("INBOX", 1001n);
    fakeServer.commands = [];

    const refused = await actions().trash(USER, idOf(NAVER, 101), NAVER.rowId);

    expect(refused).toMatchObject({ error: expect.any(String) });
    expect(fakeServer.commands.filter((c) => c.includes("MOVE"))).toEqual([]);
    expect(localIds(db)).toEqual([idOf(NAVER, 101), idOf(NAVER, 102)]);

    await poll();

    expect(storedValidity()).toBe("1001");
    // The same two messages, under their new numbers, and nothing left of the old keys.
    expect(localIds(db)).toEqual([idOf(NAVER, 1), idOf(NAVER, 2)]);
  });

  it("does not mistake a reused UID for the message that used to have it (no lost mail)", async () => {
    fakeServer.add("INBOX", { uid: 1, subject: "Old A" });
    fakeServer.add("INBOX", { uid: 2, subject: "Old B" });
    await poll();
    // The mailbox is rebuilt: new validity, UID 1 now belongs to a different message.
    const inbox = fakeServer.folder("INBOX");
    inbox.messages.clear();
    inbox.uidValidity = 1001n;
    inbox.nextUid = 1;
    fakeServer.add("INBOX", { uid: 1, subject: "Brand new C" });

    await poll();

    expect(rowFor(idOf(NAVER, 1))).toMatchObject({ subject: "Brand new C" });
    expect(rowFor(idOf(NAVER, 2))).toBeUndefined();
  });

  it("resolves the open attention items of the rows it retires, and keeps a finished decision", async () => {
    await ingest(2);
    const [first, second] = db.tables.emailMessage ?? [];
    const item = (id: string, userId: string, sourceId: unknown, status: string) => ({
      id,
      userId,
      source: "EMAIL",
      sourceId,
      status,
    });
    db.tables.attentionItem = [
      item("open", USER, first.id, "OPEN"),
      item("snoozed", USER, second.id, "SNOOZED"),
      item("dismissed", USER, first.id, "DISMISSED"),
      item("other-user", "u2", first.id, "OPEN"),
    ];
    fakeServer.renumber("INBOX", 1001n);

    await poll();

    const status = (id: string) => db.tables.attentionItem?.find((row) => row.id === id)?.status;
    expect(status("open")).toBe("RESOLVED");
    expect(status("snoozed")).toBe("RESOLVED");
    expect(status("dismissed")).toBe("DISMISSED");
    expect(status("other-user")).toBe("OPEN");
  });

  it("does not let a just-recorded move delete a new message that reuses its UID", async () => {
    const [a] = await ingest(1);
    await actions().trash(USER, a, NAVER.rowId);
    // The mailbox is rebuilt right after: UID 101 now belongs to a different message.
    const inbox = fakeServer.folder("INBOX");
    inbox.uidValidity = 1001n;
    inbox.nextUid = 101;
    fakeServer.add("INBOX", { uid: 101, subject: "Brand new after the rebuild" });

    await poll();

    expect(rowFor(idOf(NAVER, 101))).toMatchObject({ subject: "Brand new after the rebuild" });
  });

  it("acts on the fresh rows once the poll has re-baselined", async () => {
    await ingest(1);
    fakeServer.renumber("INBOX", 1001n);
    await poll();

    const result = await actions().trash(USER, idOf(NAVER, 1), NAVER.rowId);

    expect(result).toEqual({ success: true });
    expect(fakeServer.uidsIn("Trash")).toHaveLength(1);
  });

  it("guards a row that predates the reset even after the poll re-baselined, by the envelope", async () => {
    // A stale row survives only if something keeps it (here: seeded directly). The
    // validity now matches, so the subject and date are the last line of defence.
    const uid = fakeServer.add("INBOX", { uid: 101, subject: "Reused number, other mail" });
    arm("1000");
    db.tables.emailMessage = [
      {
        id: "stale",
        userId: USER,
        gmailId: idOf(NAVER, uid),
        linkedInboxAccountId: NAVER.rowId,
        from: "Kim <kim@example.com>",
        to: NAVER.email,
        subject: "What the row remembers",
        labels: ["INBOX"],
        receivedAt: new Date("2026-08-01T09:00:00Z"),
      },
    ];

    const result = await actions().trash(USER, idOf(NAVER, uid), NAVER.rowId);

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(fakeServer.uidsIn("INBOX")).toEqual([uid]);
  });

  it("purges only this mailbox's rows: another account and another user keep theirs", async () => {
    await ingest(1);
    db.tables.emailMessage = [
      ...(db.tables.emailMessage ?? []),
      {
        id: "other-account",
        userId: USER,
        gmailId: "icloud-imap:me@icloud.com:101",
        linkedInboxAccountId: "row-2",
        from: "x",
        to: "y",
        subject: "s",
        labels: [],
        receivedAt: new Date(),
      },
      {
        id: "other-user",
        userId: "u2",
        gmailId: idOf(NAVER, 101),
        linkedInboxAccountId: NAVER.rowId,
        from: "x",
        to: "y",
        subject: "s",
        labels: [],
        receivedAt: new Date(),
      },
      {
        id: "gmail-row",
        userId: USER,
        gmailId: "18c2f0a1b2c3d4e5",
        linkedInboxAccountId: null,
        from: "x",
        to: "y",
        subject: "s",
        labels: [],
        receivedAt: new Date(),
      },
    ];
    fakeServer.renumber("INBOX", 1001n);

    await poll();

    const remaining = (db.tables.emailMessage ?? []).map((r) => r.id);
    expect(remaining).toEqual(expect.arrayContaining(["other-account", "other-user", "gmail-row"]));
  });

  it("does not re-baseline when the purge fails, so the next poll retries the reset", async () => {
    await ingest(1);
    fakeServer.renumber("INBOX", 1001n);
    vi.spyOn(db.model("emailMessage"), "deleteMany").mockRejectedValueOnce(
      new Error("pooler dropped"),
    );

    await poll();
    expect(storedValidity()).toBe("1000");

    await poll();
    expect(storedValidity()).toBe("1001");
    expect(localIds(db)).toEqual([idOf(NAVER, 1)]);
  });
});

describe("a move reports success, then the next poll", () => {
  it("does not resurrect a trashed message, duplicate it, or lose its neighbours", async () => {
    const [a, b, c] = await ingest(3);
    expect(creates()).toBe(3);

    expect(await actions().trash(USER, b, NAVER.rowId)).toEqual({ success: true });
    await poll();

    expect(localIds(db)).toEqual([a, c]);
    expect(creates()).toBe(3);
    expect(fakeServer.uidsIn("INBOX")).toEqual([101, 103]);
    expect(fakeServer.uidsIn("Trash")).toHaveLength(1);
  });

  it("does not resurrect an archived message either", async () => {
    const [a, b] = await ingest(2);

    expect(await actions().archive(USER, a, NAVER.rowId)).toEqual({ success: true });
    await poll();
    await poll();

    expect(localIds(db)).toEqual([b]);
    expect(creates()).toBe(2);
  });

  it("does not report success for a move the server refused, and the poll keeps the row", async () => {
    const [a, b] = await ingest(2);
    fakeServer.refuseMoveFor = new Set([101]);

    const result = await actions().trash(USER, a, NAVER.rowId);
    await poll();

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(result).not.toHaveProperty("success");
    expect(localIds(db)).toEqual([a, b]);
    expect(fakeServer.uidsIn("INBOX")).toEqual([101, 102]);
    expect(creates()).toBe(2);
  });

  it("removes a row the poll wrote back while the move was landing, within the same poll", async () => {
    const [a, b] = await ingest(2);
    // The poll has read UID 101 from INBOX; the trash lands before it persists it.
    fakeServer.midFetchHook = async () => {
      expect(await actions().trash(USER, a, NAVER.rowId)).toEqual({ success: true });
    };

    await poll();

    expect(localIds(db)).toEqual([b]);
    expect(fakeServer.uidsIn("Trash")).toHaveLength(1);
  });

  it("does not look at recorded moves at all while the flag is off", async () => {
    await ingest(1);
    process.env.IMAP_MOVE_ACTIONS_ENABLED = "false";
    db.reads.length = 0;

    await poll();

    expect(db.reads).not.toContain("imapMovedMessage");
  });
});

describe("undo, then the poll", () => {
  it("restores a trashed message under its NEW INBOX id, and the poll creates nothing more", async () => {
    const [a] = await ingest(1);
    await actions().trash(USER, a, NAVER.rowId);

    const restored = await actions().untrash(USER, a, NAVER.rowId);

    expect(restored).toEqual({ success: true, restoredMessageId: idOf(NAVER, 102) });
    const before = creates();
    const synced = await syncImapMessageForUser(
      USER,
      IMAP_PROVIDERS.NAVER,
      NAVER.rowId,
      idOf(NAVER, 102),
    );
    expect(synced).toMatchObject({ emailId: expect.any(String) });
    expect(creates()).toBe(before + 1);

    await poll();
    await poll();

    expect(localIds(db)).toEqual([idOf(NAVER, 102)]);
    expect(creates()).toBe(before + 1);
    expect(rowFor(idOf(NAVER, 102))).toMatchObject({ subject: "Mail 101" });
  });

  it("does not duplicate the message when only the poll brings it back", async () => {
    const [a] = await ingest(1);
    await actions().trash(USER, a, NAVER.rowId);
    await actions().untrash(USER, a, NAVER.rowId);

    await poll();
    await poll();

    expect(localIds(db)).toEqual([idOf(NAVER, 102)]);
    expect(creates()).toBe(2);
  });

  it("round-trips an archived message without losing its neighbour", async () => {
    const [a, b] = await ingest(2);

    await actions().archive(USER, a, NAVER.rowId);
    const restored = await actions().unarchive(USER, a, NAVER.rowId);
    await poll();

    expect(restored).toMatchObject({ restoredMessageId: idOf(NAVER, 103) });
    expect(localIds(db)).toEqual([b, idOf(NAVER, 103)].sort());
    expect(fakeServer.uidsIn("Archive")).toEqual([]);
  });

  it("re-syncing a message that is not in INBOX answers null instead of inventing a row", async () => {
    await ingest(1);

    const synced = await syncImapMessageForUser(
      USER,
      IMAP_PROVIDERS.NAVER,
      NAVER.rowId,
      idOf(NAVER, 999),
    );

    expect(synced).toBeNull();
    expect(creates()).toBe(1);
  });

  it("re-syncing refuses an id that is not this mailbox's, before connecting", async () => {
    await ingest(1);
    fakeServer.logins = 0;

    const synced = await syncImapMessageForUser(
      USER,
      IMAP_PROVIDERS.NAVER,
      NAVER.rowId,
      "naver-imap:other@naver.com:5",
    );

    expect(synced).toBeNull();
    expect(fakeServer.logins).toBe(0);
  });
});
