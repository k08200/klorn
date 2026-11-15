import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  createMany: vi.fn(),
  deleteMany: vi.fn(),
  commitmentFindMany: vi.fn(),
  commitmentDeleteMany: vi.fn(),
  deleteAttention: vi.fn(),
}));

vi.mock("../db.js", () => {
  const tx = {
    kakaoImport: { create: mocks.create },
    kakaoImportMessage: { createMany: mocks.createMany },
  };
  return {
    INTERACTIVE_TX_OPTIONS: {},
    prisma: {
      kakaoImport: { count: mocks.count, findFirst: mocks.findFirst, deleteMany: mocks.deleteMany },
      commitment: { findMany: mocks.commitmentFindMany, deleteMany: mocks.commitmentDeleteMany },
      $transaction: (run: (client: typeof tx) => Promise<unknown>) => run(tx),
    },
  };
});
vi.mock("../judge/attention-mirror.js", () => ({
  deleteAttentionForCommitments: mocks.deleteAttention,
}));

import { kakaoImportThreadId } from "../kakao-import/commitments.js";
import {
  createKakaoImport,
  deleteKakaoImport,
  KAKAO_MAX_ACTIVE_IMPORTS_PER_USER,
  KAKAO_MAX_IMPORTS_PER_USER,
} from "../kakao-import/store.js";

const window = {
  start: new Date("2026-10-16T03:00:00.000Z"),
  end: new Date("2026-11-16T03:00:00.000Z"),
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "imp-1",
    status: "PENDING",
    format: "mobile-dotted",
    totalMessages: 10,
    windowMessages: 2,
    speakerCount: 2,
    windowStart: window.start,
    windowEnd: window.end,
    candidatesFound: 0,
    commitmentsCreated: 0,
    duplicatesSkipped: 0,
    errorCode: null,
    createdAt: new Date("2026-11-15T03:00:00.000Z"),
    processedAt: null,
    ...overrides,
  };
}

const messages = [
  {
    sentAt: new Date("2026-11-14T00:00:00.000Z"),
    speaker: "김지수",
    kind: "text" as const,
    text: "a",
  },
  {
    sentAt: new Date("2026-11-14T00:01:00.000Z"),
    speaker: "이민호",
    kind: "text" as const,
    text: "b",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.count.mockResolvedValue(0);
  mocks.findFirst.mockResolvedValue({ id: "imp-1" });
  mocks.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    row({ status: data.status, processedAt: data.processedAt }),
  );
  mocks.createMany.mockResolvedValue({ count: 2 });
  mocks.deleteMany.mockResolvedValue({ count: 1 });
  mocks.commitmentFindMany.mockResolvedValue([{ id: "c-1" }, { id: "c-2" }]);
  mocks.commitmentDeleteMany.mockResolvedValue({ count: 2 });
});

describe("createKakaoImport", () => {
  const base = {
    userId: "user-1",
    format: "mobile-dotted" as const,
    totalMessages: 10,
    speakerCount: 2,
    window,
    me: "김지수",
  };

  it("stores the import and each in-window message, marking the user's own", async () => {
    const result = await createKakaoImport({ ...base, messages });
    expect(result.ok && result.summary).toMatchObject({
      id: "imp-1",
      status: "PENDING",
      windowStart: window.start.toISOString(),
    });
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: "user-1", status: "PENDING", windowMessages: 2 }),
      }),
    );
    expect(mocks.createMany).toHaveBeenCalledWith({
      data: [
        {
          userId: "user-1",
          importId: "imp-1",
          seq: 0,
          sentAt: messages[0].sentAt,
          speaker: "김지수",
          fromMe: true,
          text: "a",
        },
        {
          userId: "user-1",
          importId: "imp-1",
          seq: 1,
          sentAt: messages[1].sentAt,
          speaker: "이민호",
          fromMe: false,
          text: "b",
        },
      ],
    });
  });

  it("stores no file name, chat title or speaker list on the import row", async () => {
    await createKakaoImport({ ...base, messages });
    const { data } = mocks.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(Object.keys(data).sort()).toEqual(
      [
        "format",
        "processedAt",
        "speakerCount",
        "status",
        "totalMessages",
        "userId",
        "windowEnd",
        "windowMessages",
        "windowStart",
      ].sort(),
    );
  });

  it("finishes an import with nothing in its window at once, storing no text", async () => {
    const result = await createKakaoImport({ ...base, messages: [] });
    expect(result.ok && result.summary.status).toBe("DONE");
    expect(result.ok && result.summary.processedAt).not.toBeNull();
    expect(mocks.createMany).not.toHaveBeenCalled();
  });

  it(`refuses a ${KAKAO_MAX_IMPORTS_PER_USER + 1}th kept import`, async () => {
    mocks.count.mockResolvedValue(KAKAO_MAX_IMPORTS_PER_USER);
    expect(await createKakaoImport({ ...base, messages })).toEqual({
      ok: false,
      reason: "too-many-imports",
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it(`refuses a new import while ${KAKAO_MAX_ACTIVE_IMPORTS_PER_USER} are still waiting or being read`, async () => {
    // Kept and active both read as 2: under the kept cap, at the active one.
    mocks.count.mockResolvedValue(KAKAO_MAX_ACTIVE_IMPORTS_PER_USER);
    expect(await createKakaoImport({ ...base, messages })).toEqual({
      ok: false,
      reason: "import-in-progress",
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe("deleteKakaoImport", () => {
  it("deletes every commitment the import made and their queue mirrors, then the import", async () => {
    expect(await deleteKakaoImport("user-1", "imp-1")).toBe(true);
    expect(mocks.deleteMany).toHaveBeenCalledWith({ where: { id: "imp-1", userId: "user-1" } });
    expect(mocks.commitmentDeleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteMany.mock.invocationCallOrder[0],
    );
    expect(mocks.commitmentFindMany).toHaveBeenCalledWith({
      where: { userId: "user-1", sourceType: "KAKAO", threadId: kakaoImportThreadId("imp-1") },
      select: { id: true },
    });
    expect(mocks.commitmentDeleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", id: { in: ["c-1", "c-2"] } },
    });
    expect(mocks.deleteAttention).toHaveBeenCalledWith(["c-1", "c-2"], "user-1");
  });

  it("touches nothing for an import that is not the user's", async () => {
    mocks.findFirst.mockResolvedValue(null);
    expect(await deleteKakaoImport("user-2", "imp-1")).toBe(false);
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { id: "imp-1", userId: "user-2" },
      select: { id: true },
    });
    expect(mocks.commitmentFindMany).not.toHaveBeenCalled();
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it("keeps the import when deleting its commitments fails, so the user can retry", async () => {
    mocks.commitmentDeleteMany.mockRejectedValue(new Error("db down"));
    await expect(deleteKakaoImport("user-1", "imp-1")).rejects.toThrow("db down");
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });
});
