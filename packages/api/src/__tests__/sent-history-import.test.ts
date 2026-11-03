/**
 * Sent-history import (SENT_HISTORY_BACKFILL_ENABLED, docs/design/
 * attention-engine-v3.md §3(2)): the newest 2,000 sent mails of the last 12
 * months per Google inbox, headers only, a bounded batch per scheduler tick,
 * resumed from the rows already in SentMessage, finished once per inbox.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeMessage {
  id: string;
  internalDate: number;
  to: string;
  subject: string;
}

const state = vi.hoisted(() => ({
  mailboxes: {} as Record<string, FakeMessage[]>,
  recorded: new Map<string, Record<string, unknown>>(),
  listCalls: [] as { account: string; params: Record<string, unknown>; options: unknown }[],
  getCalls: [] as { account: string; params: Record<string, unknown>; options: unknown }[],
  getFailures: new Map<string, unknown>(),
  getDelayMs: 0,
  inFlight: 0,
  maxInFlight: 0,
  primaryToken: { sentHistoryImportedAt: null as Date | null } as null | {
    sentHistoryImportedAt: Date | null;
  },
  linked: [] as { id: string; sentHistoryImportedAt: Date | null }[],
  primaryClient: true,
  markerWrites: [] as { table: string; args: unknown }[],
  labels: new Map<string, string>(),
  classifyFails: false,
  classifyCalls: [] as unknown[][],
  captured: [] as unknown[],
}));

vi.mock("googleapis", () => ({
  google: {
    gmail: vi.fn(({ auth }: { auth: { key: string } }) => ({
      users: {
        messages: {
          list: vi.fn(async (params: Record<string, unknown>, options: unknown) => {
            state.listCalls.push({ account: auth.key, params, options });
            const after = Number(/after:(\d+)/.exec(String(params.q))?.[1] ?? 0);
            const all = (state.mailboxes[auth.key] ?? []).filter(
              (m) => m.internalDate / 1000 > after,
            );
            const start = Number(params.pageToken ?? 0);
            const end = start + Number(params.maxResults);
            return {
              data: {
                messages: all.slice(start, end).map((m) => ({ id: m.id, threadId: `t-${m.id}` })),
                nextPageToken: end < all.length ? String(end) : undefined,
              },
            };
          }),
          get: vi.fn(async (params: { id: string } & Record<string, unknown>, options: unknown) => {
            state.getCalls.push({ account: auth.key, params, options });
            state.inFlight += 1;
            state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
            try {
              if (state.getDelayMs) await new Promise((r) => setTimeout(r, state.getDelayMs));
              const failure = state.getFailures.get(params.id);
              if (failure) throw failure;
              const m = (state.mailboxes[auth.key] ?? []).find((x) => x.id === params.id);
              return {
                data: {
                  id: m?.id,
                  threadId: `t-${m?.id}`,
                  internalDate: String(m?.internalDate),
                  payload: {
                    headers: [
                      { name: "To", value: m?.to },
                      { name: "Subject", value: m?.subject },
                    ],
                  },
                },
              };
            } finally {
              state.inFlight -= 1;
            }
          }),
        },
      },
    })),
  },
}));

vi.mock("../mail/gmail.js", () => ({
  getAuthedClient: vi.fn(async () => (state.primaryClient ? { key: "primary" } : null)),
  getAuthedInboxClient: vi.fn(async (_userId: string, id: string) => ({ key: id })),
  isGoogleNotFoundError: (err: unknown) =>
    (err as { response?: { status?: number } }).response?.status === 404,
}));

vi.mock("../db.js", () => ({
  prisma: {
    sentMessage: {
      findMany: vi.fn(async (args: { where: { gmailId: { in: string[] } } }) =>
        args.where.gmailId.in
          .filter((id) => state.recorded.has(id))
          .map((gmailId) => ({ gmailId })),
      ),
    },
    userToken: {
      findFirst: vi.fn(async () => state.primaryToken),
      updateMany: vi.fn(async (args: { data: { sentHistoryImportedAt: Date } }) => {
        state.markerWrites.push({ table: "userToken", args });
        if (state.primaryToken)
          state.primaryToken.sentHistoryImportedAt = args.data.sentHistoryImportedAt;
        return { count: 1 };
      }),
    },
    linkedInboxAccount: {
      findMany: vi.fn(async () => state.linked.filter((l) => l.sentHistoryImportedAt === null)),
      updateMany: vi.fn(
        async (args: { where: { id: string }; data: { sentHistoryImportedAt: Date } }) => {
          state.markerWrites.push({ table: "linkedInboxAccount", args });
          const row = state.linked.find((l) => l.id === args.where.id);
          if (row) row.sentHistoryImportedAt = args.data.sentHistoryImportedAt;
          return { count: 1 };
        },
      ),
    },
  },
}));

vi.mock("../mail/sent-messages.js", () => ({
  recordSentMessage: vi.fn(async (_userId: string, input: { gmailId: string }) => {
    state.recorded.set(input.gmailId, input);
  }),
}));

vi.mock("../mail/sent-origin-classifier.js", () => ({
  classifySentRows: vi.fn(async (_userId: string, rows: unknown[]) => {
    state.classifyCalls.push(rows);
    if (state.classifyFails) throw new Error("db down");
    return state.labels;
  }),
}));

vi.mock("../sentry.js", () => ({
  captureError: vi.fn((err: unknown) => {
    state.captured.push(err);
  }),
}));

import { getAuthedClient } from "../mail/gmail.js";
import {
  importSentHistory,
  resetSentHistoryImportForTests,
  SENT_HISTORY_BATCH,
  SENT_HISTORY_CAP,
} from "../mail/sent-history-import.js";
import { recordSentMessage } from "../mail/sent-messages.js";

const NOW = Date.parse("2026-11-01T00:00:00.000Z");
const DAY = 86_400_000;
const WINDOW_START_SECONDS = Math.floor((NOW - 365 * DAY) / 1000);

/** n messages, newest first, one hour apart, all inside the window. */
function mailbox(n: number, prefix = "m"): FakeMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    internalDate: NOW - (i + 1) * 3_600_000,
    to: `person${i}@x.com`,
    subject: `Subject ${i}`,
  }));
}

const getIds = () => state.getCalls.map((c) => c.params.id);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SENT_HISTORY_BACKFILL_ENABLED = "true";
  state.mailboxes = { primary: mailbox(3) };
  state.recorded = new Map();
  state.listCalls = [];
  state.getCalls = [];
  state.getFailures = new Map();
  state.getDelayMs = 0;
  state.inFlight = 0;
  state.maxInFlight = 0;
  state.primaryToken = { sentHistoryImportedAt: null };
  state.linked = [];
  state.primaryClient = true;
  state.markerWrites = [];
  state.labels = new Map();
  state.classifyFails = false;
  state.classifyCalls = [];
  state.captured = [];
  resetSentHistoryImportForTests();
});

afterEach(() => {
  delete process.env.SENT_HISTORY_BACKFILL_ENABLED;
  delete process.env.ROLLOUT_COHORT_USER_IDS;
});

describe("flag", () => {
  it("off: no Gmail call and no database read", async () => {
    delete process.env.SENT_HISTORY_BACKFILL_ENABLED;
    const { prisma } = await import("../db.js");
    expect(await importSentHistory("u1", NOW)).toBe(0);
    expect(state.listCalls).toEqual([]);
    expect(state.getCalls).toEqual([]);
    expect(getAuthedClient).not.toHaveBeenCalled();
    expect(prisma.userToken.findFirst).not.toHaveBeenCalled();
    expect(prisma.linkedInboxAccount.findMany).not.toHaveBeenCalled();
  });

  it("cohort: runs only for users in ROLLOUT_COHORT_USER_IDS", async () => {
    process.env.SENT_HISTORY_BACKFILL_ENABLED = "cohort";
    process.env.ROLLOUT_COHORT_USER_IDS = "founder";
    expect(await importSentHistory("u1", NOW)).toBe(0);
    expect(state.listCalls).toEqual([]);
    expect(await importSentHistory("founder", NOW)).toBe(3);
  });
});

describe("one batch", () => {
  it("lists 12 months of Sent and fetches only the headers of mail not yet recorded", async () => {
    state.recorded.set("m0", { gmailId: "m0" });
    expect(await importSentHistory("u1", NOW)).toBe(2);

    expect(state.listCalls).toHaveLength(1);
    expect(state.listCalls[0]?.params).toMatchObject({
      userId: "me",
      q: `in:sent after:${WINDOW_START_SECONDS}`,
      maxResults: 500,
    });
    // Oldest first.
    expect(getIds()).toEqual(["m2", "m1"]);
    for (const call of state.getCalls) {
      expect(call.params).toMatchObject({
        userId: "me",
        format: "metadata",
        metadataHeaders: ["To", "Subject", "Date"],
      });
    }
    // Detached work: every Gmail call carries a timeout so a hung request
    // cannot hold an import slot forever.
    for (const call of [...state.listCalls, ...state.getCalls]) {
      expect(call.options).toMatchObject({ timeout: expect.any(Number) });
    }
    expect(state.recorded.get("m1")).toEqual({
      gmailId: "m1",
      threadId: "t-m1",
      to: "person1@x.com",
      subject: "Subject 1",
      sentAt: new Date(NOW - 2 * 3_600_000),
      inbox: "primary",
    });
  });

  it("fetches at most 2 messages at a time (Gmail per-user quota)", async () => {
    state.mailboxes = { primary: mailbox(12) };
    state.getDelayMs = 5;
    await importSentHistory("u1", NOW);
    expect(state.getCalls).toHaveLength(12);
    expect(state.maxInFlight).toBeLessThanOrEqual(2);
  });

  it("labels the rows it creates with the classifier and records them through recordSentMessage", async () => {
    state.labels = new Map([["m1", "auto_reply"]]);
    await importSentHistory("u1", NOW);
    expect(state.classifyCalls).toHaveLength(1);
    expect(state.classifyCalls[0]).toEqual([
      {
        gmailId: "m2",
        to: "person2@x.com",
        subject: "Subject 2",
        sentAt: new Date(NOW - 10_800_000),
        inbox: "primary",
      },
      {
        gmailId: "m1",
        to: "person1@x.com",
        subject: "Subject 1",
        sentAt: new Date(NOW - 7_200_000),
        inbox: "primary",
      },
      {
        gmailId: "m0",
        to: "person0@x.com",
        subject: "Subject 0",
        sentAt: new Date(NOW - 3_600_000),
        inbox: "primary",
      },
    ]);
    expect(recordSentMessage).toHaveBeenCalledTimes(3);
    expect(state.recorded.get("m1")).toMatchObject({ inferredOrigin: "auto_reply" });
    expect(state.recorded.get("m0")).not.toHaveProperty("inferredOrigin");
    expect(state.recorded.get("m0")).not.toHaveProperty("origin");
  });
});

describe("paging and resume", () => {
  it("does at most one batch per run, oldest first, and resumes from the database, with no cursor", async () => {
    state.mailboxes = { primary: mailbox(250) };
    const oldestFirst = mailbox(250)
      .map((m) => m.id)
      .reverse();
    expect(await importSentHistory("u1", NOW)).toBe(SENT_HISTORY_BATCH);
    expect(getIds()).toEqual(oldestFirst.slice(0, 100));
    expect(state.markerWrites).toEqual([]);

    state.getCalls = [];
    expect(await importSentHistory("u1", NOW)).toBe(SENT_HISTORY_BATCH);
    expect(getIds()).toEqual(oldestFirst.slice(100, 200));

    state.getCalls = [];
    expect(await importSentHistory("u1", NOW)).toBe(50);
    expect(getIds()).toEqual(oldestFirst.slice(200));
    // Everything listed is recorded: done in the same run.
    expect(state.markerWrites).toHaveLength(1);
  });

  it("after a crash mid-batch it fetches exactly what is missing, gaps included", async () => {
    state.mailboxes = { primary: mailbox(10) };
    // A run that died after recording 4 rows, plus rows the 30-min scan wrote.
    for (const id of ["m0", "m1", "m2", "m3", "m6"]) state.recorded.set(id, { gmailId: id });
    await importSentHistory("u1", NOW);
    expect(getIds()).toEqual(["m9", "m8", "m7", "m5", "m4"]);
  });

  it("caps the import at the newest 2,000 sent mails of the inbox", async () => {
    state.mailboxes = { primary: mailbox(2_600) };
    let runs = 0;
    while (state.markerWrites.length === 0 && runs < 40) {
      await importSentHistory("u1", NOW);
      runs += 1;
    }
    expect(state.markerWrites).toHaveLength(1);
    expect(state.getCalls).toHaveLength(SENT_HISTORY_CAP);
    expect(new Set(getIds())).toEqual(new Set(mailbox(SENT_HISTORY_CAP).map((m) => m.id)));
    // Listing stops at the cap: never a page past the 2,000th id.
    expect(state.listCalls.every((c) => Number(c.params.pageToken ?? 0) < SENT_HISTORY_CAP)).toBe(
      true,
    );
    expect(runs).toBe(SENT_HISTORY_CAP / SENT_HISTORY_BATCH);
  });

  it("never fetches mail older than 12 months", async () => {
    state.mailboxes = {
      primary: [
        ...mailbox(2),
        { id: "old", internalDate: NOW - 400 * DAY, to: "a@b.c", subject: "x" },
      ],
    };
    await importSentHistory("u1", NOW);
    expect(getIds()).toEqual(["m1", "m0"]);
  });
});

describe("completion marker", () => {
  it("marks the inbox done once nothing is missing, then never calls Gmail for it again", async () => {
    for (const m of state.mailboxes.primary ?? []) state.recorded.set(m.id, { gmailId: m.id });
    expect(await importSentHistory("u1", NOW)).toBe(0);
    expect(state.getCalls).toEqual([]);
    expect(state.markerWrites).toEqual([
      {
        table: "userToken",
        args: {
          where: { userId: "u1", provider: "google" },
          data: { sentHistoryImportedAt: new Date(NOW) },
        },
      },
    ]);

    state.listCalls = [];
    vi.mocked(getAuthedClient).mockClear();
    expect(await importSentHistory("u1", NOW + 60_000)).toBe(0);
    expect(state.listCalls).toEqual([]);
    expect(getAuthedClient).not.toHaveBeenCalled();
  });

  it("imports each linked Google inbox the Sent scan reads, with its own marker", async () => {
    state.primaryToken = { sentHistoryImportedAt: new Date(NOW - DAY) };
    state.linked = [{ id: "L1", sentHistoryImportedAt: null }];
    state.mailboxes = { primary: mailbox(3), L1: mailbox(2, "l") };
    expect(await importSentHistory("u1", NOW)).toBe(2);
    expect(state.listCalls.map((c) => c.account)).toEqual(["L1"]);
    expect(state.recorded.get("l0")).toMatchObject({ inbox: "L1" });
    expect(state.markerWrites).toEqual([
      {
        table: "linkedInboxAccount",
        args: { where: { id: "L1", userId: "u1" }, data: { sentHistoryImportedAt: new Date(NOW) } },
      },
    ]);
  });

  it("skips an inbox whose token is unusable instead of stalling the others", async () => {
    state.primaryClient = false;
    state.linked = [{ id: "L1", sentHistoryImportedAt: null }];
    state.mailboxes = { L1: mailbox(1, "l") };
    expect(await importSentHistory("u1", NOW)).toBe(1);
    expect(state.markerWrites.map((w) => w.table)).toEqual(["linkedInboxAccount"]);
  });

  it("does nothing without a Google connection", async () => {
    state.primaryToken = null;
    expect(await importSentHistory("u1", NOW)).toBe(0);
    expect(state.listCalls).toEqual([]);
  });
});

describe("failures", () => {
  it("a failed fetch finishes nothing and pauses the user", async () => {
    state.getFailures.set("m1", Object.assign(new Error("rate"), { response: { status: 429 } }));
    await importSentHistory("u1", NOW);
    expect(state.markerWrites).toEqual([]);
    expect(state.captured).toHaveLength(1);

    state.listCalls = [];
    expect(await importSentHistory("u1", NOW + 60_000)).toBe(0);
    expect(state.listCalls).toEqual([]);

    state.getFailures.clear();
    await importSentHistory("u1", NOW + 31 * 60_000);
    expect(state.listCalls).toHaveLength(1);
    expect(state.markerWrites).toHaveLength(1);
  });

  it("a message deleted between list and fetch (404) does not block completion", async () => {
    state.getFailures.set("m1", Object.assign(new Error("gone"), { response: { status: 404 } }));
    expect(await importSentHistory("u1", NOW)).toBe(2);
    expect(state.recorded.has("m1")).toBe(false);
    expect(state.markerWrites).toHaveLength(1);
  });

  it("a classifier failure records nothing and finishes nothing", async () => {
    state.classifyFails = true;
    expect(await importSentHistory("u1", NOW)).toBe(0);
    expect(recordSentMessage).not.toHaveBeenCalled();
    expect(state.markerWrites).toEqual([]);
    expect(state.captured).toHaveLength(1);
  });

  it("runs one import per user at a time", async () => {
    state.getDelayMs = 5;
    const [a, b] = await Promise.all([importSentHistory("u1", NOW), importSentHistory("u1", NOW)]);
    expect([a, b].sort()).toEqual([0, 3]);
    expect(state.listCalls).toHaveLength(1);
  });
});
