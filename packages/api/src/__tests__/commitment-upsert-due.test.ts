import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "c-1", ...data })),
  create: vi.fn(),
}));

vi.mock("../db.js", () => ({
  prisma: {
    commitment: { findUnique: mocks.findUnique, update: mocks.update, create: mocks.create },
  },
}));
vi.mock("../judge/attention-mirror.js", () => ({
  upsertAttentionForCommitment: vi.fn(() => Promise.resolve()),
  deleteAttentionForCommitments: vi.fn(() => Promise.resolve()),
}));

import { upsertCommitment } from "../pim/commitments.js";

const FIRST_DUE = new Date("2026-11-13T14:59:00.000Z");
const LATER_DUE = new Date("2026-11-20T14:59:00.000Z");

function existingRow(dueAt: Date | null) {
  return {
    id: "c-1",
    description: null,
    dueAt,
    dueText: "내일",
    confidence: 0.55,
    evidenceText: "내일 보내드릴게요",
  };
}

describe("upsertCommitment — re-ingesting the same promise", () => {
  beforeEach(() => {
    mocks.findUnique.mockReset();
    mocks.update.mockClear();
  });

  it("keeps the first resolved due date (a quoted reply re-reads it later)", async () => {
    mocks.findUnique.mockResolvedValueOnce(existingRow(FIRST_DUE));

    await upsertCommitment("u-1", {
      title: "내일 보내드릴게요",
      dueAt: LATER_DUE,
      dueText: "내일",
      dedupKey: "email:t-1:abc",
    });

    expect(mocks.update.mock.calls[0][0].data.dueAt).toBe(FIRST_DUE);
  });

  // Noise control: a promise the user dismissed (or confirmed, or that a reply
  // marked likely done) is re-mined from every quoted reply in its thread. The
  // re-ingestion update must leave the user's triage alone.
  it("never rewrites the user's triage: status, confirmation, completion stamp", async () => {
    mocks.findUnique.mockResolvedValueOnce({ ...existingRow(null), status: "DISMISSED" });

    await upsertCommitment("u-1", {
      title: "내일 보내드릴게요",
      dueText: "내일",
      dedupKey: "email:t-1:abc",
    });

    const data = mocks.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("status");
    expect(data).not.toHaveProperty("confirmedAt");
    expect(data).not.toHaveProperty("completionSuggestedAt");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("fills a due date the row did not have yet", async () => {
    mocks.findUnique.mockResolvedValueOnce(existingRow(null));

    await upsertCommitment("u-1", {
      title: "내일 보내드릴게요",
      dueAt: LATER_DUE,
      dueText: "내일",
      dedupKey: "email:t-1:abc",
    });

    expect(mocks.update.mock.calls[0][0].data.dueAt).toBe(LATER_DUE);
  });
});
