/**
 * Step B2b of docs/providers/unified-platform-plan.md: a UIDVALIDITY reset is
 * repaired without deleting anything.
 *
 * The poll runs for real (syncImapAccountsForUser -> syncImapInbox -> the shared
 * persist path) against the stateful fake server and the strict in-memory database.
 * Only the network edge and the judge are stubbed. What is pinned here:
 *   - while a mailbox is held (stored value differs from the live one, or a reset is
 *     pending) the poll persists NOTHING for it;
 *   - one sighting of a new value is only remembered;
 *   - the same value on a later poll, at least MIN_SIGHTING_GAP_MS after the first,
 *     acts once: in ONE transaction the account's value is replaced, the OPEN and
 *     SNOOZED attention items of the mailbox's rows are resolved and the rows are
 *     re-keyed (`#uv<old>`); nothing is deleted. The NEXT poll ingests the window
 *     under the new numbering;
 *   - overlapping polls, a moved state, a flapping server and the 24 h limit cannot
 *     make it act twice or act on a stale decision; a failing transaction changes
 *     nothing.
 *
 * The clock is faked (Date only) so that "a later poll" is a matter of one call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "./helpers/fake-db.js";
import { fakeServer } from "./helpers/fake-imap-server.js";
import { accountRow, ICLOUD, idOf, localRowFor, NAVER, USER } from "./helpers/imap-move-harness.js";

let db: FakeDb;
let rawFailure: Error | null = null;
/** Runs once, right before the repair's claim is matched: a concurrent writer. */
let beforeClaim: ((account: Row) => void) | null = null;

vi.mock("imapflow", async () => ({
  ImapFlow: (await import("./helpers/fake-imap-server.js")).FakeImapFlow,
}));
vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(
    () => db,
    { rollbackOnError: true },
    {
      beforeExecuteRaw: () => {
        if (rawFailure) throw rawFailure;
      },
    },
  );
  return { prisma, db: prisma };
});
vi.mock("../crypto-tokens.js", () => ({ decryptToken: () => "app-pw" }));

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

const { captureError } = await import("../sentry.js");
const { resetPollGuardState } = await import("../mail/imap-poll-guards.js");
const { MIN_SIGHTING_GAP_MS, RESET_LIMIT_WINDOW_MS, nextResetStep } = await import(
  "../mail/imap-uidvalidity-reset.js"
);
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

const T0 = new Date("2026-09-30T10:00:00Z");
const MINUTE = 60_000;
const POLL_INTERVAL = 5 * MINUTE;

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const advance = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));
const poll = () => syncImapAccountsForUser(USER, IMAP_PROVIDERS.NAVER);
/** The next scheduler tick: five minutes later, then a poll. */
const nextPoll = async () => {
  advance(POLL_INTERVAL);
  return poll();
};
const actions = () => mailActionsForProvider("NAVER");

const emails = (): Row[] => db.tables.emailMessage ?? [];
const account = (): Row =>
  (db.tables.linkedInboxAccount ?? []).find((row) => row.id === NAVER.rowId) as Row;
const rowByGmailId = (gmailId: string) => emails().find((r) => r.gmailId === gmailId);
const gmailIds = () => emails().map((r) => r.gmailId as string);
const rekeys = () => db.writes.$executeRaw ?? [];
const emailWrites = () => (db.writes.emailMessage ?? []).length;
const creates = () => (db.writes.emailMessage ?? []).filter((w) => w.op === "create").length;
const deletes = (model: string) => (db.writes[model] ?? []).filter((w) => w.op === "deleteMany");
/** Every attempt at the repair's claim, won or lost. */
const claims = () =>
  (db.writes.linkedInboxAccount ?? []).filter(
    (w) => w.op === "updateMany" && w.where && "inboxUidValidityPending" in w.where,
  );
const warned = (fragment: string) =>
  (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(([line]) =>
    String(line).includes(fragment),
  );

function arm(stored: string | null = "1000") {
  db = createFakeDb(
    {
      linkedInboxAccount: [accountRow(NAVER, stored), accountRow(ICLOUD)],
      emailMessage: [],
      imapMovedMessage: [],
      attentionItem: [],
    },
    {
      beforeUpdateMany: (model, where) => {
        if (model !== "linkedInboxAccount" || !where || !("inboxUidValidityPending" in where)) {
          return;
        }
        const hook = beforeClaim;
        beforeClaim = null;
        hook?.(account());
      },
    },
  );
}

/** Put messages in INBOX with UIDs 101.. and let the REAL poll ingest them. */
async function ingest(count: number): Promise<string[]> {
  const uids = Array.from({ length: count }, (_, i) => 101 + i);
  for (const uid of uids) fakeServer.add("INBOX", { uid, subject: `Mail ${uid}` });
  await poll();
  return uids.map((uid) => idOf(NAVER, uid));
}

/** The server rebuilds INBOX: a new UIDVALIDITY, UID 101 now names a different message. */
function rebuildWithReusedUid(validity: bigint) {
  const inbox = fakeServer.folder("INBOX");
  inbox.messages.clear();
  inbox.uidValidity = validity;
  inbox.nextUid = 101;
  fakeServer.add("INBOX", {
    uid: 101,
    subject: "A different message",
    flags: new Set(["\\Seen", "\\Flagged"]),
  });
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
  await nextPoll();
  return { ingested, seeded };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  fakeServer.reset();
  arm();
  rawFailure = null;
  beforeClaim = null;
  resetImapSessionState();
  resetPollGuardState();
  vi.mocked(captureError).mockClear();
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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the named limits", () => {
  it("are one minute between sightings and one repair per account per 24 hours", () => {
    expect(MIN_SIGHTING_GAP_MS).toBe(60_000);
    expect(RESET_LIMIT_WINDOW_MS).toBe(24 * 60 * 60_000);
  });

  const at = (ms: number) => new Date(T0.getTime() + ms);
  const state = (over: Record<string, unknown> = {}) => ({
    stored: "1000",
    pending: "1001",
    pendingAt: T0,
    resetAt: null,
    ...over,
  });

  it.each([
    [
      "the first value ever",
      state({ stored: null, pending: null, pendingAt: null }),
      "1000",
      0,
      "baseline",
    ],
    ["an unchanged value", state({ pending: null, pendingAt: null }), "1000", 0, "none"],
    ["a return to the stored value", state(), "1000", 0, "clear-pending"],
    ["a first sighting", state({ pending: null, pendingAt: null }), "1001", 0, "note-pending"],
    ["a third value", state(), "1002", MINUTE, "note-pending"],
    ["a second sighting just inside the gap", state(), "1001", MIN_SIGHTING_GAP_MS - 1, "wait"],
    ["a second sighting at the gap", state(), "1001", MIN_SIGHTING_GAP_MS, "repair"],
    ["no usable value with a reset pending", state(), null, MINUTE, "wait"],
    [
      "no usable value and nothing pending",
      state({ pending: null, pendingAt: null }),
      null,
      0,
      "none",
    ],
    [
      "a repair 24 h ago to the millisecond",
      state({ resetAt: at(-RESET_LIMIT_WINDOW_MS + MINUTE) }),
      "1001",
      MINUTE,
      "limited",
    ],
    [
      "a repair longer than 24 h ago",
      state({ resetAt: at(-RESET_LIMIT_WINDOW_MS) }),
      "1001",
      MINUTE,
      "repair",
    ],
  ])("%s", (_name, s, live, elapsed, step) => {
    expect(nextResetStep(s, live, at(elapsed))).toBe(step);
  });
});

describe("a held mailbox persists nothing", () => {
  it("a new message that reuses an old UID leaves the old row byte-for-byte unchanged and creates nothing", async () => {
    await ingest(1);
    const before = structuredClone(emails());
    const writesBefore = emailWrites();
    rebuildWithReusedUid(1001n);

    const sighting = await nextPoll();
    const waiting = await poll();

    expect(sighting).toEqual({ fetched: 0, inserted: 0, classified: 0, errors: 0 });
    expect(waiting).toEqual({ fetched: 0, inserted: 0, classified: 0, errors: 0 });
    expect(emails()).toEqual(before);
    expect(emailWrites()).toBe(writesBefore);
  });

  it("holds while a reset is pending even when the server reports no usable value", async () => {
    await ingest(1);
    rebuildWithReusedUid(1001n);
    await nextPoll();
    const writesBefore = emailWrites();
    fakeServer.folder("INBOX").uidValidity = 0n; // RFC 3501: non-zero, i.e. nothing usable

    await nextPoll();

    expect(emailWrites()).toBe(writesBefore);
    expect(account().inboxUidValidityPending).toBe("1001");
  });

  it("does not run the moved-row cleanup while held", async () => {
    await ingest(1);
    fakeServer.renumber("INBOX", 1001n);
    db.reads.length = 0;

    await nextPoll();

    expect(db.reads).not.toContain("imapMovedMessage");
  });
});

describe("a reset seen on ONE poll is remembered and nothing else changes", () => {
  it("stores the pending value and its time; rows, items and the stored value stay", async () => {
    const [first] = await ingest(2);
    seedAttention([{ id: "open", sourceId: rowByGmailId(first)?.id as string, status: "OPEN" }]);
    const before = structuredClone(emails());
    fakeServer.renumber("INBOX", 1001n);

    await nextPoll();

    expect(account().inboxUidValidity).toBe("1000");
    expect(account().inboxUidValidityPending).toBe("1001");
    expect((account().inboxUidValidityPendingAt as Date).getTime()).toBe(Date.now());
    expect(account().inboxUidValidityResetAt).toBeNull();
    expect(emails()).toEqual(before);
    expect(rekeys()).toEqual([]);
    expect(claims()).toEqual([]);
    expect(attention("open").status).toBe("OPEN");
  });

  it("reports the sighting once (one log line, one Sentry event), however many polls follow", async () => {
    await ingest(1);
    fakeServer.renumber("INBOX", 1001n);

    await nextPoll();
    await poll();
    await poll();

    expect(captureError).toHaveBeenCalledTimes(1);
    const [, context] = (captureError as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [unknown, { tags: Record<string, string> }];
    expect(context.tags.scope).toBe("naver-imap.uidvalidity-reset");
    expect(warned("UIDVALIDITY changed")).toHaveLength(1);
  });

  it("does not take a poll inside the minimum gap as the second sighting; the first one at the gap is", async () => {
    await ingest(1);
    fakeServer.renumber("INBOX", 1001n);
    await nextPoll();

    advance(MIN_SIGHTING_GAP_MS - 1);
    await poll();
    expect(rekeys()).toEqual([]);
    expect(claims()).toEqual([]);
    expect(account().inboxUidValidity).toBe("1000");

    advance(1);
    await poll();
    expect(rekeys()).toHaveLength(1);
    expect(account().inboxUidValidity).toBe("1001");
  });
});

describe("the same value on a later poll is a reset: one repair transaction", () => {
  it("re-keys the mailbox's rows with #uv<old>, keeps every row and its id, deletes nothing", async () => {
    const { ingested, seeded } = await confirmedReset();

    for (const [i, id] of ingested.entries()) {
      expect(rowByGmailId(`${id}#uv1000`)?.id).toBe(seeded[i].id);
      expect(rowByGmailId(id)).toBeUndefined();
    }
    expect(emails()).toHaveLength(2);
    expect(rekeys()).toHaveLength(1);
    expect(deletes("emailMessage")).toEqual([]);
    expect(deletes("attentionItem")).toEqual([]);
  });

  it("replaces the stored value, clears the pending one and stamps the time, in the same step", async () => {
    await confirmedReset();

    expect(account().inboxUidValidity).toBe("1001");
    expect(account().inboxUidValidityPending).toBeNull();
    expect(account().inboxUidValidityPendingAt).toBeNull();
    expect((account().inboxUidValidityResetAt as Date).getTime()).toBe(Date.now());
  });

  it("resolves the OPEN and SNOOZED items of the mailbox's rows, and only those", async () => {
    const ingested = await ingest(2);
    const [a, b] = ingested.map((id) => rowByGmailId(id) as Row);
    db.tables.emailMessage = [
      ...emails(),
      { ...localRowFor(ICLOUD, 101), id: "icloud-row" },
      { id: "gmail-row", userId: USER, gmailId: "18abc", from: "a", to: "b", subject: "s" },
    ];
    const dismissedAt = new Date("2026-09-01T00:00:00Z");
    seedAttention([
      { id: "open", sourceId: a.id as string, status: "OPEN" },
      { id: "snoozed", sourceId: b.id as string, status: "SNOOZED" },
      { id: "icloud", sourceId: "icloud-row", status: "OPEN" },
      { id: "gmail", sourceId: "gmail-row", status: "OPEN" },
    ]);
    db.tables.attentionItem = [
      ...(db.tables.attentionItem ?? []),
      {
        id: "dismissed",
        userId: USER,
        source: "EMAIL",
        sourceId: a.id,
        status: "DISMISSED",
        resolvedAt: dismissedAt,
      },
      { id: "task", userId: USER, source: "TASK", sourceId: a.id, status: "OPEN" },
    ];
    fakeServer.renumber("INBOX", 1001n);

    await nextPoll();
    await nextPoll();

    expect(attention("open")).toMatchObject({ status: "RESOLVED" });
    expect((attention("open").resolvedAt as Date).getTime()).toBe(Date.now());
    expect(attention("snoozed")).toMatchObject({ status: "RESOLVED" });
    expect(attention("dismissed")).toMatchObject({ status: "DISMISSED", resolvedAt: dismissedAt });
    expect(attention("icloud").status).toBe("OPEN");
    expect(attention("gmail").status).toBe("OPEN");
    expect(attention("task").status).toBe("OPEN");
  });

  it("keeps what the user did on a row: summary, key points, reply state, star, attachments, intake, commitments", async () => {
    const ingested = await ingest(1);
    const row = rowByGmailId(ingested[0]) as Row;
    Object.assign(row, {
      summary: "Quarterly numbers",
      keyPoints: ["a", "b"],
      repliedAt: new Date("2026-09-29T09:00:00Z"),
      isStarred: true,
    });
    db.tables.emailAttachment = [{ id: "att", userId: USER, emailId: row.id, filename: "q.pdf" }];
    db.tables.candidateIntake = [{ id: "ci", userId: USER, emailId: row.id }];
    db.tables.commitment = [
      { id: "cm", userId: USER, sourceType: "EMAIL", sourceId: row.id, status: "OPEN" },
    ];
    fakeServer.renumber("INBOX", 1001n);

    await nextPoll();
    await nextPoll();

    const kept = rowByGmailId(`${ingested[0]}#uv1000`) as Row;
    expect(kept).toMatchObject({
      id: row.id,
      summary: "Quarterly numbers",
      keyPoints: ["a", "b"],
      isStarred: true,
    });
    expect(kept.repliedAt).toEqual(new Date("2026-09-29T09:00:00Z"));
    expect(db.tables.emailAttachment).toEqual([
      expect.objectContaining({ id: "att", emailId: row.id }),
    ]);
    expect(db.tables.candidateIntake).toEqual([
      expect.objectContaining({ id: "ci", emailId: row.id }),
    ]);
    expect(db.tables.commitment?.[0]).toMatchObject({ status: "OPEN", sourceId: row.id });
  });

  it("touches only this account's rows: another provider's, a Gmail row and another user's row stay", async () => {
    await ingest(1);
    db.tables.emailMessage = [
      ...emails(),
      { ...localRowFor(ICLOUD, 101), id: "icloud-row" },
      { id: "gmail-row", userId: USER, gmailId: "18abc", from: "a", to: "b", subject: "s" },
      { ...localRowFor(NAVER, 7), id: "other-user", userId: "someone-else" },
    ];
    fakeServer.renumber("INBOX", 1001n);

    await nextPoll();
    await nextPoll();

    expect(rowByGmailId(idOf(ICLOUD, 101))?.id).toBe("icloud-row");
    expect(rowByGmailId("18abc")?.id).toBe("gmail-row");
    expect(emails().find((r) => r.id === "other-user")?.gmailId).toBe(idOf(NAVER, 7));
  });

  it("persists nothing in the repair poll; the next poll ingests the window under the new numbering", async () => {
    const [old] = await ingest(1);
    const oldRow = rowByGmailId(old) as Row;
    rebuildWithReusedUid(1001n);
    await nextPoll();
    const createsBefore = creates();

    const repair = await nextPoll();
    expect(repair).toEqual({ fetched: 0, inserted: 0, classified: 0, errors: 0 });
    expect(creates()).toBe(createsBefore);

    const next = await nextPoll();

    expect(next).toMatchObject({ fetched: 1, inserted: 1, errors: 0 });
    const fresh = rowByGmailId(old) as Row;
    expect(fresh).toMatchObject({ subject: "A different message", isRead: true, isStarred: true });
    expect(fresh.id).not.toBe(oldRow.id);
    // The accepted limit: the tombstone stays visible next to the new row.
    expect(rowByGmailId(`${old}#uv1000`)).toMatchObject({ id: oldRow.id, subject: "Mail 101" });
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

  it("refuses actions on a tombstoned id without a command, and acts on a row of the new numbering", async () => {
    process.env.IMAP_ACTIONS_ENABLED = "true"; // the flag actions (read, star)
    const { ingested } = await confirmedReset();
    await nextPoll(); // ingests the renumbered window: uids 1 and 2
    fakeServer.commands = [];
    const stale = `${ingested[0]}#uv1000`;

    const results = await Promise.all([
      actions().trash(USER, stale, NAVER.rowId),
      actions().archive(USER, stale, NAVER.rowId),
      actions().markAsRead(USER, stale, NAVER.rowId),
      actions().toggleStar(USER, stale, true, NAVER.rowId),
    ]);
    const resynced = await syncImapMessageForUser(USER, IMAP_PROVIDERS.NAVER, NAVER.rowId, stale);
    const fresh = await actions().markAsRead(USER, idOf(NAVER, 1), NAVER.rowId);

    for (const result of results) expect(result).toMatchObject({ error: expect.any(String) });
    expect(resynced).toBeNull();
    expect(
      fakeServer.commands.filter((c) => /MOVE|STORE|FETCH/.test(c) && c.includes("101")),
    ).toEqual([]);
    expect(fresh).not.toMatchObject({ error: expect.any(String) });
  });
});

describe("overlapping polls cannot both act", () => {
  it("two polls that both decided to repair: two claims, one wins, one re-key", async () => {
    await ingest(2);
    fakeServer.renumber("INBOX", 1001n);
    await nextPoll();
    advance(POLL_INTERVAL);

    await Promise.all([poll(), poll()]);

    expect(claims()).toHaveLength(2);
    expect(rekeys()).toHaveLength(1);
    expect(gmailIds().sort()).toEqual([`${idOf(NAVER, 101)}#uv1000`, `${idOf(NAVER, 102)}#uv1000`]);
    expect(account().inboxUidValidity).toBe("1001");
  });

  it("two polls that both see the new value for the first time count as ONE sighting", async () => {
    await ingest(1);
    fakeServer.renumber("INBOX", 1001n);
    advance(POLL_INTERVAL);

    await Promise.all([poll(), poll()]);

    expect(claims()).toEqual([]);
    expect(rekeys()).toEqual([]);
    expect(account().inboxUidValidity).toBe("1000");
    expect(account().inboxUidValidityPending).toBe("1001");
  });
});

describe("the claim is conditional on the state the repair was decided in", () => {
  it.each([
    ["another repair replaced the stored value", { inboxUidValidity: "999" }],
    ["another poll saw a third value", { inboxUidValidityPending: "1002" }],
    [
      "another poll re-sighted the value after a flap (same value, new time)",
      { inboxUidValidityPendingAt: new Date("2026-09-30T10:09:00Z") },
    ],
    [
      "another repair was applied within 24 h",
      { inboxUidValidityResetAt: new Date("2026-09-30T10:09:00Z") },
    ],
  ])("does nothing when %s", async (_name, moved) => {
    const { seeded } = await (async () => {
      const ingested = await ingest(1);
      const rows = ingested.map((id) => rowByGmailId(id) as Row);
      seedAttention([{ id: "open", sourceId: rows[0].id as string, status: "OPEN" }]);
      return { seeded: rows };
    })();
    fakeServer.renumber("INBOX", 1001n);
    await nextPoll();
    beforeClaim = (row) => Object.assign(row, moved);

    await nextPoll();

    expect(claims()).toHaveLength(1);
    expect(rekeys()).toEqual([]);
    expect(rowByGmailId(idOf(NAVER, 101))?.id).toBe(seeded[0].id);
    expect(attention("open").status).toBe("OPEN");
    expect(account()).toMatchObject(moved);
  });
});

describe("a flapping or rate-limited server cannot churn the mailbox", () => {
  it("a return to the stored value cancels the pending reset, and ingest resumes", async () => {
    await ingest(1);
    fakeServer.folder("INBOX").uidValidity = 1001n;
    await nextPoll();
    expect(account().inboxUidValidityPending).toBe("1001");

    fakeServer.folder("INBOX").uidValidity = 1000n;
    fakeServer.add("INBOX", { uid: 102, subject: "After the flap" });
    const back = await nextPoll();
    expect(account().inboxUidValidityPending).toBeNull();
    expect(account().inboxUidValidityPendingAt).toBeNull();
    expect(back).toMatchObject({ inserted: 1 });

    fakeServer.folder("INBOX").uidValidity = 1001n;
    await nextPoll();

    expect(claims()).toEqual([]);
    expect(rekeys()).toEqual([]);
    expect(account().inboxUidValidity).toBe("1000");
    expect(account().inboxUidValidityPending).toBe("1001");
  });

  it("a third value replaces the pending one and needs its own second sighting", async () => {
    await ingest(1);
    fakeServer.folder("INBOX").uidValidity = 1001n;
    await nextPoll();
    const firstAt = (account().inboxUidValidityPendingAt as Date).getTime();

    fakeServer.folder("INBOX").uidValidity = 1002n;
    await nextPoll();
    expect(rekeys()).toEqual([]);
    expect(account().inboxUidValidityPending).toBe("1002");
    expect((account().inboxUidValidityPendingAt as Date).getTime()).toBe(firstAt + POLL_INTERVAL);

    await nextPoll();

    expect(rekeys()).toHaveLength(1);
    expect(account().inboxUidValidity).toBe("1002");
    expect(gmailIds()).toEqual([`${idOf(NAVER, 101)}#uv1000`]);
  });

  it("a poll with no usable value neither confirms, cancels nor restarts the pending reset", async () => {
    await ingest(1);
    fakeServer.folder("INBOX").uidValidity = 1001n;
    await nextPoll();
    const pendingAt = account().inboxUidValidityPendingAt;

    fakeServer.folder("INBOX").uidValidity = 0n;
    await nextPoll();
    expect(rekeys()).toEqual([]);
    expect(account().inboxUidValidityPending).toBe("1001");
    expect(account().inboxUidValidityPendingAt).toEqual(pendingAt);

    fakeServer.folder("INBOX").uidValidity = 1001n;
    await nextPoll();
    expect(rekeys()).toHaveLength(1);
  });

  it("applies at most one repair per account per 24 hours; inside that window it holds and logs once", async () => {
    await ingest(1);
    fakeServer.renumber("INBOX", 1001n); // uid 101 becomes uid 1
    await nextPoll();
    await nextPoll();
    expect(rekeys()).toHaveLength(1);
    const resetAt = (account().inboxUidValidityResetAt as Date).getTime();
    fakeServer.add("INBOX", { uid: 2, subject: "Under 1001" });
    await nextPoll(); // ingests uids 1 and 2 under 1001

    fakeServer.folder("INBOX").uidValidity = 1002n;
    await nextPoll();
    const writesBefore = emailWrites();
    await nextPoll();
    await nextPoll();

    expect(claims()).toHaveLength(1);
    expect(rekeys()).toHaveLength(1);
    expect(emailWrites()).toBe(writesBefore);
    expect(account().inboxUidValidity).toBe("1001");
    expect(account().inboxUidValidityPending).toBe("1002");
    expect(warned("at most one repair")).toHaveLength(1);

    vi.setSystemTime(new Date(resetAt + RESET_LIMIT_WINDOW_MS));
    await poll();
    expect(rekeys()).toHaveLength(1);

    vi.setSystemTime(new Date(resetAt + RESET_LIMIT_WINDOW_MS + 1));
    await poll();

    expect(rekeys()).toHaveLength(2);
    expect(account().inboxUidValidity).toBe("1002");
    // The first repair's tombstones are not re-suffixed; the 1001 rows get #uv1001.
    expect(gmailIds().sort()).toEqual(
      [`${idOf(NAVER, 101)}#uv1000`, `${idOf(NAVER, 1)}#uv1001`, `${idOf(NAVER, 2)}#uv1001`].sort(),
    );
  });
});

describe("a failing transaction", () => {
  it("rolls back every step, keeps the mailbox held, reports once, and the next poll retries", async () => {
    await ingest(2);
    const [row] = emails();
    seedAttention([{ id: "open", sourceId: row.id as string, status: "OPEN" }]);
    const idsBefore = gmailIds();
    fakeServer.renumber("INBOX", 1001n);
    await nextPoll();
    vi.mocked(captureError).mockClear();
    rawFailure = new Error("connection reset");

    const result = await nextPoll();
    const writesBefore = emailWrites();
    await nextPoll();

    expect(result).toEqual({ fetched: 0, inserted: 0, classified: 0, errors: 0 });
    expect(claims()).toHaveLength(2);
    expect(account().inboxUidValidity).toBe("1000");
    expect(account().inboxUidValidityPending).toBe("1001");
    expect(account().inboxUidValidityResetAt).toBeNull();
    expect(attention("open")).toMatchObject({ status: "OPEN", resolvedAt: null });
    expect(gmailIds()).toEqual(idsBefore);
    expect(emailWrites()).toBe(writesBefore);
    expect(captureError).toHaveBeenCalledTimes(1);
    expect(warned("repair failed")).toHaveLength(1);

    rawFailure = null;
    await nextPoll();

    expect(account().inboxUidValidity).toBe("1001");
    expect(attention("open").status).toBe("RESOLVED");
  });

  it("rolls back on a unique collision with an existing tombstone", async () => {
    const [old] = await ingest(1);
    db.tables.emailMessage = [
      ...emails(),
      { ...localRowFor(NAVER, 101), id: "older-tombstone", gmailId: `${old}#uv1000` },
    ];
    seedAttention([{ id: "open", sourceId: rowByGmailId(old)?.id as string, status: "OPEN" }]);
    fakeServer.renumber("INBOX", 1001n);

    await nextPoll();
    await nextPoll();

    expect(rowByGmailId(old)).toBeDefined();
    expect(account()).toMatchObject({ inboxUidValidity: "1000", inboxUidValidityPending: "1001" });
    expect(account().inboxUidValidityResetAt).toBeNull();
    expect(attention("open").status).toBe("OPEN");
    expect(captureError).toHaveBeenCalledTimes(2); // the sighting, then the failed repair
    // The database error quotes the colliding id; neither it nor the address reaches Sentry.
    for (const [err, context] of vi.mocked(captureError).mock.calls) {
      expect(String((err as Error).message)).not.toContain(NAVER.email);
      expect(JSON.stringify(context)).not.toContain(NAVER.email);
    }
  });
});

describe("moves recorded before the repair", () => {
  it("do not delete a new message that reuses the id in the poll after the repair", async () => {
    await ingest(1);
    rebuildWithReusedUid(1001n);
    db.tables.imapMovedMessage = [
      {
        id: "moved",
        userId: USER,
        linkedInboxAccountId: NAVER.rowId,
        sourceId: idOf(NAVER, 101),
        role: "TRASH",
        folderPath: "Trash",
        folderUid: 1n,
        folderUidValidity: "2000",
        subject: "s",
        createdAt: new Date(),
      },
    ];
    advance(MINUTE);
    await poll(); // first sighting
    advance(MINUTE);
    await poll(); // repair
    advance(MINUTE);
    await poll(); // ingests ...:101 again; the record is three minutes old

    expect(rowByGmailId(idOf(NAVER, 101))).toMatchObject({ subject: "A different message" });
    expect(db.tables.imapMovedMessage).toHaveLength(1); // the undo record is kept
  });
});
