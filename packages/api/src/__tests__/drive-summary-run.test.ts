/**
 * D4: the summary queue (drive/summary-store.ts), one run of a claimed row
 * (drive/summary-run.ts) and the job (drive/summary-job.ts), over a fake database
 * that evaluates each `where` and the in-memory object store. The model is a
 * stub here (drive-summary-llm.test.ts covers the call itself;
 * drive-summary-failing-provider.test.ts runs the real LLM layer).
 *
 * What is proved: a file is queued at its version and re-queued only when that
 * changes; every query is scoped to its user; the byte cap holds while the file
 * streams; a cost cap or a daily cap leaves the summary PENDING (never FAILED);
 * an outage retries with backoff and gives up as FAILED; the job does nothing
 * while the flag is off.
 */

import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
const llm = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  result: null as unknown,
}));

vi.mock("../db.js", async () => {
  const { fakePrismaClient: client } = await import("./helpers/fake-db.js");
  const prisma = client(() => dbHolder.current as FakeDb);
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../drive/summary-llm.js", () => ({
  summariseDriveText: vi.fn(async (input: Record<string, unknown>) => {
    llm.calls.push(input);
    return llm.result;
  }),
}));

import { runDriveSummarySweep } from "../drive/summary-job.js";
import {
  DRIVE_SUMMARIES_PER_USER_PER_DAY,
  DRIVE_SUMMARY_LEASE_MS,
  DRIVE_SUMMARY_MAX_ATTEMPTS,
  DRIVE_SUMMARY_MAX_SOURCE_BYTES,
  DRIVE_SUMMARY_OUTAGE_MAX_MS,
  DRIVE_SUMMARY_RETRY_BASE_MS,
  DRIVE_SUMMARY_RUNS_PER_FILE_PER_DAY,
} from "../drive/summary-policy.js";
import { runClaimedSummary } from "../drive/summary-run.js";
import {
  claimSummary,
  countFileRun,
  enqueueDriveFileSummary,
  findSummaryRow,
  reserveUserSummary,
  type SummaryLease,
  userDailyCountSpent,
} from "../drive/summary-store.js";
import { allowAnyContentType } from "../storage/limits.js";
import { MemoryObjectStore } from "../storage/memory-store.js";
import type { ObjectStore } from "../storage/object-store.js";
import { getUserStorage, setObjectStoreForTests } from "../storage/runtime.js";

const ME = "user-1";
const OTHER = "user-2";
const NOW = new Date("2026-10-14T10:00:00.000Z");
const TOMORROW = new Date("2026-10-15T00:00:00.000Z");
const FLAGS = [
  "DRIVE_ENABLED",
  "KLORN_DRIVE_ENABLED",
  "OBJECT_STORAGE_ENABLED",
  "DRIVE_SUMMARIES_ENABLED",
];
const DONE = {
  ok: true,
  summary: "Minutes of the design review.",
  model: "google/gemini-2.5-flash",
  costMicroCents: 1_234,
};

let db: FakeDb;
let store: MemoryObjectStore;
let seq = 0;

function fileRow(over: Row = {}): Row {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    userId: ME,
    provider: "KLORN",
    sourceKey: "klorn",
    externalId: `ext-${seq}`,
    name: `notes ${seq}.txt`,
    mimeType: "text/plain",
    isFolder: false,
    sizeBytes: 20n,
    modifiedAt: NOW,
    storageKey: null,
    etag: `sha256:${seq}`,
    ...over,
  };
}

/** A Klorn file of `userId` whose bytes are in the store. */
async function storedFile(text: string, over: Row = {}, userId = ME): Promise<Row> {
  const storage = await getUserStorage();
  const bytes = Buffer.from(text, "utf8");
  const meta = await storage?.put(userId, "drive", bytes, {
    contentType: "text/plain",
    size: bytes.length,
    contentTypePolicy: allowAnyContentType,
  });
  const row = fileRow({ userId, storageKey: meta?.key, sizeBytes: BigInt(bytes.length), ...over });
  db.tables.driveFile.push(row);
  return row;
}

async function queued(row: Row, now = NOW) {
  return await enqueueDriveFileSummary(
    row.userId as string,
    row.id as string,
    row.etag as string,
    {},
    now,
  );
}

const summaryOf = (fileId: unknown) =>
  db.tables.driveFileSummary.find((r) => r.driveFileId === fileId);

beforeEach(() => {
  for (const flag of FLAGS) vi.stubEnv(flag, "true");
  db = createFakeDb({ driveFile: [], driveFileSummary: [], driveSummaryUsage: [] });
  dbHolder.current = db;
  store = new MemoryObjectStore();
  setObjectStoreForTests(store);
  llm.calls.length = 0;
  llm.result = DONE;
});

afterEach(() => {
  vi.unstubAllEnvs();
  setObjectStoreForTests(null);
});

describe("the queue: one row per file, at the file's version", () => {
  it("queues a new file PENDING, due now, at its etag", async () => {
    const file = await storedFile("hello");
    const row = await queued(file);
    expect(row).toMatchObject({ status: "PENDING", sourceEtag: file.etag, attempts: 0 });
    expect(summaryOf(file.id)).toMatchObject({ userId: ME, nextAttemptAt: NOW });
  });

  it("leaves a summary of the same version alone, and re-queues a changed file", async () => {
    const file = await storedFile("hello");
    await queued(file);
    Object.assign(summaryOf(file.id) as Row, { status: "DONE", summary: "old", model: "m" });
    await queued(file);
    expect(summaryOf(file.id)).toMatchObject({ status: "DONE", summary: "old" });

    await enqueueDriveFileSummary(ME, file.id as string, "sha256:changed", {}, NOW);
    expect(summaryOf(file.id)).toMatchObject({
      status: "PENDING",
      summary: null,
      model: null,
      sourceEtag: "sha256:changed",
      attempts: 0,
    });
  });

  it("re-queues a FAILED summary only when asked (on demand)", async () => {
    const file = await storedFile("hello");
    await queued(file);
    Object.assign(summaryOf(file.id) as Row, {
      status: "FAILED",
      error: "llm-unavailable",
      attempts: 5,
    });
    await queued(file);
    expect(summaryOf(file.id)).toMatchObject({ status: "FAILED" });
    await enqueueDriveFileSummary(
      ME,
      file.id as string,
      file.etag as string,
      { retryFailed: true },
      NOW,
    );
    expect(summaryOf(file.id)).toMatchObject({ status: "PENDING", error: null, attempts: 0 });
  });

  it("is scoped to its user: another user's file is neither found nor queued", async () => {
    const theirs = await storedFile("theirs", {}, OTHER);
    await queued(theirs);
    expect(await findSummaryRow(ME, theirs.id as string)).toBeNull();
    await expect(
      enqueueDriveFileSummary(ME, theirs.id as string, "sha256:x", {}, NOW),
    ).rejects.toThrow();
    expect(summaryOf(theirs.id)).toMatchObject({ userId: OTHER, sourceEtag: theirs.etag });
  });

  it("the user's daily count: the reservation that passes the count is refused", async () => {
    db.tables.driveSummaryUsage.push({
      userId: ME,
      dayKey: "2026-10-14",
      count: DRIVE_SUMMARIES_PER_USER_PER_DAY - 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(await userDailyCountSpent(ME, NOW)).toBe(false);
    expect(await reserveUserSummary(ME, NOW)).toBe(true);
    expect(await userDailyCountSpent(ME, NOW)).toBe(true);
    expect(await reserveUserSummary(ME, NOW)).toBe(false);
    expect(await userDailyCountSpent(OTHER, NOW)).toBe(false);
  });

  it("a claim holds the row for the lease and counts an attempt; a second claimant gets nothing", async () => {
    const file = await storedFile("hello");
    const row = await queued(file);
    expect(await claimSummary(row, NOW)).not.toBeNull();
    expect(await claimSummary(row, NOW)).toBeNull();
    expect(summaryOf(file.id)).toMatchObject({
      nextAttemptAt: new Date(NOW.getTime() + DRIVE_SUMMARY_LEASE_MS),
      attempts: 1,
    });
  });

  it("a first enqueue that loses the insert race (P2002) answers the winner's row", async () => {
    const file = await storedFile("hello");
    await queued(file);
    const summaries = db.model("driveFileSummary");
    vi.spyOn(summaries, "upsert").mockRejectedValueOnce(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );
    const row = await queued(file);
    expect(row).toMatchObject({ driveFileId: file.id, userId: ME, status: "PENDING" });
  });

  it("the per-file count is taken atomically: a stale snapshot cannot pass the cap", async () => {
    const file = await storedFile("hello");
    await queued(file);
    Object.assign(summaryOf(file.id) as Row, {
      runsDayKey: "2026-10-14",
      runsToday: DRIVE_SUMMARY_RUNS_PER_FILE_PER_DAY - 1,
    });
    const lease = await leaseOf(file);
    expect(await countFileRun(lease, NOW)).toBe(true);
    // The same snapshot again, as a second process holding it would.
    expect(await countFileRun(lease, NOW)).toBe(false);
    expect(summaryOf(file.id)?.runsToday).toBe(DRIVE_SUMMARY_RUNS_PER_FILE_PER_DAY);
  });
});

async function leaseOf(file: Row, now = NOW): Promise<SummaryLease> {
  const row = await findSummaryRow(file.userId as string, file.id as string);
  if (row === null) throw new Error("no row");
  const lease = await claimSummary(row, now);
  if (lease === null) throw new Error("not claimed");
  return lease;
}

async function runOne(file: Row, now = NOW) {
  await queued(file, now);
  return await runClaimedSummary(await leaseOf(file, now), { priority: "background", now });
}

const runLease = (lease: SummaryLease, now = NOW) =>
  runClaimedSummary(lease, { priority: "background", now });

describe("one run", () => {
  it("summarises the extracted text and records the summary, its version, model and cost", async () => {
    const file = await storedFile("Design review minutes: ship D4 on Friday.");
    expect(await runOne(file)).toBe("done");
    expect(llm.calls).toEqual([
      {
        userId: ME,
        name: file.name,
        mimeType: "text/plain",
        text: "Design review minutes: ship D4 on Friday.",
        priority: "background",
      },
    ]);
    expect(summaryOf(file.id)).toMatchObject({
      status: "DONE",
      summary: DONE.summary,
      model: DONE.model,
      costMicroCents: 1_234,
      sourceEtag: file.etag,
      error: null,
      summarizedAt: NOW,
      runsDayKey: "2026-10-14",
      runsToday: 1,
    });
    expect(db.tables.driveSummaryUsage).toEqual([
      expect.objectContaining({ userId: ME, dayKey: "2026-10-14", count: 1 }),
    ]);
  });

  it("skips a folder and an unsupported type without reading any bytes", async () => {
    const getObject = vi.spyOn(store, "getObject");
    const folder = fileRow({ isFolder: true, mimeType: null, sizeBytes: null });
    const image = fileRow({
      name: "photo.png",
      mimeType: "image/png",
      storageKey: "u/user-1/drive/44444444-4444-4444-8444-444444444444",
    });
    db.tables.driveFile.push(folder, image);
    expect(await runOne(folder)).toBe("skipped");
    expect(await runOne(image)).toBe("skipped");
    expect(summaryOf(folder.id)).toMatchObject({ status: "SKIPPED", error: "folder" });
    expect(summaryOf(image.id)).toMatchObject({ status: "SKIPPED", error: "unsupported-type" });
    expect(getObject).not.toHaveBeenCalled();
    expect(llm.calls).toEqual([]);
  });

  it("skips a file over the cap by its recorded size, before fetching it", async () => {
    const getObject = vi.spyOn(store, "getObject");
    const big = fileRow({
      name: "big.txt",
      storageKey: "u/user-1/drive/33333333-3333-4333-8333-333333333333",
      sizeBytes: BigInt(DRIVE_SUMMARY_MAX_SOURCE_BYTES + 1),
    });
    db.tables.driveFile.push(big);
    expect(await runOne(big)).toBe("skipped");
    expect(summaryOf(big.id)).toMatchObject({ status: "SKIPPED", error: "too-large" });
    expect(getObject).not.toHaveBeenCalled();
  });

  it("holds the byte cap while the file streams, whatever size the store claims", async () => {
    const pulled = { chunks: 0 };
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    const lying: ObjectStore = Object.assign(Object.create(store) as ObjectStore, {
      async getObject(key: string) {
        return {
          key,
          size: 10,
          contentType: "text/plain",
          body: Readable.from(
            (function* () {
              for (let i = 0; i < 64; i++) {
                pulled.chunks += 1;
                yield chunk;
              }
            })(),
          ),
        };
      },
    });
    setObjectStoreForTests(lying);
    const file = fileRow({
      name: "liar.txt",
      storageKey: "u/user-1/drive/11111111-1111-4111-8111-111111111111",
      sizeBytes: 10n,
    });
    db.tables.driveFile.push(file);
    expect(await runOne(file)).toBe("skipped");
    expect(summaryOf(file.id)).toMatchObject({ status: "SKIPPED", error: "too-large" });
    // 8 MB fit in 8 one-MiB chunks at most; the stream stopped right after the cap.
    expect(pulled.chunks).toBeLessThanOrEqual(
      Math.ceil(DRIVE_SUMMARY_MAX_SOURCE_BYTES / chunk.length) + 1,
    );
    expect(llm.calls).toEqual([]);
  });

  it("a file whose object is missing fails without retrying", async () => {
    const file = fileRow({ storageKey: "u/user-1/drive/22222222-2222-4222-8222-222222222222" });
    db.tables.driveFile.push(file);
    expect(await runOne(file)).toBe("failed");
    expect(summaryOf(file.id)).toMatchObject({ status: "FAILED", error: "object-missing" });
  });

  it("a hidden or trashed file is skipped, not deferred again every hour", async () => {
    const hidden = await storedFile("hello");
    const trashed = await storedFile("bye", { trashed: true });
    vi.stubEnv("OBJECT_STORAGE_ENABLED", "");
    expect(await runOne(hidden)).toBe("skipped");
    vi.stubEnv("OBJECT_STORAGE_ENABLED", "true");
    expect(await runOne(trashed)).toBe("skipped");
    for (const file of [hidden, trashed]) {
      expect(summaryOf(file.id)).toMatchObject({ status: "SKIPPED", error: "source-unavailable" });
    }
    expect(llm.calls).toEqual([]);
  });
});

describe("caps defer, they never fail", () => {
  it("the user's daily summary count: PENDING until the next UTC day, no read, no model call", async () => {
    const file = await storedFile("hello");
    const getObject = vi.spyOn(store, "getObject");
    db.tables.driveSummaryUsage.push({
      userId: ME,
      dayKey: "2026-10-14",
      count: DRIVE_SUMMARIES_PER_USER_PER_DAY,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(await runOne(file)).toBe("deferred");
    expect(summaryOf(file.id)).toMatchObject({
      status: "PENDING",
      error: "daily-limit",
      nextAttemptAt: TOMORROW,
      attempts: 0,
    });
    expect(llm.calls).toEqual([]);
    // Checked before the bytes: a user at the count costs no download.
    expect(getObject).not.toHaveBeenCalled();
  });

  it("another user's count does not count against me", async () => {
    const file = await storedFile("hello");
    db.tables.driveSummaryUsage.push({
      userId: OTHER,
      dayKey: "2026-10-14",
      count: DRIVE_SUMMARIES_PER_USER_PER_DAY,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(await runOne(file)).toBe("done");
  });

  it("the per-file count: PENDING until the next UTC day, no model call", async () => {
    const file = await storedFile("hello");
    await queued(file);
    Object.assign(summaryOf(file.id) as Row, {
      runsDayKey: "2026-10-14",
      runsToday: DRIVE_SUMMARY_RUNS_PER_FILE_PER_DAY,
    });
    expect(await runLease(await leaseOf(file))).toBe("deferred");
    expect(summaryOf(file.id)).toMatchObject({
      status: "PENDING",
      error: "file-limit",
      attempts: 0,
      nextAttemptAt: TOMORROW,
    });
    expect(llm.calls).toEqual([]);
  });

  it("yesterday's per-file count does not hold today", async () => {
    const file = await storedFile("hello");
    await queued(file);
    Object.assign(summaryOf(file.id) as Row, { runsDayKey: "2026-10-13", runsToday: 3 });
    expect(await runLease(await leaseOf(file))).toBe("done");
    expect(summaryOf(file.id)).toMatchObject({ runsDayKey: "2026-10-14", runsToday: 1 });
  });

  it("the LLM layer's cost cap: PENDING until the next UTC day, not an attempt, slots given back", async () => {
    llm.result = { ok: false, code: "cost-cap" };
    const file = await storedFile("hello");
    expect(await runOne(file)).toBe("deferred");
    expect(summaryOf(file.id)).toMatchObject({
      status: "PENDING",
      error: "cost-cap",
      nextAttemptAt: TOMORROW,
      attempts: 0,
      runsToday: 0,
    });
    expect(db.tables.driveSummaryUsage[0]?.count).toBe(0);
  });

  it("a per-minute limit: PENDING after the wait the layer gave", async () => {
    llm.result = { ok: false, code: "rate-limited", retryAfterMs: 30_000 };
    const file = await storedFile("hello");
    expect(await runOne(file)).toBe("deferred");
    expect(summaryOf(file.id)).toMatchObject({
      status: "PENDING",
      error: "rate-limited",
      nextAttemptAt: new Date(NOW.getTime() + 30_000),
      attempts: 0,
      runsToday: 0,
    });
    expect(db.tables.driveSummaryUsage[0]?.count).toBe(0);
  });
});

describe("an outage waits; only a content error spends the failure budget", () => {
  it("provider unavailable: PENDING with a growing wait capped at a day, never FAILED, slots given back", async () => {
    llm.result = { ok: false, code: "llm-unavailable" };
    const file = await storedFile("hello");
    await queued(file);
    let now = NOW;
    const waits: number[] = [];
    for (let i = 0; i < 12; i++) {
      expect(await runLease(await leaseOf(file, now), now)).toBe("deferred");
      const row = summaryOf(file.id) as Row;
      expect(row).toMatchObject({ status: "PENDING", error: "llm-unavailable", attempts: 0 });
      waits.push((row.nextAttemptAt as Date).getTime() - now.getTime());
      now = row.nextAttemptAt as Date;
    }
    expect(waits[0]).toBe(DRIVE_SUMMARY_RETRY_BASE_MS);
    expect(waits[1]).toBe(2 * DRIVE_SUMMARY_RETRY_BASE_MS);
    expect(Math.max(...waits)).toBe(DRIVE_SUMMARY_OUTAGE_MAX_MS);
    // About 17 failing files used to spend a user's day; now none is spent.
    expect(db.tables.driveSummaryUsage.every((r) => r.count === 0)).toBe(true);
    expect(summaryOf(file.id)?.runsToday).toBe(0);
  });

  it("a content error: PENDING with backoff, FAILED after the last attempt; its slot stays spent", async () => {
    llm.result = { ok: false, code: "llm-bad-output" };
    const file = await storedFile("hello");
    expect(await runOne(file)).toBe("retry");
    expect(summaryOf(file.id)).toMatchObject({
      status: "PENDING",
      error: "llm-bad-output",
      attempts: 1,
      nextAttemptAt: new Date(NOW.getTime() + DRIVE_SUMMARY_RETRY_BASE_MS),
    });
    expect(db.tables.driveSummaryUsage[0]?.count).toBe(1);
    Object.assign(summaryOf(file.id) as Row, {
      attempts: DRIVE_SUMMARY_MAX_ATTEMPTS - 1,
      nextAttemptAt: NOW,
      runsToday: 0,
    });
    expect(await runLease(await leaseOf(file))).toBe("failed");
    expect(summaryOf(file.id)).toMatchObject({
      status: "FAILED",
      error: "llm-bad-output",
      attempts: DRIVE_SUMMARY_MAX_ATTEMPTS,
      summary: null,
    });
  });

  it("a row whose run never finishes (a crash, a freeze) is FAILED after the last attempt", async () => {
    const file = await storedFile("hello");
    await queued(file);
    let now = NOW;
    for (let i = 0; i < DRIVE_SUMMARY_MAX_ATTEMPTS; i++) {
      await leaseOf(file, now); // claimed, and the process dies before any outcome
      now = new Date(now.getTime() + DRIVE_SUMMARY_LEASE_MS);
    }
    const row = await findSummaryRow(ME, file.id as string);
    if (row === null) throw new Error("no row");
    expect(await claimSummary(row, now)).toBeNull();
    expect(summaryOf(file.id)).toMatchObject({ status: "FAILED", error: "interrupted" });
    expect(llm.calls).toEqual([]);
  });
});

describe("a run that lost its lease writes nothing", () => {
  it("after the lease expires another claimant takes the row; the first one's result is dropped", async () => {
    const file = await storedFile("hello");
    await queued(file);
    const first = await leaseOf(file, NOW);
    const later = new Date(NOW.getTime() + DRIVE_SUMMARY_LEASE_MS);
    const second = await leaseOf(file, later);
    llm.result = { ...DONE, summary: "from the first claimant" };
    expect(await runLease(first, NOW)).toBe("lost");
    expect(summaryOf(file.id)).toMatchObject({ status: "PENDING", summary: null });
    llm.result = { ...DONE, summary: "from the second claimant" };
    expect(await runLease(second, later)).toBe("done");
    expect(summaryOf(file.id)).toMatchObject({
      status: "DONE",
      summary: "from the second claimant",
    });
  });

  it("a file that changes during the run: the old version's summary is dropped, the lease kept", async () => {
    const file = await storedFile("hello");
    await queued(file);
    const lease = await leaseOf(file);
    llm.result = null;
    const { summariseDriveText } = await import("../drive/summary-llm.js");
    vi.mocked(summariseDriveText).mockImplementationOnce(async () => {
      await enqueueDriveFileSummary(ME, file.id as string, "sha256:edited", {}, NOW);
      return DONE as never;
    });
    expect(await runLease(lease)).toBe("lost");
    expect(summaryOf(file.id)).toMatchObject({
      status: "PENDING",
      summary: null,
      sourceEtag: "sha256:edited",
      // The live lease is not cut short: the new version waits for it.
      nextAttemptAt: lease.until,
    });
  });
});

describe("the job", () => {
  it("does nothing while DRIVE_SUMMARIES_ENABLED is off: no read, no claim", async () => {
    const file = await storedFile("hello");
    await queued(file);
    vi.stubEnv("DRIVE_SUMMARIES_ENABLED", "");
    db.reads.length = 0;
    const writesBefore = (db.writes.driveFileSummary ?? []).length;
    expect(await runDriveSummarySweep(NOW)).toMatchObject({ state: "off", runs: 0 });
    expect(db.reads).toEqual([]);
    expect((db.writes.driveFileSummary ?? []).length).toBe(writesBefore);
    expect(llm.calls).toEqual([]);
  });

  it("does nothing while DRIVE_ENABLED is off either", async () => {
    vi.stubEnv("DRIVE_ENABLED", "");
    expect(await runDriveSummarySweep(NOW)).toMatchObject({ state: "off", runs: 0 });
  });

  it("picks fairly: 60 due rows of one user do not hold back another user's one", async () => {
    for (let i = 0; i < 60; i++) await queued(await storedFile(`mine ${i}`));
    const theirs = await storedFile("theirs", {}, OTHER);
    await queued(theirs, new Date(NOW.getTime() + 1));
    const result = await runDriveSummarySweep(new Date(NOW.getTime() + 2));
    expect(llm.calls.filter((c) => c.userId === OTHER)).toHaveLength(1);
    expect(llm.calls.filter((c) => c.userId === ME)).toHaveLength(3);
    expect(result).toMatchObject({ state: "ran", runs: 4, done: 4 });
  });

  it("cheap skips do not use up the batch", async () => {
    for (let u = 0; u < 10; u++) {
      const userId = `user-${u + 10}`;
      const folder = fileRow({ userId, isFolder: true, mimeType: null, sizeBytes: null });
      db.tables.driveFile.push(folder);
      await queued(folder);
      await queued(await storedFile(`file of ${userId}`, {}, userId), new Date(NOW.getTime() + 1));
    }
    const result = await runDriveSummarySweep(new Date(NOW.getTime() + 2));
    expect(result).toMatchObject({ runs: 10, done: 10 });
    expect(db.tables.driveFileSummary.filter((r) => r.status === "SKIPPED")).toHaveLength(10);
  });

  it("runs the due rows only, and no more than three of one user per sweep", async () => {
    const mine = [];
    for (let i = 0; i < 5; i++) mine.push(await storedFile(`mine ${i}`));
    const theirs = await storedFile("theirs", {}, OTHER);
    const later = await storedFile("later");
    for (const file of [...mine, theirs]) await queued(file);
    await queued(later, new Date(NOW.getTime() + 60_000));
    const result = await runDriveSummarySweep(NOW);
    expect(result).toMatchObject({ state: "ran", runs: 4, done: 4 });
    expect(llm.calls.filter((c) => c.userId === ME)).toHaveLength(3);
    expect(llm.calls.filter((c) => c.userId === OTHER)).toHaveLength(1);
    expect(summaryOf(later.id)).toMatchObject({ status: "PENDING" });
  });

  it("prunes usage rows past the keep window", async () => {
    db.tables.driveSummaryUsage.push(
      { userId: ME, dayKey: "2026-10-01", count: 3, createdAt: NOW, updatedAt: NOW },
      { userId: ME, dayKey: "2026-10-13", count: 3, createdAt: NOW, updatedAt: NOW },
    );
    await runDriveSummarySweep(NOW);
    expect(db.tables.driveSummaryUsage.map((r) => r.dayKey)).toEqual(["2026-10-13"]);
  });
});
