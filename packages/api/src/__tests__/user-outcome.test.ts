/**
 * Route-facing outcome helpers: every one is fire-and-forget (returns before
 * the ledger write settles, never throws, never rejects unhandled), scopes
 * every read and write to the acting user, and stamps the ledger through
 * stampDecisionOutcome's first-wins columns. Prisma is mocked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  labelUpdateMany: vi.fn(),
  itemFindFirst: vi.fn(),
  emailFindFirst: vi.fn(),
}));

vi.mock("../db.js", () => {
  const prisma = {
    decisionLabel: { updateMany: db.labelUpdateMany },
    attentionItem: { findFirst: db.itemFindFirst },
    emailMessage: { findFirst: db.emailFindFirst },
  };
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import {
  noteAttentionItemOutcome,
  noteEmailOutcome,
  noteEmailOutcomes,
  noteReplyIfSent,
} from "../judge/user-outcome.js";
import { captureError } from "../sentry.js";

beforeEach(() => {
  vi.clearAllMocks();
  db.labelUpdateMany.mockResolvedValue({ count: 1 });
  db.itemFindFirst.mockResolvedValue({ source: "EMAIL", sourceId: "email-1" });
  db.emailFindFirst.mockResolvedValue({ id: "email-1" });
});

const stampCall = (i = 0) => db.labelUpdateMany.mock.calls[i]?.[0];

describe("noteEmailOutcome", () => {
  it("stamps the user's EMAIL ledger row once", async () => {
    noteEmailOutcome("user-1", "email-1", "OPENED");

    await vi.waitFor(() => expect(db.labelUpdateMany).toHaveBeenCalledTimes(1));
    expect(stampCall().where).toEqual({
      userId: "user-1",
      source: "EMAIL",
      sourceId: "email-1",
      openedAt: null,
    });
  });

  it("logs, and never rejects, when the write fails", async () => {
    db.labelUpdateMany.mockRejectedValue(new Error("db down"));
    noteEmailOutcome("user-1", "email-1", "OPENED");
    await vi.waitFor(() => expect(captureError).toHaveBeenCalledTimes(1));
  });
});

describe("noteEmailOutcomes", () => {
  it("stamps every listed row in one query", async () => {
    noteEmailOutcomes("user-1", ["e1", "e2"], "ARCHIVED");

    await vi.waitFor(() => expect(db.labelUpdateMany).toHaveBeenCalledTimes(1));
    expect(stampCall().where).toMatchObject({ userId: "user-1", sourceId: { in: ["e1", "e2"] } });
    expect(stampCall().data.archivedAt).toBeInstanceOf(Date);
  });
});

describe("noteAttentionItemOutcome", () => {
  it("resolves the item's source within the user's own items, then stamps that row", async () => {
    db.itemFindFirst.mockResolvedValue({ source: "GITHUB", sourceId: "gh-1" });

    noteAttentionItemOutcome("user-1", "item-1", "DISMISSED");

    await vi.waitFor(() => expect(db.labelUpdateMany).toHaveBeenCalledTimes(1));
    expect(db.itemFindFirst.mock.calls[0][0].where).toEqual({ id: "item-1", userId: "user-1" });
    expect(stampCall().where).toEqual({
      userId: "user-1",
      source: "GITHUB",
      sourceId: "gh-1",
      dismissedAt: null,
    });
  });

  it("stamps nothing for an item that isn't the user's", async () => {
    db.itemFindFirst.mockResolvedValue(null);
    noteAttentionItemOutcome("user-1", "someone-elses", "DISMISSED");
    await vi.waitFor(() => expect(db.itemFindFirst).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(db.labelUpdateMany).not.toHaveBeenCalled();
  });

  it("logs, and never rejects, when the lookup fails", async () => {
    db.itemFindFirst.mockRejectedValue(new Error("db down"));
    noteAttentionItemOutcome("user-1", "item-1", "SNOOZED");
    await vi.waitFor(() => expect(captureError).toHaveBeenCalledTimes(1));
    expect(db.labelUpdateMany).not.toHaveBeenCalled();
  });
});

describe("noteReplyIfSent", () => {
  const since = new Date("2026-10-25T00:00:00Z");

  it("stamps REPLIED on the row the reply answered, only if this send marked it replied", async () => {
    noteReplyIfSent("user-1", "gmail-abc", since);

    await vi.waitFor(() => expect(db.labelUpdateMany).toHaveBeenCalledTimes(1));
    expect(db.emailFindFirst.mock.calls[0][0].where).toEqual({
      userId: "user-1",
      OR: [{ id: "gmail-abc" }, { gmailId: "gmail-abc" }],
      repliedAt: { gte: since },
    });
    expect(stampCall().where).toEqual({
      userId: "user-1",
      source: "EMAIL",
      sourceId: "email-1",
      repliedAt: null,
    });
  });

  it("stamps nothing when the send did not go out (no fresh repliedAt)", async () => {
    db.emailFindFirst.mockResolvedValue(null);
    noteReplyIfSent("user-1", "email-1", since);
    await vi.waitFor(() => expect(db.emailFindFirst).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(db.labelUpdateMany).not.toHaveBeenCalled();
  });

  it("logs, and never rejects, when the lookup fails", async () => {
    db.emailFindFirst.mockRejectedValue(new Error("db down"));
    noteReplyIfSent("user-1", "email-1", since);
    await vi.waitFor(() => expect(captureError).toHaveBeenCalledTimes(1));
  });
});
