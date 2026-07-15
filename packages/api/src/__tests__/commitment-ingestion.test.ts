import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const existingDedupKeys = new Set<string>();
  const upsertCommitmentMock = vi.fn(
    (_userId: string, input: { dedupKey?: string | null; [key: string]: unknown }) => {
      if (input.dedupKey) existingDedupKeys.add(input.dedupKey);
      return { id: "commitment-1", ...input };
    },
  );
  const findUniqueMock = vi.fn(({ where }: { where: { userId_dedupKey: { dedupKey: string } } }) =>
    existingDedupKeys.has(where.userId_dedupKey.dedupKey) ? { id: "existing" } : null,
  );
  return { existingDedupKeys, upsertCommitmentMock, findUniqueMock };
});

vi.mock("../db.js", () => ({
  prisma: {
    commitment: {
      findUnique: mocks.findUniqueMock,
    },
  },
}));

vi.mock("../pim/commitments.js", () => ({
  upsertCommitment: mocks.upsertCommitmentMock,
}));

import { extractAndUpsertCommitmentsFromText } from "../pim/commitment-ingestion.js";

describe("extractAndUpsertCommitmentsFromText", () => {
  beforeEach(() => {
    mocks.existingDedupKeys.clear();
    mocks.upsertCommitmentMock.mockClear();
    mocks.findUniqueMock.mockClear();
  });

  it("creates low-confidence commitments from rule-based candidates", async () => {
    const result = await extractAndUpsertCommitmentsFromText({
      userId: "user-1",
      sourceType: "CHAT",
      sourceId: "msg-1",
      threadId: "conversation-1",
      text: "내일까지 자료 보내드릴게요.",
      contextTitle: "Chat message",
    });

    expect(result).toEqual({
      candidatesFound: 1,
      commitmentsCreated: 1,
      duplicatesSkipped: 0,
    });
    expect(mocks.upsertCommitmentMock).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        owner: "USER",
        sourceType: "CHAT",
        sourceId: "msg-1",
        threadId: "conversation-1",
        dueText: "내일",
        confidence: 0.55,
      }),
    );
  });

  it("uses deterministic dedup keys so repeated ingestion is counted as duplicate", async () => {
    const input = {
      userId: "user-1",
      sourceType: "EMAIL" as const,
      sourceId: "email-1",
      threadId: "thread-1",
      text: "Sounds good — I'll send the deck by EOD.",
      contextTitle: "Deck",
    };

    await extractAndUpsertCommitmentsFromText(input);
    const second = await extractAndUpsertCommitmentsFromText(input);

    expect(second.candidatesFound).toBe(1);
    expect(second.commitmentsCreated).toBe(0);
    expect(second.duplicatesSkipped).toBe(1);
    const firstDedup = mocks.upsertCommitmentMock.mock.calls[0][1].dedupKey;
    const secondDedup = mocks.upsertCommitmentMock.mock.calls[1][1].dedupKey;
    expect(secondDedup).toBe(firstDedup);
  });

  it("does nothing when no commitment-shaped text is found", async () => {
    const result = await extractAndUpsertCommitmentsFromText({
      userId: "user-1",
      sourceType: "CHAT",
      sourceId: "msg-1",
      text: "Just checking in. Hope your week is going well.",
    });

    expect(result).toEqual({
      candidatesFound: 0,
      commitmentsCreated: 0,
      duplicatesSkipped: 0,
    });
    expect(mocks.upsertCommitmentMock).not.toHaveBeenCalled();
  });
});
