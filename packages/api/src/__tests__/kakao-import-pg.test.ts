/**
 * Real-Postgres proof of KakaoTalk import storage
 * (docs/providers/kakaotalk-import.md §4, §5): an import's messages become
 * suggested KAKAO commitments and are deleted on processing; "delete this
 * import" removes everything it made and nothing of another user's; the 7-day
 * purge; RLS and the data-wipe fence on both tables. Skipped unless
 * KLORN_TEST_PG_URL points at a database with every migration applied.
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const url = vi.hoisted(() => {
  const value = process.env.KLORN_TEST_PG_URL;
  if (value) process.env.DATABASE_URL = value;
  return value;
});

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { prisma } from "../db.js";
import { kakaoImportThreadId } from "../kakao-import/commitments.js";
import { processNextKakaoImport } from "../kakao-import/process.js";
import {
  KAKAO_MESSAGE_RETENTION_DAYS,
  purgeExpiredKakaoImportText,
} from "../kakao-import/purge.js";
import { createKakaoImport, deleteKakaoImport } from "../kakao-import/store.js";
import { kakaoWindow } from "../kakao-import/window.js";

const describePg = url ? describe : describe.skip;
const createdUsers: string[] = [];
const DAY_MS = 86_400_000;
const ORIGINAL_ENV = { ...process.env };

async function newUser(): Promise<string> {
  const user = await prisma.user.create({ data: { email: `kakao-${randomUUID()}@test.local` } });
  createdUsers.push(user.id);
  return user.id;
}

async function newImport(userId: string) {
  const now = new Date();
  const created = await createKakaoImport({
    userId,
    format: "mobile-dotted",
    totalMessages: 3,
    speakerCount: 2,
    window: kakaoWindow(now),
    me: "김지수",
    messages: [
      {
        sentAt: new Date(now.getTime() - 2 * 3_600_000),
        speaker: "김지수",
        kind: "text",
        text: "내일까지 견적서 보내드릴게요.",
      },
      {
        sentAt: new Date(now.getTime() - 3_600_000),
        speaker: "이민호",
        kind: "text",
        text: "그럼 저는 금요일까지 계약서 보내드릴게요.",
      },
      {
        sentAt: new Date(now.getTime() - 1_800_000),
        speaker: "이민호",
        kind: "text",
        text: "감사합니다",
      },
    ],
  });
  if (!created.ok) throw new Error(`import refused: ${created.reason}`);
  return created.summary;
}

async function processAll(): Promise<void> {
  while (await processNextKakaoImport(new Date())) {
    // one import per call, as the scheduler runs it
  }
}

beforeEach(() => {
  process.env.KAKAO_IMPORT_ENABLED = "on";
  delete process.env.ROLLOUT_COHORT_USER_IDS;
  delete process.env.COMMITMENT_LLM_REFINEMENT;
  delete process.env.BACKGROUND_AGENTS_DISABLED;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV, ...(url ? { DATABASE_URL: url } : {}) };
});

afterAll(async () => {
  if (!url) return;
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
  await prisma.$disconnect();
});

describePg("KakaoTalk import storage on Postgres", () => {
  it("processes an import into suggested KAKAO commitments and deletes its text", async () => {
    const userId = await newUser();
    const created = await newImport(userId);
    expect(await prisma.kakaoImportMessage.count({ where: { importId: created.id } })).toBe(3);

    await processAll();

    const row = await prisma.kakaoImport.findUniqueOrThrow({ where: { id: created.id } });
    expect(row).toMatchObject({ status: "DONE", errorCode: null, commitmentsCreated: 2 });
    expect(await prisma.kakaoImportMessage.count({ where: { importId: created.id } })).toBe(0);
    const commitments = await prisma.commitment.findMany({
      where: { userId, threadId: kakaoImportThreadId(created.id) },
      orderBy: { createdAt: "asc" },
      select: { sourceType: true, owner: true, confidence: true, confirmedAt: true },
    });
    expect(commitments).toHaveLength(2);
    expect(commitments.map((c) => c.owner).sort()).toEqual(["COUNTERPARTY", "USER"]);
    for (const commitment of commitments) {
      expect(commitment.sourceType).toBe("KAKAO");
      expect(commitment.confidence).toBeLessThan(0.7);
      expect(commitment.confirmedAt).toBeNull();
    }
  });

  it("delete-this-import removes the import, its commitments and their queue mirrors only", async () => {
    const userId = await newUser();
    const otherId = await newUser();
    const mine = await newImport(userId);
    const keep = await newImport(userId);
    const theirs = await newImport(otherId);
    await processAll();
    const mineIds = (
      await prisma.commitment.findMany({
        where: { threadId: kakaoImportThreadId(mine.id) },
        select: { id: true },
      })
    ).map((row) => row.id);
    expect(mineIds.length).toBeGreaterThan(0);
    expect(
      await prisma.attentionItem.count({
        where: { source: "COMMITMENT", sourceId: { in: mineIds } },
      }),
    ).toBeGreaterThan(0);

    expect(await deleteKakaoImport(otherId, mine.id)).toBe(false);
    expect(await deleteKakaoImport(userId, mine.id)).toBe(true);

    expect(await prisma.kakaoImport.count({ where: { id: mine.id } })).toBe(0);
    expect(await prisma.commitment.count({ where: { id: { in: mineIds } } })).toBe(0);
    expect(
      await prisma.attentionItem.count({
        where: { source: "COMMITMENT", sourceId: { in: mineIds } },
      }),
    ).toBe(0);
    for (const other of [keep, theirs]) {
      expect(
        await prisma.commitment.count({ where: { threadId: kakaoImportThreadId(other.id) } }),
      ).toBe(2);
    }
  });

  it(`purges text older than ${KAKAO_MESSAGE_RETENTION_DAYS} days and expires the waiting import`, async () => {
    process.env.KAKAO_IMPORT_ENABLED = "off";
    const userId = await newUser();
    const old = await newImport(userId);
    const young = await newImport(userId);
    const longAgo = new Date(Date.now() - (KAKAO_MESSAGE_RETENTION_DAYS + 1) * DAY_MS);
    await prisma.kakaoImportMessage.updateMany({
      where: { importId: old.id },
      data: { createdAt: longAgo },
    });
    await prisma.kakaoImport.update({ where: { id: old.id }, data: { createdAt: longAgo } });

    const purged = await purgeExpiredKakaoImportText(new Date());

    expect(purged.messages).toBeGreaterThanOrEqual(3);
    expect(await prisma.kakaoImportMessage.count({ where: { importId: old.id } })).toBe(0);
    expect(await prisma.kakaoImportMessage.count({ where: { importId: young.id } })).toBe(3);
    expect(await prisma.kakaoImport.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({
      status: "FAILED",
      errorCode: "expired",
    });
    expect(await prisma.kakaoImport.findUniqueOrThrow({ where: { id: young.id } })).toMatchObject({
      status: "PENDING",
    });
    await prisma.kakaoImport.deleteMany({ where: { userId } });
  });

  it("has row-level security and the data-wipe fence on both tables", async () => {
    const rls = await prisma.$queryRaw<Array<{ relname: string; relrowsecurity: boolean }>>`
      SELECT relname, relrowsecurity FROM pg_class
      WHERE relname IN ('KakaoImport', 'KakaoImportMessage') ORDER BY relname`;
    expect(rls).toEqual([
      { relname: "KakaoImport", relrowsecurity: true },
      { relname: "KakaoImportMessage", relrowsecurity: true },
    ]);
    const triggers = await prisma.$queryRaw<Array<{ tgname: string }>>`
      SELECT tgname FROM pg_trigger
      WHERE tgname IN ('KakaoImport_data_wipe_fence', 'KakaoImportMessage_data_wipe_fence')
      ORDER BY tgname`;
    expect(triggers.map((t) => t.tgname)).toEqual([
      "KakaoImportMessage_data_wipe_fence",
      "KakaoImport_data_wipe_fence",
    ]);
  });
});
