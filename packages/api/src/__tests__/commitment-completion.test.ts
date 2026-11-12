/**
 * Completion suggestions for the Commitment Ledger: a later reply in the
 * promise's own thread marks it "likely done" (the user owes it) or "likely
 * delivered" (the counterparty owes it). A suggestion is only ever a stamp the
 * user confirms with one tap — nothing here sets DONE.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletionCandidate } from "../pim/commitment-completion.js";

const mocks = vi.hoisted(() => ({
  commitmentFindMany: vi.fn(),
  commitmentUpdateMany: vi.fn(),
  commitmentFindFirst: vi.fn(),
  emailFindMany: vi.fn(),
  sentFindMany: vi.fn(),
  upsertAttention: vi.fn(async () => undefined),
  captureError: vi.fn(),
}));

vi.mock("../db.js", () => {
  const prisma = {
    commitment: {
      findMany: mocks.commitmentFindMany,
      updateMany: mocks.commitmentUpdateMany,
      findFirst: mocks.commitmentFindFirst,
    },
    emailMessage: { findMany: mocks.emailFindMany },
    sentMessage: { findMany: mocks.sentFindMany },
  };
  return { prisma, db: prisma };
});
vi.mock("../judge/attention-mirror.js", () => ({
  upsertAttentionForCommitment: mocks.upsertAttention,
}));
vi.mock("../sentry.js", () => ({ captureError: mocks.captureError }));

const {
  MAX_STAMPS_PER_REFRESH,
  matchCompletionSuggestions,
  maybeRefreshCompletionSuggestions,
  refreshCompletionSuggestions,
  toCompletionCandidate,
} = await import("../pim/commitment-completion.js");

const SOURCE_AT = new Date("2026-11-01T09:00:00Z");
const LATER = new Date("2026-11-02T09:00:00Z");
const EARLIER = new Date("2026-10-31T09:00:00Z");

function candidate(over: Partial<CompletionCandidate> = {}): CompletionCandidate {
  return {
    id: "c-1",
    owner: "USER",
    threadId: "t-1",
    inbox: "primary",
    after: SOURCE_AT,
    sourceEmailId: "e-src",
    sourceGmailId: "g-src",
    counterpartyAddress: null,
    ...over,
  };
}

function send(over: Partial<{ threadId: string; inbox: string; sentAt: Date; gmailId: string }>) {
  return { threadId: "t-1", inbox: "primary", sentAt: LATER, gmailId: "g-reply", ...over };
}

function inbound(
  over: Partial<{
    id: string;
    gmailId: string;
    threadId: string;
    inbox: string;
    receivedAt: Date;
    fromAddress: string;
  }>,
) {
  return {
    id: "e-next",
    gmailId: "g-next",
    threadId: "t-1",
    inbox: "primary",
    receivedAt: LATER,
    fromAddress: "sarah@acme.com",
    ...over,
  };
}

describe("matchCompletionSuggestions — the user owes it", () => {
  it("suggests done when the user later sent a reply in the same thread", () => {
    expect(matchCompletionSuggestions([candidate()], [send({})], [])).toEqual([
      { id: "c-1", at: LATER },
    ]);
  });

  it("ignores a send before the promise, in another thread, or from another account", () => {
    const sends = [
      send({ sentAt: EARLIER }),
      send({ threadId: "t-other" }),
      send({ inbox: "linked-2" }),
    ];
    expect(matchCompletionSuggestions([candidate()], sends, [])).toEqual([]);
  });

  it("never counts the promise mail itself (a note the user sent to themselves)", () => {
    const sends = [send({ gmailId: "g-src", sentAt: LATER })];
    expect(matchCompletionSuggestions([candidate()], sends, [])).toEqual([]);
  });

  it("stamps the earliest qualifying reply", () => {
    const first = new Date("2026-11-01T12:00:00Z");
    const sends = [
      send({ sentAt: LATER, gmailId: "g-2" }),
      send({ sentAt: first, gmailId: "g-1" }),
    ];
    expect(matchCompletionSuggestions([candidate()], sends, [])).toEqual([
      { id: "c-1", at: first },
    ]);
  });

  it("does not treat the counterparty writing back as the user's own delivery", () => {
    expect(matchCompletionSuggestions([candidate()], [], [inbound({})])).toEqual([]);
  });
});

describe("matchCompletionSuggestions — the counterparty owes it", () => {
  const theirs = candidate({ owner: "COUNTERPARTY", counterpartyAddress: "sarah@acme.com" });

  it("suggests delivered when that counterparty wrote again in the thread", () => {
    expect(matchCompletionSuggestions([theirs], [], [inbound({})])).toEqual([
      { id: "c-1", at: LATER },
    ]);
  });

  it("ignores mail from someone else, the promise mail itself, and earlier mail", () => {
    const rows = [
      inbound({ fromAddress: "bob@acme.com" }),
      inbound({ id: "e-src", gmailId: "g-src" }),
      inbound({ receivedAt: EARLIER }),
      inbound({ inbox: "linked-2" }),
    ];
    expect(matchCompletionSuggestions([theirs], [], rows)).toEqual([]);
  });

  it("does not treat the user's own reply as the counterparty delivering", () => {
    expect(matchCompletionSuggestions([theirs], [send({})], [])).toEqual([]);
  });

  it("needs a known counterparty address", () => {
    const unknown = { ...theirs, counterpartyAddress: null };
    expect(matchCompletionSuggestions([unknown], [], [inbound({})])).toEqual([]);
  });
});

describe("toCompletionCandidate", () => {
  const row = {
    id: "c-1",
    owner: "COUNTERPARTY" as const,
    threadId: "t-1",
    sourceId: "e-src",
    counterpartyEmail: "Sarah Kim <Sarah@Acme.com>",
  };
  const source = {
    id: "e-src",
    gmailId: "g-src",
    receivedAt: SOURCE_AT,
    linkedInboxAccountId: null,
  };

  it("reads the counterparty mailbox out of a raw From header, lowercased", () => {
    expect(toCompletionCandidate(row, source)?.counterpartyAddress).toBe("sarah@acme.com");
  });

  it("anchors on the source mail and its account", () => {
    const linked = { ...source, linkedInboxAccountId: "linked-2" };
    expect(toCompletionCandidate(row, linked)).toMatchObject({
      after: SOURCE_AT,
      inbox: "linked-2",
      sourceGmailId: "g-src",
    });
  });

  it("skips rows without a source mail or with an owner that cannot finish it", () => {
    expect(toCompletionCandidate(row, undefined)).toBeNull();
    expect(toCompletionCandidate({ ...row, owner: "TEAM" }, source)).toBeNull();
    expect(toCompletionCandidate({ ...row, threadId: null }, source)).toBeNull();
  });
});

describe("refreshCompletionSuggestions", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.upsertAttention.mockResolvedValue(undefined);
  });

  function seedOpen() {
    mocks.commitmentFindMany.mockResolvedValue([
      {
        id: "c-1",
        owner: "USER",
        threadId: "t-1",
        sourceId: "e-src",
        counterpartyEmail: null,
      },
    ]);
    mocks.emailFindMany.mockImplementation(async ({ where }: { where: { id?: unknown } }) =>
      where.id
        ? [{ id: "e-src", gmailId: "g-src", receivedAt: SOURCE_AT, linkedInboxAccountId: null }]
        : [],
    );
  }

  it("stamps a likely-done suggestion scoped to the user, never DONE", async () => {
    seedOpen();
    mocks.sentFindMany.mockResolvedValue([send({})]);
    mocks.commitmentUpdateMany.mockResolvedValue({ count: 1 });
    mocks.commitmentFindFirst.mockResolvedValue({ id: "c-1", status: "OPEN" });

    const stamped = await refreshCompletionSuggestions("user-1");

    expect(stamped).toBe(1);
    const update = mocks.commitmentUpdateMany.mock.calls[0]?.[0];
    expect(update.where).toMatchObject({
      id: "c-1",
      userId: "user-1",
      status: "OPEN",
      completionSuggestedAt: null,
    });
    expect(update.data).toEqual({ completionSuggestedAt: LATER });
    expect(JSON.stringify(update.data)).not.toContain("DONE");
    // A hint for the user only: the queue mirror (its lane) is left alone.
    expect(mocks.upsertAttention).not.toHaveBeenCalled();
  });

  it("reads only the user's own rows, open and not yet suggested", async () => {
    seedOpen();
    mocks.sentFindMany.mockResolvedValue([]);

    await refreshCompletionSuggestions("user-1");

    expect(mocks.commitmentFindMany.mock.calls[0]?.[0].where).toMatchObject({
      userId: "user-1",
      status: "OPEN",
      completionSuggestedAt: null,
    });
    expect(mocks.emailFindMany.mock.calls[0]?.[0].where).toMatchObject({ userId: "user-1" });
    expect(mocks.sentFindMany.mock.calls[0]?.[0].where).toMatchObject({ userId: "user-1" });
    expect(mocks.commitmentUpdateMany).not.toHaveBeenCalled();
  });

  it("leaves Klorn's autonomous sends out: only the user's own replies count", async () => {
    seedOpen();
    mocks.sentFindMany.mockResolvedValue([]);

    await refreshCompletionSuggestions("user-1");

    const where = mocks.sentFindMany.mock.calls[0]?.[0].where;
    expect(where.OR).toEqual([{ origin: null }, { origin: { in: ["user", "approved"] } }]);
  });

  it("checks the rows the ledger lists first (soonest due), not only the newest", async () => {
    seedOpen();
    mocks.sentFindMany.mockResolvedValue([]);
    await refreshCompletionSuggestions("user-1");
    expect(mocks.commitmentFindMany.mock.calls[0]?.[0].orderBy).toEqual([
      { dueAt: "asc" },
      { createdAt: "desc" },
    ]);
  });

  it("reads only the counterparties' own mail in those threads", async () => {
    mocks.commitmentFindMany.mockResolvedValue([
      {
        id: "c-2",
        owner: "COUNTERPARTY",
        threadId: "t-1",
        sourceId: "e-src",
        counterpartyEmail: "Sarah <sarah@acme.com>",
      },
    ]);
    mocks.emailFindMany.mockImplementation(async ({ where }: { where: { id?: unknown } }) =>
      where.id
        ? [{ id: "e-src", gmailId: "g-src", receivedAt: SOURCE_AT, linkedInboxAccountId: null }]
        : [],
    );

    await refreshCompletionSuggestions("user-1");

    const inboundWhere = mocks.emailFindMany.mock.calls[1]?.[0].where;
    expect(inboundWhere).toMatchObject({ userId: "user-1" });
    // Mail with no normalized address is kept and matched on its From header.
    expect(inboundWhere.OR).toEqual([
      { fromAddress: { in: ["sarah@acme.com"] } },
      { fromAddress: null },
    ]);
    expect(mocks.sentFindMany).not.toHaveBeenCalled();
  });

  it("stamps at most MAX_STAMPS_PER_REFRESH rows per read", async () => {
    const many = Array.from({ length: MAX_STAMPS_PER_REFRESH + 5 }, (_, i) => ({
      id: `c-${i}`,
      owner: "USER",
      threadId: `t-${i}`,
      sourceId: `e-${i}`,
      counterpartyEmail: null,
    }));
    mocks.commitmentFindMany.mockResolvedValue(many);
    mocks.emailFindMany.mockResolvedValue(
      many.map((_, i) => ({
        id: `e-${i}`,
        gmailId: `g-${i}`,
        receivedAt: SOURCE_AT,
        linkedInboxAccountId: null,
      })),
    );
    mocks.sentFindMany.mockResolvedValue(
      many.map((_, i) => send({ threadId: `t-${i}`, gmailId: `r-${i}` })),
    );
    mocks.commitmentUpdateMany.mockResolvedValue({ count: 1 });
    mocks.commitmentFindFirst.mockResolvedValue({ id: "x", status: "OPEN" });

    expect(await refreshCompletionSuggestions("user-1")).toBe(MAX_STAMPS_PER_REFRESH);
    expect(mocks.commitmentUpdateMany).toHaveBeenCalledTimes(MAX_STAMPS_PER_REFRESH);
  });

  it("re-reads a user's threads at most once per cooldown (GET is polled on focus)", async () => {
    mocks.commitmentFindMany.mockResolvedValue([]);
    const t0 = 1_000_000;
    await maybeRefreshCompletionSuggestions("user-cool", t0);
    await maybeRefreshCompletionSuggestions("user-cool", t0 + 30_000);
    expect(mocks.commitmentFindMany).toHaveBeenCalledTimes(1);
    await maybeRefreshCompletionSuggestions("user-other", t0 + 30_000);
    expect(mocks.commitmentFindMany).toHaveBeenCalledTimes(2);
    await maybeRefreshCompletionSuggestions("user-cool", t0 + 61_000);
    expect(mocks.commitmentFindMany).toHaveBeenCalledTimes(3);
  });

  it("does no thread reads when nothing is open", async () => {
    mocks.commitmentFindMany.mockResolvedValue([]);
    expect(await refreshCompletionSuggestions("user-1")).toBe(0);
    expect(mocks.emailFindMany).not.toHaveBeenCalled();
    expect(mocks.sentFindMany).not.toHaveBeenCalled();
  });

  it("never throws: a failed read is reported and the ledger still lists", async () => {
    mocks.commitmentFindMany.mockRejectedValue(new Error("db down"));
    expect(await refreshCompletionSuggestions("user-1")).toBe(0);
    expect(mocks.captureError).toHaveBeenCalledTimes(1);
  });
});
