import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  importFindFirst: vi.fn(),
  importFindUnique: vi.fn(),
  importUpdateMany: vi.fn(),
  messageFindMany: vi.fn(),
  messageDeleteMany: vi.fn(),
  extract: vi.fn(),
  deleteCommitments: vi.fn(),
  sweepOrphans: vi.fn(),
  timeZone: vi.fn(async () => "Asia/Seoul"),
  credentials: vi.fn(async () => ({ anthropicApiKey: "sk-ant-user" })),
  backgroundDisabled: vi.fn(() => false),
  captureError: vi.fn(),
}));

vi.mock("../db.js", () => ({
  INTERACTIVE_TX_OPTIONS: {},
  prisma: {
    kakaoImport: {
      findFirst: mocks.importFindFirst,
      findUnique: mocks.importFindUnique,
      updateMany: mocks.importUpdateMany,
    },
    kakaoImportMessage: { findMany: mocks.messageFindMany, deleteMany: mocks.messageDeleteMany },
    $transaction: async (run: (tx: unknown) => Promise<unknown>) =>
      run({
        kakaoImport: { updateMany: mocks.importUpdateMany },
        kakaoImportMessage: { deleteMany: mocks.messageDeleteMany },
      }),
  },
}));
vi.mock("../kakao-import/commitments.js", () => ({
  extractKakaoCommitments: mocks.extract,
  deleteKakaoImportCommitments: mocks.deleteCommitments,
  sweepOrphanKakaoCommitments: mocks.sweepOrphans,
}));
vi.mock("../user-timezone.js", () => ({ getUserTimeZone: mocks.timeZone }));
vi.mock("../llm/llm-credentials.js", () => ({ getUserLlmCredentials: mocks.credentials }));
vi.mock("../scheduler-heartbeat.js", () => ({
  isBackgroundAgentsDisabled: mocks.backgroundDisabled,
  recordSchedulerTick: vi.fn(),
  registerScheduler: vi.fn(),
}));
vi.mock("../sentry.js", () => ({ captureError: mocks.captureError }));

import {
  KAKAO_ERROR_FAILED,
  KAKAO_ERROR_PARTIAL,
  KAKAO_MAX_CANDIDATES_PER_IMPORT,
  KAKAO_PROCESS_TIME_BUDGET_MS,
  KAKAO_STALE_CLAIM_MS,
  processKakaoImport,
  processNextKakaoImport,
} from "../kakao-import/process.js";
import {
  KAKAO_MESSAGE_RETENTION_DAYS,
  purgeExpiredKakaoImportText,
} from "../kakao-import/purge.js";
import { kakaoSchedulerTick, resetKakaoSchedulerState } from "../kakao-import/scheduler.js";

const NOW = new Date("2026-11-15T03:00:00.000Z");
const ORIGINAL_ENV = { ...process.env };

function storedMessages(count: number) {
  return Array.from({ length: count }, (_, seq) => ({
    seq,
    sentAt: new Date(NOW.getTime() - (count - seq) * 60_000),
    speaker: seq % 2 === 0 ? "김지수" : "이민호",
    fromMe: seq % 2 === 0,
    text: `메시지 ${seq}: 내일까지 보내드릴게요`,
  }));
}

function settledData(): Record<string, unknown> {
  const call = mocks.importUpdateMany.mock.calls.find(
    ([args]) => (args as { where: { status?: string } }).where.status === "PROCESSING",
  );
  return (call?.[0] as { data: Record<string, unknown> }).data;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.KAKAO_IMPORT_ENABLED = "on";
  delete process.env.ROLLOUT_COHORT_USER_IDS;
  mocks.importFindFirst.mockResolvedValue({ id: "imp-1", userId: "user-1" });
  mocks.importFindUnique.mockResolvedValue({ id: "imp-1" });
  mocks.importUpdateMany.mockResolvedValue({ count: 1 });
  mocks.messageFindMany.mockResolvedValue(storedMessages(3));
  mocks.messageDeleteMany.mockResolvedValue({ count: 3 });
  mocks.extract.mockResolvedValue({
    candidatesFound: 1,
    commitmentsCreated: 1,
    duplicatesSkipped: 0,
  });
  mocks.deleteCommitments.mockResolvedValue(0);
  mocks.sweepOrphans.mockResolvedValue({ imports: 0, commitments: 0 });
  mocks.backgroundDisabled.mockReturnValue(false);
  resetKakaoSchedulerState();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("processNextKakaoImport", () => {
  it("does nothing while the flag is off", async () => {
    process.env.KAKAO_IMPORT_ENABLED = "off";
    expect(await processNextKakaoImport(NOW)).toBe(false);
    expect(mocks.importFindFirst).not.toHaveBeenCalled();
  });

  it("stands down under BACKGROUND_AGENTS_DISABLED", async () => {
    mocks.backgroundDisabled.mockReturnValue(true);
    expect(await processNextKakaoImport(NOW)).toBe(false);
    expect(mocks.importFindFirst).not.toHaveBeenCalled();
  });

  it("in cohort mode, only reaches the cohort's imports", async () => {
    process.env.KAKAO_IMPORT_ENABLED = "cohort";
    process.env.ROLLOUT_COHORT_USER_IDS = "user-1,user-2";
    await processNextKakaoImport(NOW);
    expect(mocks.importFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: { in: ["user-1", "user-2"] } }),
      }),
    );
  });

  it("in cohort mode with an empty cohort, reaches no one", async () => {
    process.env.KAKAO_IMPORT_ENABLED = "cohort";
    expect(await processNextKakaoImport(NOW)).toBe(false);
    expect(mocks.importFindFirst).not.toHaveBeenCalled();
  });

  it("takes over a PROCESSING claim only once it is stale", async () => {
    await processNextKakaoImport(NOW);
    const [args] = mocks.importFindFirst.mock.calls[0] as [{ where: { OR: unknown[] } }];
    expect(args.where.OR).toEqual([
      { status: "PENDING" },
      { status: "PROCESSING", claimedAt: { lt: new Date(NOW.getTime() - KAKAO_STALE_CLAIM_MS) } },
    ]);
  });

  it("leaves an import another instance claimed first", async () => {
    mocks.importUpdateMany.mockResolvedValueOnce({ count: 0 });
    expect(await processNextKakaoImport(NOW)).toBe(false);
    expect(mocks.messageFindMany).not.toHaveBeenCalled();
  });

  it("claims, extracts every message with its author, settles DONE and deletes the text", async () => {
    expect(await processNextKakaoImport(NOW)).toBe(true);
    expect(mocks.importUpdateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ data: { status: "PROCESSING", claimedAt: NOW } }),
    );
    expect(mocks.extract).toHaveBeenCalledTimes(3);
    expect(mocks.extract).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        userId: "user-1",
        importId: "imp-1",
        seq: 1,
        speaker: "이민호",
        fromMe: false,
        timeZone: "Asia/Seoul",
        credentials: { anthropicApiKey: "sk-ant-user" },
        maxCandidates: 2,
      }),
    );
    expect(settledData()).toMatchObject({
      status: "DONE",
      candidatesFound: 3,
      commitmentsCreated: 3,
      duplicatesSkipped: 0,
      errorCode: null,
    });
    expect(mocks.messageDeleteMany).toHaveBeenCalledWith({
      where: { importId: "imp-1", userId: "user-1" },
    });
    expect(mocks.deleteCommitments).not.toHaveBeenCalled();
  });
});

describe("processKakaoImport", () => {
  const claim = { importId: "imp-1", userId: "user-1", claimedAt: NOW };
  const none = { candidatesFound: 0, commitmentsCreated: 0, duplicatesSkipped: 0 };

  it("reads the newest messages first", async () => {
    mocks.messageFindMany.mockResolvedValue(storedMessages(3).reverse());
    await processKakaoImport(claim);
    expect(mocks.messageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { seq: "desc" } }),
    );
    expect((mocks.extract.mock.calls[0][0] as { seq: number }).seq).toBe(2);
  });

  it("settles only the claim it holds", async () => {
    await processKakaoImport(claim);
    expect(mocks.importUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "imp-1", userId: "user-1", status: "PROCESSING", claimedAt: NOW },
      }),
    );
  });

  it(`stops at ${KAKAO_MAX_CANDIDATES_PER_IMPORT} candidates and settles it as partial`, async () => {
    mocks.messageFindMany.mockResolvedValue(storedMessages(100));
    mocks.extract.mockImplementation(async (input: { maxCandidates: number }) => ({
      candidatesFound: input.maxCandidates,
      commitmentsCreated: input.maxCandidates,
      duplicatesSkipped: 0,
    }));
    await processKakaoImport(claim);
    expect(mocks.extract).toHaveBeenCalledTimes(KAKAO_MAX_CANDIDATES_PER_IMPORT / 2);
    expect(settledData()).toMatchObject({
      candidatesFound: KAKAO_MAX_CANDIDATES_PER_IMPORT,
      errorCode: KAKAO_ERROR_PARTIAL,
    });
  });

  it("never asks for more candidates than the import has left", async () => {
    mocks.messageFindMany.mockResolvedValue(storedMessages(60));
    mocks.extract.mockResolvedValue({
      candidatesFound: 3,
      commitmentsCreated: 0,
      duplicatesSkipped: 3,
    });
    await processKakaoImport(claim);
    const asked = mocks.extract.mock.calls.map(
      ([input]) => (input as { maxCandidates: number }).maxCandidates,
    );
    // 13 messages of 3 leave 1 of the 40.
    expect(asked.at(-1)).toBe(1);
  });

  it("stops when the pass runs past its time budget, and says partial", async () => {
    let now = NOW.getTime();
    mocks.extract.mockImplementation(async () => {
      now += KAKAO_PROCESS_TIME_BUDGET_MS;
      return none;
    });
    await processKakaoImport(claim, () => now);
    expect(mocks.extract).toHaveBeenCalledTimes(2);
    expect(settledData()).toMatchObject({ status: "DONE", errorCode: KAKAO_ERROR_PARTIAL });
  });

  it("keeps going past one failed message, keeping the counts, and says partial", async () => {
    mocks.extract
      .mockResolvedValueOnce({ candidatesFound: 1, commitmentsCreated: 1, duplicatesSkipped: 0 })
      .mockRejectedValueOnce(new Error("upstream said: 내일까지 보내드릴게요"))
      .mockResolvedValueOnce({ candidatesFound: 1, commitmentsCreated: 1, duplicatesSkipped: 0 });
    await processKakaoImport(claim);
    expect(mocks.extract).toHaveBeenCalledTimes(3);
    expect(settledData()).toMatchObject({
      status: "DONE",
      commitmentsCreated: 2,
      errorCode: KAKAO_ERROR_PARTIAL,
    });
  });

  it("reports a failure to Sentry by name only, never the message text", async () => {
    mocks.extract.mockRejectedValueOnce(new Error("upstream said: 내일까지 보내드릴게요"));
    await processKakaoImport(claim);
    const [error, context] = mocks.captureError.mock.calls[0] as [Error, { extra: object }];
    expect(error.message).toBe("kakao-import: Error");
    expect(JSON.stringify(context)).not.toContain("보내드릴게요");
  });

  it("stops after repeated failures in a row", async () => {
    mocks.messageFindMany.mockResolvedValue(storedMessages(30));
    mocks.extract.mockRejectedValue(new Error("db down"));
    await processKakaoImport(claim);
    expect(mocks.extract).toHaveBeenCalledTimes(5);
    expect(settledData()).toMatchObject({ status: "DONE", errorCode: KAKAO_ERROR_PARTIAL });
  });

  it("records FAILED when it cannot even load the import, and still deletes the text", async () => {
    mocks.messageFindMany.mockRejectedValueOnce(new Error("db down"));
    await processKakaoImport(claim);
    expect(settledData()).toEqual({
      status: "FAILED",
      errorCode: KAKAO_ERROR_FAILED,
      claimedAt: null,
    });
    expect(mocks.messageDeleteMany).toHaveBeenCalledWith({
      where: { importId: "imp-1", userId: "user-1" },
    });
  });

  it("deletes what it made when the user deleted the import mid-run", async () => {
    mocks.importUpdateMany.mockResolvedValue({ count: 0 });
    mocks.importFindUnique.mockResolvedValue(null);
    await processKakaoImport(claim);
    expect(mocks.deleteCommitments).toHaveBeenCalledWith("user-1", "imp-1");
  });

  it("leaves an import another pass took over (or the purge expired) alone", async () => {
    mocks.importUpdateMany.mockResolvedValue({ count: 0 });
    await processKakaoImport(claim);
    expect(mocks.deleteCommitments).not.toHaveBeenCalled();
    expect(mocks.messageDeleteMany).not.toHaveBeenCalled();
  });

  it("checks the import still exists after every message that had a candidate", async () => {
    mocks.extract.mockResolvedValueOnce({
      candidatesFound: 1,
      commitmentsCreated: 1,
      duplicatesSkipped: 0,
    });
    mocks.extract.mockResolvedValue(none);
    mocks.importFindUnique.mockResolvedValue(null);
    await processKakaoImport(claim);
    expect(mocks.extract).toHaveBeenCalledTimes(1);
    expect(mocks.deleteCommitments).toHaveBeenCalledWith("user-1", "imp-1");
  });

  it("yields to the event loop while it works, so a long pass cannot hold it", async () => {
    mocks.messageFindMany.mockResolvedValue(storedMessages(100));
    mocks.extract.mockResolvedValue(none);
    let callsWhenOtherWorkRan = -1;
    setImmediate(() => {
      callsWhenOtherWorkRan = mocks.extract.mock.calls.length;
    });
    await processKakaoImport(claim);
    expect(callsWhenOtherWorkRan).toBeGreaterThan(0);
    expect(callsWhenOtherWorkRan).toBeLessThan(100);
  });

  it("checks the import still exists every 25 messages otherwise", async () => {
    mocks.messageFindMany.mockResolvedValue(storedMessages(120));
    mocks.extract.mockResolvedValue(none);
    mocks.importFindUnique.mockResolvedValue(null);
    await processKakaoImport(claim);
    expect(mocks.extract).toHaveBeenCalledTimes(25);
    expect(mocks.deleteCommitments).toHaveBeenCalledWith("user-1", "imp-1");
  });
});

describe("purgeExpiredKakaoImportText", () => {
  it(`deletes text older than ${KAKAO_MESSAGE_RETENTION_DAYS} days and expires imports still waiting`, async () => {
    mocks.messageDeleteMany.mockResolvedValue({ count: 12 });
    mocks.importUpdateMany.mockResolvedValue({ count: 2 });
    const cutoff = new Date(NOW.getTime() - KAKAO_MESSAGE_RETENTION_DAYS * 86_400_000);
    expect(await purgeExpiredKakaoImportText(NOW)).toEqual({ messages: 12, expired: 2 });
    expect(mocks.messageDeleteMany).toHaveBeenCalledWith({ where: { createdAt: { lt: cutoff } } });
    expect(mocks.importUpdateMany).toHaveBeenCalledWith({
      where: { status: { in: ["PENDING", "PROCESSING"] }, createdAt: { lt: cutoff } },
      data: { status: "FAILED", errorCode: "expired", claimedAt: null },
    });
  });
});

describe("kakaoSchedulerTick", () => {
  const lease = {
    runExclusive: vi.fn(async (work: () => Promise<void>) => {
      await work();
      return true;
    }),
  };

  it("purges even while the flag is off, and processes nothing", async () => {
    process.env.KAKAO_IMPORT_ENABLED = "off";
    mocks.messageDeleteMany.mockResolvedValue({ count: 0 });
    mocks.importUpdateMany.mockResolvedValue({ count: 0 });
    await kakaoSchedulerTick(NOW, lease);
    expect(mocks.messageDeleteMany).toHaveBeenCalledTimes(1);
    expect(mocks.importFindFirst).not.toHaveBeenCalled();
  });

  it("sweeps commitments of deleted imports with the purge, even while the flag is off", async () => {
    process.env.KAKAO_IMPORT_ENABLED = "off";
    mocks.messageDeleteMany.mockResolvedValue({ count: 0 });
    mocks.importUpdateMany.mockResolvedValue({ count: 0 });
    mocks.sweepOrphans.mockResolvedValue({ imports: 1, commitments: 2 });
    await kakaoSchedulerTick(NOW, lease);
    expect(mocks.sweepOrphans).toHaveBeenCalledTimes(1);
    // On the purge's interval, not every tick.
    await kakaoSchedulerTick(new Date(NOW.getTime() + 30_000), lease);
    expect(mocks.sweepOrphans).toHaveBeenCalledTimes(1);
    expect(mocks.captureError).not.toHaveBeenCalled();
  });

  it("touches no database between purges while the flag is off", async () => {
    process.env.KAKAO_IMPORT_ENABLED = "off";
    mocks.messageDeleteMany.mockResolvedValue({ count: 0 });
    mocks.importUpdateMany.mockResolvedValue({ count: 0 });
    await kakaoSchedulerTick(NOW, lease);
    lease.runExclusive.mockClear();
    await kakaoSchedulerTick(new Date(NOW.getTime() + 30_000), lease);
    expect(lease.runExclusive).not.toHaveBeenCalled();
  });

  it("processes a waiting import on every tick while the flag is on", async () => {
    await kakaoSchedulerTick(NOW, lease);
    await kakaoSchedulerTick(new Date(NOW.getTime() + 30_000), lease);
    expect(mocks.importFindFirst).toHaveBeenCalledTimes(2);
  });
});
