/**
 * Provider-side archives: mail the reconcile found gone from the Gmail INBOX
 * (Klorn's own archive and trash delete the mirror row first, so they are not
 * in that set) stamps providerArchivedAt, after one minimal Gmail read per
 * message rules out spam and mail that is back in the inbox. Bounded per tick,
 * never throws. Prisma and Gmail are mocked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  labelFindMany: vi.fn(),
  stamp: vi.fn(),
  get: vi.fn(),
  captureError: vi.fn(),
}));

vi.mock("../db.js", () => ({ prisma: { decisionLabel: { findMany: m.labelFindMany } } }));
vi.mock("../sentry.js", () => ({ captureError: m.captureError }));
vi.mock("../judge/decision-label.js", () => ({ stampProviderEngagement: m.stamp }));
vi.mock("../mail/gmail.js", () => ({
  isGoogleNotFoundError: (err: unknown) => (err as { code?: number })?.code === 404,
}));

import {
  classifyInboxRemoval,
  noteProviderArchives,
  PROVIDER_ARCHIVE_CHECK_CAP,
  REMOVED_LOOKUP_CAP,
} from "../mail/provider-archives.js";

const NOW = new Date("2026-11-10T10:00:00Z");
const gmail = { users: { messages: { get: m.get } } };
const removed = (id: string, minutesAgo = 0) => ({
  id,
  gmailId: `g-${id}`,
  receivedAt: new Date(NOW.getTime() - minutesAgo * 60_000),
});
const labelsFor = (byGmailId: Record<string, string[]>) =>
  m.get.mockImplementation(async ({ id }: { id: string }) => {
    if (!(id in byGmailId)) throw Object.assign(new Error("Not Found"), { code: 404 });
    return { data: { labelIds: byGmailId[id] } };
  });

beforeEach(() => {
  vi.clearAllMocks();
  m.labelFindMany.mockResolvedValue([]);
  m.stamp.mockImplementation(async (_u: string, _k: string, ids: string[]) => ids.length);
});

describe("classifyInboxRemoval", () => {
  it("reads archive (no INBOX), a user label, and trash as archived", () => {
    expect(classifyInboxRemoval([])).toBe("archived");
    expect(classifyInboxRemoval(["IMPORTANT", "CATEGORY_UPDATES", "Label_42"])).toBe("archived");
    // Parity with Klorn's own stamps: DELETE /api/email/:id stamps ARCHIVED too.
    expect(classifyInboxRemoval(["TRASH"])).toBe("archived");
  });

  it("reads spam as spam and a message back in the inbox as in-inbox", () => {
    expect(classifyInboxRemoval(["SPAM"])).toBe("spam");
    expect(classifyInboxRemoval(["INBOX", "UNREAD"])).toBe("in-inbox");
  });
});

describe("noteProviderArchives", () => {
  it("looks up only the user's ledger rows of the removed mail with no archive from either source, newest judgement first, capped", async () => {
    await noteProviderArchives("user-1", gmail, [removed("e1"), removed("e2")], NOW);

    expect(m.labelFindMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        source: "EMAIL",
        sourceId: { in: ["e1", "e2"] },
        providerArchivedAt: null,
        archivedAt: null,
      },
      select: { sourceId: true },
      orderBy: { judgedAt: "desc" },
      take: PROVIDER_ARCHIVE_CHECK_CAP,
    });
  });

  it("stamps archived and trashed mail at the time it was seen, skipping spam, inbox and gone mail", async () => {
    m.labelFindMany.mockResolvedValue(
      ["arch", "trash", "spam", "back", "gone"].map((sourceId) => ({ sourceId })),
    );
    labelsFor({
      "g-arch": ["IMPORTANT"],
      "g-trash": ["TRASH"],
      "g-spam": ["SPAM"],
      "g-back": ["INBOX"],
    });

    const count = await noteProviderArchives(
      "user-1",
      gmail,
      ["arch", "trash", "spam", "back", "gone"].map((id) => removed(id)),
      NOW,
    );

    expect(m.get).toHaveBeenCalledWith({ userId: "me", id: "g-arch", format: "minimal" });
    expect(m.stamp).toHaveBeenCalledTimes(1);
    const [userId, kind, ids, at] = m.stamp.mock.calls[0];
    expect([userId, kind, at]).toEqual(["user-1", "ARCHIVED", NOW]);
    expect([...ids].sort()).toEqual(["arch", "trash"]);
    expect(count).toBe(2);
    // A 404 is an expected race (deleted for good), not a fault.
    expect(m.captureError).not.toHaveBeenCalled();
  });

  it("skips a message Gmail could not read, reports it once, and still stamps the rest", async () => {
    m.labelFindMany.mockResolvedValue([{ sourceId: "ok" }, { sourceId: "x1" }, { sourceId: "x2" }]);
    m.get.mockImplementation(async ({ id }: { id: string }) => {
      if (id === "g-ok") return { data: { labelIds: [] } };
      throw Object.assign(new Error("rate limited"), { code: 429 });
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await noteProviderArchives("user-1", gmail, [removed("ok"), removed("x1"), removed("x2")], NOW);

    expect(m.stamp).toHaveBeenCalledWith("user-1", "ARCHIVED", ["ok"], NOW);
    expect(m.captureError).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("makes no query for an empty list and no Gmail call when nothing is pending", async () => {
    await expect(noteProviderArchives("user-1", gmail, [], NOW)).resolves.toBe(0);
    expect(m.labelFindMany).not.toHaveBeenCalled();

    await noteProviderArchives("user-1", gmail, [removed("e1")], NOW);
    expect(m.get).not.toHaveBeenCalled();
    expect(m.stamp).not.toHaveBeenCalled();
  });

  it("bounds the ledger lookup to the most recently received removed mail", async () => {
    const many = Array.from({ length: REMOVED_LOOKUP_CAP + 5 }, (_, i) => removed(`e${i}`, i));

    await noteProviderArchives("user-1", gmail, many, NOW);

    const ids = m.labelFindMany.mock.calls[0][0].where.sourceId.in as string[];
    expect(ids).toHaveLength(REMOVED_LOOKUP_CAP);
    expect(ids[0]).toBe("e0");
    expect(ids).not.toContain(`e${REMOVED_LOOKUP_CAP}`);
  });

  it("never throws: a failed ledger read is logged and stamps nothing", async () => {
    m.labelFindMany.mockRejectedValue(new Error("db down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(noteProviderArchives("user-1", gmail, [removed("e1")], NOW)).resolves.toBe(0);

    expect(m.stamp).not.toHaveBeenCalled();
    expect(m.captureError).toHaveBeenCalled();
    warn.mockRestore();
  });
});
