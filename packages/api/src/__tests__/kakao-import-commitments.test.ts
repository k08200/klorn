import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  extract: vi.fn(),
  commitmentGroupBy: vi.fn(),
  commitmentFindMany: vi.fn(),
  commitmentDeleteMany: vi.fn(),
  importFindMany: vi.fn(),
  deleteAttention: vi.fn(),
}));

vi.mock("../db.js", () => ({
  prisma: {
    commitment: {
      groupBy: mocks.commitmentGroupBy,
      findMany: mocks.commitmentFindMany,
      deleteMany: mocks.commitmentDeleteMany,
    },
    kakaoImport: { findMany: mocks.importFindMany },
  },
}));
vi.mock("../pim/commitment-ingestion.js", () => ({
  extractAndUpsertCommitmentsFromText: mocks.extract,
}));
vi.mock("../judge/attention-mirror.js", () => ({
  deleteAttentionForCommitments: mocks.deleteAttention,
}));

import {
  extractKakaoCommitments,
  kakaoImportThreadId,
  kakaoMessageIdentity,
  sweepOrphanKakaoCommitments,
} from "../kakao-import/commitments.js";

const SENT_AT = new Date("2026-11-14T12:03:00.000Z");
const MESSAGE = { speaker: "이민호", sentAt: SENT_AT, text: "금요일까지 계약서 보내드릴게요." };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.extract.mockResolvedValue({
    candidatesFound: 1,
    commitmentsCreated: 1,
    duplicatesSkipped: 0,
  });
  mocks.commitmentDeleteMany.mockImplementation(
    async ({ where }: { where: { id: { in: string[] } } }) => ({
      count: where.id.in.length,
    }),
  );
  mocks.deleteAttention.mockResolvedValue(undefined);
});

describe("kakaoMessageIdentity", () => {
  it("is the same for the same message in any upload, export format or spacing", () => {
    const id = kakaoMessageIdentity(MESSAGE);
    // A PC .csv carries seconds where a .txt export does not.
    expect(kakaoMessageIdentity({ ...MESSAGE, sentAt: new Date("2026-11-14T12:03:41.000Z") })).toBe(
      id,
    );
    expect(
      kakaoMessageIdentity({
        speaker: " 이민호 ",
        sentAt: SENT_AT,
        text: "금요일까지   계약서\n보내드릴게요. ",
      }),
    ).toBe(id);
    // NFD (as some exports write Hangul) and NFC are one message.
    expect(
      kakaoMessageIdentity({
        speaker: MESSAGE.speaker.normalize("NFD"),
        sentAt: SENT_AT,
        text: MESSAGE.text.normalize("NFD"),
      }),
    ).toBe(id);
  });

  it("differs when the speaker, the minute or the words differ", () => {
    const id = kakaoMessageIdentity(MESSAGE);
    expect(kakaoMessageIdentity({ ...MESSAGE, speaker: "김지수" })).not.toBe(id);
    expect(
      kakaoMessageIdentity({ ...MESSAGE, sentAt: new Date("2026-11-14T12:04:00.000Z") }),
    ).not.toBe(id);
    expect(kakaoMessageIdentity({ ...MESSAGE, text: "월요일까지 계약서 보내드릴게요." })).not.toBe(
      id,
    );
  });

  it("is a hash: neither the words nor the speaker appear in it", () => {
    const id = kakaoMessageIdentity(MESSAGE);
    expect(id).toMatch(/^kakao-message:[0-9a-f]{32}$/);
    expect(id).not.toContain("이민호");
  });
});

describe("extractKakaoCommitments", () => {
  it("dedups on the message's identity, so a re-import folds onto the first import's rows", async () => {
    const base = {
      userId: "user-1",
      fromMe: false,
      timeZone: "Asia/Seoul",
      credentials: {},
      maxCandidates: 2,
      ...MESSAGE,
    };
    await extractKakaoCommitments({ ...base, importId: "imp-1", seq: 4 });
    await extractKakaoCommitments({ ...base, importId: "imp-2", seq: 9 });
    const [first, second] = mocks.extract.mock.calls.map(([input]) => input);
    expect(first.dedupScope).toBe(kakaoMessageIdentity(MESSAGE));
    expect(second.dedupScope).toBe(first.dedupScope);
    // Each import still names itself on what it makes, so deleting it finds them.
    expect([first.threadId, first.sourceId]).toEqual([
      "kakao-import:imp-1",
      "kakao-import:imp-1:4",
    ]);
    expect([second.threadId, second.sourceId]).toEqual([
      "kakao-import:imp-2",
      "kakao-import:imp-2:9",
    ]);
  });
});

describe("sweepOrphanKakaoCommitments", () => {
  it("deletes the commitments and queue mirrors of imports that no longer exist", async () => {
    mocks.commitmentGroupBy.mockResolvedValue([
      { userId: "user-1", threadId: kakaoImportThreadId("live") },
      { userId: "user-1", threadId: kakaoImportThreadId("gone") },
      { userId: "user-2", threadId: kakaoImportThreadId("gone-too") },
    ]);
    mocks.importFindMany.mockResolvedValue([{ id: "live" }]);
    mocks.commitmentFindMany.mockImplementation(
      async ({ where }: { where: { userId: string; threadId: string } }) =>
        where.threadId === kakaoImportThreadId("gone")
          ? [{ id: "c1" }, { id: "c2" }]
          : [{ id: "c3" }],
    );

    expect(await sweepOrphanKakaoCommitments()).toEqual({ imports: 2, commitments: 3 });

    expect(mocks.commitmentGroupBy).toHaveBeenCalledWith({
      by: ["userId", "threadId"],
      where: { sourceType: "KAKAO", threadId: { startsWith: "kakao-import:" } },
    });
    expect(mocks.importFindMany).toHaveBeenCalledWith({
      where: { id: { in: ["live", "gone", "gone-too"] } },
      select: { id: true },
    });
    // Each deletion is scoped to the commitment's own user.
    expect(mocks.commitmentDeleteMany.mock.calls.map(([args]) => args)).toEqual([
      { where: { userId: "user-1", id: { in: ["c1", "c2"] } } },
      { where: { userId: "user-2", id: { in: ["c3"] } } },
    ]);
    expect(mocks.deleteAttention.mock.calls).toEqual([
      [["c1", "c2"], "user-1"],
      [["c3"], "user-2"],
    ]);
  });

  it("deletes nothing when every import still exists, or there are no KAKAO commitments", async () => {
    mocks.commitmentGroupBy.mockResolvedValue([
      { userId: "user-1", threadId: kakaoImportThreadId("live") },
    ]);
    mocks.importFindMany.mockResolvedValue([{ id: "live" }]);
    expect(await sweepOrphanKakaoCommitments()).toEqual({ imports: 0, commitments: 0 });

    mocks.commitmentGroupBy.mockResolvedValue([]);
    mocks.importFindMany.mockClear();
    expect(await sweepOrphanKakaoCommitments()).toEqual({ imports: 0, commitments: 0 });
    expect(mocks.importFindMany).not.toHaveBeenCalled();
    expect(mocks.commitmentDeleteMany).not.toHaveBeenCalled();
  });
});
