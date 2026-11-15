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
  const getUserTimeZoneMock = vi.fn(async (_userId: string) => "America/New_York");
  const refineMock = vi.fn(async (_input: unknown): Promise<unknown> => null);
  const refinerEnabledMock = vi.fn(() => false);
  return {
    existingDedupKeys,
    upsertCommitmentMock,
    findUniqueMock,
    getUserTimeZoneMock,
    refineMock,
    refinerEnabledMock,
  };
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

vi.mock("../user-timezone.js", () => ({
  getUserTimeZone: mocks.getUserTimeZoneMock,
}));

vi.mock("../pim/commitment-refiner.js", () => ({
  maybeRefineCommitmentCandidateWithLlm: mocks.refineMock,
  isCommitmentLlmRefinementEnabled: mocks.refinerEnabledMock,
}));

import { extractAndUpsertCommitmentsFromText } from "../pim/commitment-ingestion.js";

describe("extractAndUpsertCommitmentsFromText", () => {
  beforeEach(() => {
    mocks.existingDedupKeys.clear();
    mocks.upsertCommitmentMock.mockClear();
    mocks.findUniqueMock.mockClear();
    mocks.getUserTimeZoneMock.mockClear();
    mocks.refineMock.mockReset();
    mocks.refineMock.mockResolvedValue(null);
    mocks.refinerEnabledMock.mockReturnValue(false);
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

  it("reads a first-person promise in Slack text as the sender's, suggested not confirmed", async () => {
    await extractAndUpsertCommitmentsFromText({
      userId: "user-1",
      sourceType: "SLACK",
      sourceId: "D0DM:1763100000.000100",
      text: "내일까지 자료 보내드릴게요.",
      senderIsUser: false,
    });
    expect(mocks.upsertCommitmentMock).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ owner: "COUNTERPARTY", sourceType: "SLACK", confidence: 0.55 }),
    );
  });

  it("keeps a Slack commitment suggested even when the refiner is sure of it", async () => {
    mocks.refinerEnabledMock.mockReturnValue(true);
    mocks.refineMock.mockResolvedValue({
      isCommitment: true,
      title: "Send the deck",
      kind: "DELIVERABLE",
      owner: "COUNTERPARTY",
      counterpartyName: null,
      dueText: null,
      dueAt: null,
      confidence: 0.95,
    });
    await extractAndUpsertCommitmentsFromText({
      userId: "user-1",
      sourceType: "SLACK",
      sourceId: "D0DM:1763100000.000100",
      text: "I'll send the deck tomorrow.",
      senderIsUser: false,
    });
    const input = mocks.upsertCommitmentMock.mock.calls[0]?.[1] as { confidence: number };
    expect(input.confidence).toBeLessThan(0.7);
  });

  describe("KAKAO (imported chat export)", () => {
    const sureRefinement = {
      isCommitment: true,
      title: "견적서 보내기",
      kind: "DELIVERABLE",
      owner: "USER",
      counterpartyName: null,
      dueText: "내일",
      dueAt: null,
      confidence: 0.97,
    };

    it("reads another speaker's first-person promise as theirs, suggested", async () => {
      await extractAndUpsertCommitmentsFromText({
        userId: "user-1",
        sourceType: "KAKAO",
        sourceId: "kakao-import:imp-1:3",
        threadId: "kakao-import:imp-1",
        text: "내일까지 자료 보내드릴게요.",
        senderIsUser: false,
      });
      expect(mocks.upsertCommitmentMock).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({ owner: "COUNTERPARTY", sourceType: "KAKAO", confidence: 0.55 }),
      );
    });

    it("reads the user's own first-person promise as the user's", async () => {
      await extractAndUpsertCommitmentsFromText({
        userId: "user-1",
        sourceType: "KAKAO",
        sourceId: "kakao-import:imp-1:4",
        threadId: "kakao-import:imp-1",
        text: "내일까지 자료 보내드릴게요.",
        senderIsUser: true,
      });
      expect(mocks.upsertCommitmentMock).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({ owner: "USER", sourceType: "KAKAO" }),
      );
    });

    it("keeps a Kakao commitment below the confirmation line even when the refiner is sure", async () => {
      mocks.refinerEnabledMock.mockReturnValue(true);
      mocks.refineMock.mockResolvedValue(sureRefinement);
      await extractAndUpsertCommitmentsFromText({
        userId: "user-1",
        sourceType: "KAKAO",
        sourceId: "kakao-import:imp-1:5",
        threadId: "kakao-import:imp-1",
        text: "내일까지 견적서 보내드릴게요.",
        senderIsUser: true,
      });
      const input = mocks.upsertCommitmentMock.mock.calls[0]?.[1] as { confidence: number };
      expect(input.confidence).toBe(0.69);
    });

    it("hands the refiner the author, BYOK credentials and a ledger label", async () => {
      mocks.refinerEnabledMock.mockReturnValue(true);
      mocks.refineMock.mockResolvedValue(sureRefinement);
      const credentials = { anthropicApiKey: "sk-ant-test" };
      await extractAndUpsertCommitmentsFromText({
        userId: "user-1",
        sourceType: "KAKAO",
        sourceId: "kakao-import:imp-1:6",
        threadId: "kakao-import:imp-1",
        text: "내일까지 견적서 보내드릴게요.",
        senderIsUser: false,
        credentials,
        llmFeature: "kakao-import",
      });
      expect(mocks.refineMock).toHaveBeenCalledWith(
        expect.objectContaining({ authoredByUser: false, credentials, feature: "kakao-import" }),
      );
    });

    it("scopes dedup to the message when asked, so the same words in two messages stay two", async () => {
      const base = {
        userId: "user-1",
        sourceType: "KAKAO" as const,
        threadId: "kakao-import:imp-1",
        text: "내일까지 자료 보내드릴게요.",
        senderIsUser: false,
      };
      await extractAndUpsertCommitmentsFromText({
        ...base,
        sourceId: "kakao-import:imp-1:1",
        dedupScope: "kakao-import:imp-1:1",
      });
      await extractAndUpsertCommitmentsFromText({
        ...base,
        sourceId: "kakao-import:imp-1:7",
        dedupScope: "kakao-import:imp-1:7",
      });
      const keys = mocks.upsertCommitmentMock.mock.calls.map(
        ([, input]) => (input as { dedupKey: string; threadId: string }).dedupKey,
      );
      expect(new Set(keys).size).toBe(2);
      expect(keys[0]).toMatch(/^kakao:kakao-import:imp-1:1:/);
      const threads = mocks.upsertCommitmentMock.mock.calls.map(
        ([, input]) => (input as { threadId: string }).threadId,
      );
      expect(threads).toEqual(["kakao-import:imp-1", "kakao-import:imp-1"]);
    });

    it("tells the refiner nothing new for mail: no author line, no credentials", async () => {
      mocks.refinerEnabledMock.mockReturnValue(true);
      mocks.refineMock.mockResolvedValue(sureRefinement);
      await extractAndUpsertCommitmentsFromText({
        userId: "user-1",
        sourceType: "EMAIL",
        sourceId: "email-9",
        text: "I'll send the deck by EOD.",
        senderIsUser: false,
      });
      const refinerInput = mocks.refineMock.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(refinerInput.authoredByUser).toBeUndefined();
      expect(refinerInput.credentials).toBeUndefined();
      expect(refinerInput.feature).toBeUndefined();
    });
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

  describe("due dates", () => {
    // Thursday 2026-11-12, 10:00 in Seoul.
    const receivedAt = new Date("2026-11-12T01:00:00.000Z");

    function persisted(): { dueAt: Date | null; dueText: string | null } {
      const input = mocks.upsertCommitmentMock.mock.calls[0][1] as {
        dueAt: Date | null;
        dueText: string | null;
      };
      return { dueAt: input.dueAt, dueText: input.dueText };
    }

    it("persists dueAt resolved against the received time in the given zone", async () => {
      await extractAndUpsertCommitmentsFromText({
        userId: "user-1",
        sourceType: "EMAIL",
        sourceId: "email-1",
        text: "자료는 내일 오후 3시까지 보내드릴게요.",
        referenceDate: receivedAt,
        timeZone: "Asia/Seoul",
      });

      const { dueAt, dueText } = persisted();
      expect(dueText).toBe("내일 오후 3시");
      expect(dueAt?.toISOString()).toBe("2026-11-13T06:00:00.000Z");
      expect(mocks.getUserTimeZoneMock).not.toHaveBeenCalled();
    });

    it("reads the user's stored zone when the caller passes none", async () => {
      await extractAndUpsertCommitmentsFromText({
        userId: "user-1",
        sourceType: "EMAIL",
        sourceId: "email-1",
        text: "Thanks — I'll send the contract tomorrow.",
        referenceDate: receivedAt, // Wednesday 20:00 in New York
      });

      expect(mocks.getUserTimeZoneMock).toHaveBeenCalledWith("user-1");
      const { dueAt, dueText } = persisted();
      expect(dueText).toBe("tomorrow");
      expect(dueAt?.toISOString()).toBe("2026-11-13T04:59:00.000Z");
    });

    it("keeps the wording but leaves dueAt null for an ambiguous hour", async () => {
      await extractAndUpsertCommitmentsFromText({
        userId: "user-1",
        sourceType: "EMAIL",
        sourceId: "email-1",
        text: "내일 8시까지 보내드릴게요.",
        referenceDate: receivedAt,
        timeZone: "Asia/Seoul",
      });

      const { dueAt, dueText } = persisted();
      expect(dueText).toBe("내일 8시");
      expect(dueAt).toBeNull();
    });

    it("skips the zone lookup when no candidate states a deadline", async () => {
      await extractAndUpsertCommitmentsFromText({
        userId: "user-1",
        sourceType: "EMAIL",
        sourceId: "email-1",
        text: "I'll send the contract soon.",
        referenceDate: receivedAt,
      });

      expect(mocks.getUserTimeZoneMock).not.toHaveBeenCalled();
      expect(persisted()).toEqual({ dueAt: null, dueText: null });
    });

    it("lets the deterministic reading veto an LLM-guessed hour", async () => {
      mocks.refinerEnabledMock.mockReturnValue(true);
      mocks.refineMock.mockResolvedValue({
        isCommitment: true,
        title: "자료 보내기",
        kind: "DELIVERABLE",
        owner: "COUNTERPARTY",
        counterpartyName: null,
        dueText: "8시",
        dueAt: new Date("2026-11-12T11:00:00.000Z"), // the 20:00 guess
        confidence: 0.8,
      });

      await extractAndUpsertCommitmentsFromText({
        userId: "user-1",
        sourceType: "EMAIL",
        sourceId: "email-1",
        text: "8시까지 보내드릴게요.",
        referenceDate: receivedAt,
      });

      expect(mocks.refineMock).toHaveBeenCalledWith(
        expect.objectContaining({ timeZone: "America/New_York", referenceDate: receivedAt }),
      );
      expect(persisted()).toEqual({ dueAt: null, dueText: "8시" });
    });
  });
});
