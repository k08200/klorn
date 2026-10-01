/**
 * A generic IMAP mailbox (step B4) under the B2b UIDVALIDITY rules
 * (docs/providers/unified-platform-plan.md). B2b's own suite runs a Naver mailbox;
 * this runs the same real poll, over the same stateful fake server and strict
 * in-memory database, for a mailbox whose ids are `generic-imap:<email>:<uid>` and
 * whose host is a user-supplied name connected to through the pinned client. What is
 * pinned here:
 *   - a held generic mailbox persists nothing and does NOT stamp lastSyncedAt, and the
 *     first ingesting poll after the repair does;
 *   - a confirmed reset re-keys the mailbox's rows with a tombstone suffix, resolves
 *     its OPEN and SNOOZED items, deletes nothing and leaves other mailboxes alone;
 *   - the re-ingested window and the tombstones are history, mail received during the
 *     hold is not;
 *   - actions refuse a tombstoned generic id without a command;
 *   - the scheduler's in-flight guard and the hold work together: overlapping ticks
 *     skip, and a held generic mailbox is not stamped by any of them.
 *
 * The clock is faked (Date only) so that "a later poll" is a matter of one call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "./helpers/fake-db.js";
import { fakeServer } from "./helpers/fake-imap-server.js";
import {
  accountRow,
  GENERIC,
  idOf,
  localRowFor,
  type Mailbox,
  NAVER,
  USER,
} from "./helpers/imap-move-harness.js";

let db: FakeDb;

vi.mock("imapflow", async () => ({
  ImapFlow: (await import("./helpers/fake-imap-server.js")).FakeImapFlow,
}));
vi.mock("../mail/host-resolver.js", () => ({
  DNS_QUERY_TIMEOUT_MS: 3000,
  resolveHostAddresses: vi.fn(async () => ["93.184.216.34"]),
}));
vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(() => db, { rollbackOnError: true });
  return { prisma, db: prisma };
});
vi.mock("../crypto-tokens.js", () => ({ decryptToken: () => "app-pw" }));
vi.mock("../notify/conversations-updated.js", () => ({ notifyConversationsUpdated: vi.fn() }));
vi.mock("../scheduler-heartbeat.js", () => ({
  registerScheduler: vi.fn(),
  recordSchedulerTick: vi.fn(),
}));

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
  resolveUserEmail: vi.fn(() => Promise.resolve("me@example.com")),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const { resolveHostAddresses } = await import("../mail/host-resolver.js");
const { resetPollGuardState } = await import("../mail/imap-poll-guards.js");
const { findReingestedHistory } = await import("../mail/imap-history.js");
const { syncImapAccountsForUser, syncImapMessageForUser } = await import(
  "../mail/imap-accounts.js"
);
const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");
const { mailActionsForProvider } = await import("../mail/providers/dispatch.js");
const { resetImapSessionState } = await import("../mail/providers/imap-session.js");
const { resetPollFailureState } = await import("../mail/imap-poll-failures.js");
const { runImapTick, stopImapScheduler } = await import("../mail/imap-scheduler.js");

const FLAGS = [
  "GENERIC_IMAP_ENABLED",
  "IMAP_MOVE_ACTIONS_ENABLED",
  "IMAP_ACTIONS_ENABLED",
  "ICLOUD_INBOX_ENABLED",
] as const;
const original = Object.fromEntries(FLAGS.map((name) => [name, process.env[name]]));

const T0 = new Date("2026-09-30T10:00:00Z");
const MINUTE = 60_000;
const POLL_INTERVAL = 5 * MINUTE;
/** What the per-user poll aggregate reports for a held mailbox: nothing fetched or stored. */
const HELD = { fetched: 0, inserted: 0, classified: 0, errors: 0 };

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const advance = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));
const poll = () => syncImapAccountsForUser(USER, IMAP_PROVIDERS.IMAP);
/** The next scheduler tick: five minutes later, then a poll. */
const nextPoll = async () => {
  advance(POLL_INTERVAL);
  return poll();
};
const actions = () => mailActionsForProvider("IMAP");
/** The id a repair at `repairedAt` gives a row of the `old` numbering. */
const tomb = (id: string, old: string, repairedAt: number) => `${id}#uv${old}.${repairedAt}`;

const emails = (): Row[] => db.tables.emailMessage ?? [];
const account = (): Row =>
  (db.tables.linkedInboxAccount ?? []).find((row) => row.id === GENERIC.rowId) as Row;
const rowByGmailId = (gmailId: string) => emails().find((r) => r.gmailId === gmailId);
const gmailIds = () => emails().map((r) => r.gmailId as string);
const rekeys = () => db.writes.$executeRaw ?? [];
const emailWrites = () => (db.writes.emailMessage ?? []).length;
const creates = () => (db.writes.emailMessage ?? []).filter((w) => w.op === "create").length;
const deletes = (model: string) => (db.writes[model] ?? []).filter((w) => w.op === "deleteMany");
const lastSyncedAt = () => (account().lastSyncedAt as Date | undefined)?.getTime();

const arm = (stored: string | null = "1000") => {
  db = createFakeDb({
    linkedInboxAccount: [accountRow(GENERIC, stored)],
    emailMessage: [],
    imapMovedMessage: [],
    attentionItem: [],
  });
};

/** Put messages in INBOX with UIDs 101.. and let the REAL poll ingest them. */
async function ingest(count: number): Promise<string[]> {
  const uids = Array.from({ length: count }, (_, i) => 101 + i);
  for (const uid of uids) fakeServer.add("INBOX", { uid, subject: `Mail ${uid}` });
  await poll();
  return uids.map((uid) => idOf(GENERIC, uid));
}

/** The server rebuilds INBOX: a new UIDVALIDITY, UID 101 now names a different message. */
function rebuildWithReusedUid(validity: bigint) {
  const inbox = fakeServer.folder("INBOX");
  inbox.messages.clear();
  inbox.uidValidity = validity;
  inbox.nextUid = 101;
  fakeServer.add("INBOX", { uid: 101, subject: "A different message" });
}

function seedAttention(rows: Array<{ id: string; sourceId: string; status: string }>) {
  db.tables.attentionItem = rows.map((r) => ({
    userId: USER,
    source: "EMAIL",
    resolvedAt: null,
    ...r,
  }));
}
const attention = (id: string) => (db.tables.attentionItem ?? []).find((r) => r.id === id) as Row;

/** Ingest two rows, give them OPEN and SNOOZED items, see 1001 twice: the repair runs. */
async function confirmedReset() {
  const ingested = await ingest(2);
  const seeded = ingested.map((id) => rowByGmailId(id) as Row);
  seedAttention([
    { id: "open", sourceId: seeded[0].id as string, status: "OPEN" },
    { id: "snoozed", sourceId: seeded[1].id as string, status: "SNOOZED" },
  ]);
  fakeServer.renumber("INBOX", 1001n);
  await nextPoll();
  const sightedAt = Date.now();
  await nextPoll();
  return { ingested, seeded, sightedAt, repairedAt: Date.now() };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  fakeServer.reset();
  arm();
  resetImapSessionState();
  resetPollGuardState();
  resetPollFailureState();
  vi.mocked(resolveHostAddresses).mockClear();
  process.env.GENERIC_IMAP_ENABLED = "true";
  process.env.IMAP_MOVE_ACTIONS_ENABLED = "true";
  delete process.env.IMAP_ACTIONS_ENABLED;
  delete process.env.ICLOUD_INBOX_ENABLED;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  stopImapScheduler();
  await flush();
  expect(fakeServer.destructiveCommands).toEqual([]);
  expect(fakeServer.openLocks).toBe(0);
  for (const name of FLAGS) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a held generic mailbox persists nothing and does not look healthy", () => {
  it("a new message that reuses an old UID leaves the old row unchanged and creates nothing", async () => {
    await ingest(1);
    const before = structuredClone(emails());
    const writesBefore = emailWrites();
    rebuildWithReusedUid(1001n);

    const sighting = await nextPoll();
    const waiting = await poll();

    expect(sighting).toEqual(HELD);
    expect(waiting).toEqual(HELD);
    expect(emails()).toEqual(before);
    expect(emailWrites()).toBe(writesBefore);
  });

  it("does not stamp lastSyncedAt while held; the first ingesting poll after the repair does", async () => {
    await ingest(1);
    const synced = lastSyncedAt();
    expect(synced).toBe(T0.getTime());
    fakeServer.renumber("INBOX", 1001n);

    await nextPoll(); // sighting
    await nextPoll(); // repair
    expect(lastSyncedAt()).toBe(synced);

    await nextPoll(); // ingests under 1001
    expect(lastSyncedAt()).toBe(Date.now());
  });

  it("does not run the moved-row cleanup while held", async () => {
    await ingest(1);
    fakeServer.renumber("INBOX", 1001n);
    db.reads.length = 0;

    await nextPoll();

    expect(db.reads).not.toContain("imapMovedMessage");
  });

  it("the pinned connection is still used for every poll, held or not", async () => {
    await ingest(1);
    fakeServer.renumber("INBOX", 1001n);
    await nextPoll();
    await nextPoll();
    expect(vi.mocked(resolveHostAddresses)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(resolveHostAddresses)).toHaveBeenCalledWith("imap.example.com");
  });
});

describe("a confirmed reset of a generic mailbox: one repair, nothing deleted", () => {
  it("re-keys the rows with #uv<old>.<repair ms> under generic-imap:, keeps every row and its id", async () => {
    const { ingested, seeded, repairedAt } = await confirmedReset();

    for (const [i, id] of ingested.entries()) {
      expect(id.startsWith("generic-imap:me@example.com:")).toBe(true);
      expect(rowByGmailId(tomb(id, "1000", repairedAt))?.id).toBe(seeded[i].id);
      expect(rowByGmailId(id)).toBeUndefined();
    }
    expect(emails()).toHaveLength(2);
    expect(rekeys()).toHaveLength(1);
    expect(deletes("emailMessage")).toEqual([]);
    expect(deletes("attentionItem")).toEqual([]);
  });

  it("replaces the stored value, clears the pending one, and dates the reset from the first sighting", async () => {
    const { sightedAt, repairedAt } = await confirmedReset();

    expect(account().inboxUidValidity).toBe("1001");
    expect(account().inboxUidValidityPending).toBeNull();
    expect((account().inboxUidValidityResetAt as Date).getTime()).toBe(sightedAt);
    expect(sightedAt).toBeLessThan(repairedAt);
  });

  it("resolves the OPEN and SNOOZED items of the generic mailbox's rows, and only those", async () => {
    const ingested = await ingest(2);
    const [a, b] = ingested.map((id) => rowByGmailId(id) as Row);
    db.tables.emailMessage = [
      ...emails(),
      { ...localRowFor(NAVER, 101), id: "naver-row" },
      { id: "gmail-row", userId: USER, gmailId: "18abc", from: "a", to: "b", subject: "s" },
    ];
    seedAttention([
      { id: "open", sourceId: a.id as string, status: "OPEN" },
      { id: "snoozed", sourceId: b.id as string, status: "SNOOZED" },
      { id: "naver", sourceId: "naver-row", status: "OPEN" },
      { id: "gmail", sourceId: "gmail-row", status: "OPEN" },
    ]);
    fakeServer.renumber("INBOX", 1001n);

    await nextPoll();
    await nextPoll();

    expect(attention("open")).toMatchObject({ status: "RESOLVED" });
    expect(attention("snoozed")).toMatchObject({ status: "RESOLVED" });
    expect(attention("naver").status).toBe("OPEN");
    expect(attention("gmail").status).toBe("OPEN");
  });

  it("touches only this account's rows: a Naver row with the same UID and a Gmail row stay", async () => {
    await ingest(1);
    const naverId = idOf(NAVER, 101);
    db.tables.emailMessage = [
      ...emails(),
      { ...localRowFor(NAVER, 101), id: "naver-row" },
      { id: "gmail-row", userId: USER, gmailId: "18abc", from: "a", to: "b", subject: "s" },
    ];
    fakeServer.renumber("INBOX", 1001n);

    await nextPoll();
    await nextPoll();

    expect(gmailIds()).toContain(naverId);
    expect(gmailIds()).toContain("18abc");
    expect(gmailIds().filter((g) => g.includes("#uv"))).toHaveLength(1);
  });

  it("persists nothing in the repair poll; the next poll ingests the window under the new numbering", async () => {
    const [old] = await ingest(1);
    const oldRow = rowByGmailId(old) as Row;
    rebuildWithReusedUid(1001n);
    await nextPoll();
    const createsBefore = creates();

    const repair = await nextPoll();
    const repairedAt = Date.now();
    expect(repair).toEqual(HELD);
    expect(creates()).toBe(createsBefore);

    const next = await nextPoll();

    expect(next).toMatchObject({ fetched: 1, inserted: 1, errors: 0 });
    const fresh = rowByGmailId(old) as Row;
    expect(fresh).toMatchObject({ subject: "A different message" });
    expect(fresh.id).not.toBe(oldRow.id);
    expect(rowByGmailId(tomb(old, "1000", repairedAt))).toMatchObject({
      id: oldRow.id,
      subject: "Mail 101",
    });
  });

  it("does not repair twice: later polls under the new value change no more ids", async () => {
    await confirmedReset();
    const rekeysBefore = rekeys().length;
    const tombstones = gmailIds().filter((g) => g.includes("#uv"));

    await nextPoll();
    await nextPoll();

    expect(rekeys()).toHaveLength(rekeysBefore);
    expect(gmailIds().filter((g) => g.includes("#uv"))).toEqual(tombstones);
  });
});

describe("re-ingested history of a generic mailbox", () => {
  it("marks the re-ingested window and the tombstones as history, not mail received during the hold", async () => {
    await ingest(2);
    fakeServer.renumber("INBOX", 1001n); // uids 1 and 2, received 2026-08-01
    await nextPoll();
    const sightedAt = Date.now();
    // Arrives during the hold: received after the first sighting.
    fakeServer.add("INBOX", { uid: 3, subject: "During the hold", date: new Date(sightedAt + 1) });
    await nextPoll(); // repair
    await nextPoll(); // ingests uids 1, 2, 3 under 1001

    const history = await findReingestedHistory(USER, emails() as never);
    const label = (r: Row) => (history.has(r.id as string) ? "history" : "live");

    expect(Object.fromEntries(emails().map((r) => [r.subject, label(r)]))).toEqual({
      "Mail 101": "history",
      "Mail 102": "history",
      "During the hold": "live",
    });
    expect(emails().filter((r) => label(r) === "history")).toHaveLength(4); // 2 re-ingested + 2 tombstones
    expect(gmailIds().filter((g) => g.startsWith("generic-imap:"))).toHaveLength(5);
  });
});

describe("actions on a repaired generic mailbox", () => {
  it("refuse a tombstoned id without a command, and act on a row of the new numbering", async () => {
    process.env.IMAP_ACTIONS_ENABLED = "true";
    const { ingested, repairedAt } = await confirmedReset();
    await nextPoll(); // ingests the renumbered window
    fakeServer.commands = [];
    const stale = tomb(ingested[0], "1000", repairedAt);

    const results = await Promise.all([
      actions().trash(USER, stale, GENERIC.rowId),
      actions().archive(USER, stale, GENERIC.rowId),
      actions().markAsRead(USER, stale, GENERIC.rowId),
      actions().toggleStar(USER, stale, true, GENERIC.rowId),
    ]);
    const resynced = await syncImapMessageForUser(USER, IMAP_PROVIDERS.IMAP, GENERIC.rowId, stale);

    for (const result of results) expect(result).toMatchObject({ error: expect.any(String) });
    expect(resynced).toBeNull();
    expect(
      fakeServer.commands.filter((c) => /MOVE|STORE|FETCH/.test(c) && c.includes("101")),
    ).toEqual([]);
  });
});

/**
 * fake-db's groupBy only answers `_count` queries; the scheduler's owner lookup has
 * none. This answers it from the table, and can hold the FIRST call open.
 */
async function stubOwnerLookup(firstCall?: Promise<void>): Promise<{ calls: () => number }> {
  const { prisma } = await import("../db.js");
  let calls = 0;
  vi.spyOn(prisma.linkedInboxAccount, "groupBy").mockImplementation((async (args: {
    where?: { provider?: { in?: string[] } };
  }) => {
    calls += 1;
    if (calls === 1 && firstCall) await firstCall;
    const wanted = args.where?.provider?.in ?? [];
    const owners = (db.tables.linkedInboxAccount ?? []).filter((row) =>
      wanted.includes(row.provider as string),
    );
    return [...new Set(owners.map((row) => `${row.userId}|${row.provider}`))].map((key) => {
      const [userId, provider] = key.split("|");
      return { userId, provider };
    });
  }) as never);
  return { calls: () => calls };
}

describe("the scheduler's per-account guard and the hold work together", () => {
  /** A second generic mailbox of the same user, on another host. */
  const GENERIC_B: Mailbox = {
    ...GENERIC,
    rowId: "row-4",
    email: "you@example.org",
    host: "imap.example.org:993",
  };

  it("a stuck account does not block the next tick, and a held generic mailbox is stamped by no tick", async () => {
    arm();
    db.tables.linkedInboxAccount = [accountRow(GENERIC), accountRow(GENERIC_B)];
    await ingest(1); // both accounts ingest and are stamped at T0
    const account = (id: string) =>
      (db.tables.linkedInboxAccount ?? []).find((row) => row.id === id) as Row;
    const stamp = (id: string) => (account(id).lastSyncedAt as Date).getTime();
    const stampedA = stamp(GENERIC.rowId);
    const stampedB = stamp(GENERIC_B.rowId);
    fakeServer.renumber("INBOX", 1001n); // both mailboxes are now under a new UIDVALIDITY
    await stubOwnerLookup();

    // The first tick sticks on account A's connection (its DNS answer never comes).
    let release: () => void = () => {};
    vi.mocked(resolveHostAddresses).mockImplementationOnce(
      () =>
        new Promise<string[]>((resolve) => {
          release = () => resolve(["93.184.216.34"]);
        }),
    );
    advance(POLL_INTERVAL);
    const loginsBefore = fakeServer.logins;
    const first = runImapTick();
    await flush();
    expect(fakeServer.logins).toBe(loginsBefore); // stuck before any login

    // The next tick skips A (still in flight) and polls B: the stuck account blocked nobody.
    advance(POLL_INTERVAL);
    await runImapTick();
    expect(fakeServer.logins).toBe(loginsBefore + 1); // B only
    expect(stamp(GENERIC_B.rowId)).toBe(stampedB); // held (a sighting): not a sync
    expect(account(GENERIC_B.rowId).inboxUidValidityPending).toBe("1001");
    expect(account(GENERIC.rowId).inboxUidValidityPending ?? null).toBeNull(); // A not reached yet

    release();
    await first;
    expect(stamp(GENERIC.rowId)).toBe(stampedA); // A's poll is held as well: no stamp
    expect(account(GENERIC.rowId).inboxUidValidityPending).toBe("1001");

    // Another tick: second sightings repair both; still held, still not stamped.
    advance(POLL_INTERVAL);
    await runImapTick();
    expect(stamp(GENERIC.rowId)).toBe(stampedA);
    expect(stamp(GENERIC_B.rowId)).toBe(stampedB);
    expect(account(GENERIC.rowId).inboxUidValidity).toBe("1001"); // the repair did run

    // Ingesting under the new value is a sync again.
    advance(POLL_INTERVAL);
    await runImapTick();
    expect(stamp(GENERIC.rowId)).toBe(Date.now());
    expect(stamp(GENERIC_B.rowId)).toBe(Date.now());
  });

  it("with GENERIC_IMAP_ENABLED off the tick never selects the generic mailbox", async () => {
    await ingest(1);
    const synced = lastSyncedAt();
    delete process.env.GENERIC_IMAP_ENABLED;
    const loginsBefore = fakeServer.logins;
    await stubOwnerLookup();

    advance(POLL_INTERVAL);
    await runImapTick();

    expect(fakeServer.logins).toBe(loginsBefore);
    expect(lastSyncedAt()).toBe(synced);
  });
});
