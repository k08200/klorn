/**
 * D5d: the hourly refresh of picked Google Drive files' metadata
 * (drive/google-drive-refresh.ts, one account's pass; drive/google-drive-refresh-job.ts,
 * the sweep and its scheduler). Over the strict fake database, with the real
 * token cipher; the OAuth client and googleapis are mocked, so no Google call
 * is real.
 *
 *   - while DRIVE_ENABLED or GOOGLE_DRIVE_ENABLED is off a sweep reads nothing:
 *     no query, no client, no Google call;
 *   - a sweep takes at most 20 GOOGLE accounts not refreshed for 6 h, never one
 *     flagged for reconnect, the never-refreshed first;
 *   - per row one files.get with D5c's fields mask, at most 4 in flight;
 *   - trashed → `trashed` through the writer; 404 → that row deleted through
 *     the writer's per-file delete, nothing else;
 *   - a revoked grant flags the account; a 429, a rate-limit 403, a 5xx or a
 *     network error ends that account's pass: no further call, not marked
 *     refreshed; the next account still runs;
 *   - a changed etag (either form) re-queues the summary; an unchanged one
 *     writes nothing to the summary table;
 *   - the job's heartbeat is in /api/health/schedulers' report.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
const google = vi.hoisted(() => ({
  clients: 0,
  filesGet: vi.fn(),
  filesList: vi.fn(),
  filesExport: vi.fn(),
  captureError: vi.fn(),
}));

vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(() => dbHolder.current as FakeDb);
  return { prisma, db: prisma, INTERACTIVE_TX_OPTIONS: { maxWait: 10_000, timeout: 15_000 } };
});
vi.mock("../mail/gmail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mail/gmail.js")>();
  return {
    ...actual,
    getOAuth2Client: () => {
      google.clients += 1;
      return { setCredentials: () => {}, on: () => {} };
    },
  };
});
vi.mock("googleapis", () => ({
  google: {
    drive: () => ({
      files: { get: google.filesGet, list: google.filesList, export: google.filesExport },
    }),
  },
}));
vi.mock("../sentry.js", () => ({ captureError: google.captureError }));

import { encryptToken } from "../crypto-tokens.js";
import {
  GOOGLE_REFRESH_IN_FLIGHT,
  refreshGoogleDriveAccount,
} from "../drive/google-drive-refresh.js";
import {
  driveGoogleRefreshTick,
  GOOGLE_DRIVE_REFRESH_INTERVAL_MS,
  GOOGLE_REFRESH_ACCOUNTS_PER_SWEEP,
  GOOGLE_REFRESH_STALE_MS,
  runGoogleDriveRefreshSweep,
  startDriveGoogleRefreshScheduler,
  stopDriveGoogleRefreshScheduler,
} from "../drive/google-drive-refresh-job.js";
import { GOOGLE_DRIVE_FILE_FIELDS } from "../drive/providers/google-files.js";
import {
  buildSchedulerHealthReport,
  EXPECTED_SCHEDULERS,
  getSchedulerHealth,
  resetSchedulerHeartbeats,
} from "../scheduler-heartbeat.js";

const NOW = new Date("2026-10-15T12:00:00.000Z");
const HOUR = 60 * 60_000;
const FLAGS = ["DRIVE_ENABLED", "GOOGLE_DRIVE_ENABLED"];
const ago = (ms: number) => new Date(NOW.getTime() - ms);

let db: FakeDb;
let seq = 0;

function account(over: Row = {}): Row {
  seq += 1;
  return {
    id: `acct-${seq}`,
    userId: "user-1",
    provider: "GOOGLE",
    email: `me${seq}@example.com`,
    accessToken: encryptToken("ya29.stored-SECRET"),
    refreshToken: encryptToken("1//refresh-SECRET"),
    expiresAt: new Date("2026-10-15T13:00:00.000Z"),
    grantedScopes: "openid https://www.googleapis.com/auth/drive.file",
    lastRefreshedAt: null,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    ...over,
  };
}

const fileId = (i: number) => `1File${String(i).padStart(28, "0")}`;

function driveRow(i: number, over: Row = {}): Row {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    userId: "user-1",
    provider: "GOOGLE",
    sourceKey: "acct-1",
    sourceAccountId: "acct-1",
    externalId: fileId(i),
    name: `file ${i}.pdf`,
    mimeType: "application/pdf",
    sizeBytes: 2048n,
    modifiedAt: new Date("2026-10-01T00:00:00.000Z"),
    etag: `md5:old-${i}`,
    ...over,
  };
}

/** What Google answers for a row today: the same file, by default unchanged. */
function resource(row: Row, over: Record<string, unknown> = {}) {
  const etag = String(row.etag ?? "");
  return {
    id: row.externalId,
    name: row.name,
    mimeType: row.mimeType,
    size: "2048",
    ...(etag.startsWith("md5:") ? { md5Checksum: etag.slice(4) } : {}),
    ...(etag.startsWith("v:") ? { version: etag.slice(2) } : {}),
    modifiedTime: "2026-10-14T09:30:00.000Z",
    webViewLink: `https://drive.google.com/file/d/${String(row.externalId)}/view`,
    parents: ["0ParentFolderId0000000000"],
    trashed: false,
    ...over,
  };
}

function googleError(status: number | null, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error("Request failed"), {
    ...(status === null ? { code: "ECONNRESET" } : { status, response: { status } }),
    config: { headers: { Authorization: "Bearer ya29.stored-SECRET" } },
    ...extra,
  });
}

/** Google's answer per id: a resource, an error, or (absent) a 404. */
function googleAnswers(answers: Record<string, unknown>): void {
  google.filesGet.mockImplementation((params: { fileId: string }) => {
    const answer = answers[params.fileId];
    if (answer instanceof Error) return Promise.reject(answer);
    if (answer === undefined) return Promise.reject(googleError(404));
    return Promise.resolve({ data: answer });
  });
}

function seed(tables: Record<string, Row[]>): void {
  db = createFakeDb({
    linkedDriveAccount: [],
    driveFile: [],
    driveFileSummary: [],
    ...tables,
  });
  dbHolder.current = db;
}

const accountRow = (id: string) => db.tables.linkedDriveAccount?.find((r) => r.id === id);
const fileRow = (externalId: string) =>
  db.tables.driveFile?.find((r) => r.externalId === externalId && r.sourceKey === "acct-1");

beforeEach(() => {
  seq = 0;
  for (const flag of FLAGS) vi.stubEnv(flag, "true");
  vi.stubEnv("DRIVE_SUMMARIES_ENABLED", "");
  google.clients = 0;
  google.filesGet.mockReset();
  google.filesList.mockReset();
  google.filesExport.mockReset();
  google.captureError.mockReset();
  seed({});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  stopDriveGoogleRefreshScheduler();
});

describe("off: the sweep reads nothing", () => {
  it.each([
    ["DRIVE_ENABLED off", { DRIVE_ENABLED: "", GOOGLE_DRIVE_ENABLED: "true" }],
    ["GOOGLE_DRIVE_ENABLED off", { DRIVE_ENABLED: "true", GOOGLE_DRIVE_ENABLED: "" }],
    ["both off", { DRIVE_ENABLED: "", GOOGLE_DRIVE_ENABLED: "" }],
  ])("%s: no query, no client, no Google call", async (_label, env) => {
    for (const [flag, value] of Object.entries(env)) vi.stubEnv(flag, value);
    seed({ linkedDriveAccount: [account({ id: "acct-1" })], driveFile: [driveRow(1)] });
    const result = await runGoogleDriveRefreshSweep(NOW);
    expect(result.state).toBe("off");
    expect(db.reads).toEqual([]);
    expect(db.writes).toEqual({});
    expect(google.clients).toBe(0);
    expect(google.filesGet).not.toHaveBeenCalled();
  });

  it("a tick while off reads nothing and still records the heartbeat", async () => {
    vi.stubEnv("GOOGLE_DRIVE_ENABLED", "");
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    resetSchedulerHeartbeats();
    startDriveGoogleRefreshScheduler();
    vi.setSystemTime(NOW.getTime() + 60_000);
    await driveGoogleRefreshTick();
    expect(db.reads).toEqual([]);
    const entry = getSchedulerHealth().schedulers.find((s) => s.name === "drive-google-refresh");
    expect(entry?.lastSeenAt).toBe(NOW.getTime() + 60_000);
  });
});

describe("which accounts a sweep takes", () => {
  it("at most 20 GOOGLE accounts not refreshed for 6 h, never-refreshed first, oldest next; never one flagged for reconnect", async () => {
    const recent = [1, 2, 3].map((n) => account({ id: `recent-${n}`, lastRefreshedAt: ago(HOUR) }));
    const flagged = [1, 2].map((n) =>
      account({ id: `flagged-${n}`, needsReconnect: true, lastRefreshedAt: ago(9 * HOUR) }),
    );
    const onedrive = account({ id: "onedrive-1", provider: "ONEDRIVE", lastRefreshedAt: null });
    const never = [1, 2].map((n) => account({ id: `never-${n}`, userId: `user-${n + 10}` }));
    // 20 stale accounts, 6 h (exactly) to 25 h old; the 2 freshest are left for next time.
    const stale = Array.from({ length: 20 }, (_, i) =>
      account({ id: `stale-${i}`, userId: `user-${i}`, lastRefreshedAt: ago((6 + i) * HOUR) }),
    );
    seed({ linkedDriveAccount: [...recent, ...flagged, onedrive, ...stale, ...never] });

    const result = await runGoogleDriveRefreshSweep(NOW);

    const refreshed = (db.tables.linkedDriveAccount ?? [])
      .filter(
        (r) => r.lastRefreshedAt instanceof Date && r.lastRefreshedAt.getTime() === NOW.getTime(),
      )
      .map((r) => r.id)
      .sort();
    const expected = [
      ...never.map((r) => r.id),
      ...stale.slice(2).map((r) => r.id),
    ].sort() as string[];
    expect(GOOGLE_REFRESH_ACCOUNTS_PER_SWEEP).toBe(20);
    expect(GOOGLE_REFRESH_STALE_MS).toBe(6 * HOUR);
    expect(refreshed).toEqual(expected);
    expect(result).toMatchObject({ state: "ran", accounts: 20, refreshed: 20 });
    expect(accountRow("stale-0")?.lastRefreshedAt).toEqual(ago(6 * HOUR));
    expect(accountRow("flagged-1")?.lastRefreshedAt).toEqual(ago(9 * HOUR));
    expect(accountRow("onedrive-1")?.lastRefreshedAt).toBeNull();
  });

  it("an account whose grant cannot be decrypted is flagged and not marked refreshed", async () => {
    seed({
      linkedDriveAccount: [account({ id: "acct-1", accessToken: "not-a-cipher" })],
      driveFile: [driveRow(1)],
    });
    expect(await refreshGoogleDriveAccount("user-1", "acct-1", NOW)).toBe("skipped");
    await vi.waitFor(() => expect(accountRow("acct-1")?.needsReconnect).toBe(true));
    expect(accountRow("acct-1")?.lastRefreshedAt).toBeNull();
    expect(google.filesGet).not.toHaveBeenCalled();
  });

  it("another user's account id is not refreshed through this user", async () => {
    seed({ linkedDriveAccount: [account({ id: "acct-1", userId: "user-2" })] });
    expect(await refreshGoogleDriveAccount("user-1", "acct-1", NOW)).toBe("skipped");
    expect(accountRow("acct-1")?.lastRefreshedAt).toBeNull();
  });
});

describe("one account's pass", () => {
  it("one files.get per row with D5c's fields mask; success marks the account refreshed", async () => {
    const rows = [driveRow(1), driveRow(2)];
    seed({ linkedDriveAccount: [account({ id: "acct-1" })], driveFile: rows });
    googleAnswers(Object.fromEntries(rows.map((r) => [r.externalId as string, resource(r)])));
    expect(await refreshGoogleDriveAccount("user-1", "acct-1", NOW)).toBe("refreshed");
    expect(google.filesGet.mock.calls.map((c) => c[0])).toEqual(
      rows.map((r) => ({
        fileId: r.externalId,
        fields: GOOGLE_DRIVE_FILE_FIELDS,
        supportsAllDrives: true,
      })),
    );
    expect(accountRow("acct-1")?.lastRefreshedAt).toEqual(NOW);
    expect(fileRow(fileId(1))?.modifiedAt).toEqual(new Date("2026-10-14T09:30:00.000Z"));
  });

  it("a file Google reports trashed becomes trashed through the writer", async () => {
    const row = driveRow(1);
    seed({ linkedDriveAccount: [account({ id: "acct-1" })], driveFile: [row] });
    googleAnswers({ [fileId(1)]: resource(row, { trashed: true }) });
    expect(await refreshGoogleDriveAccount("user-1", "acct-1", NOW)).toBe("refreshed");
    expect(fileRow(fileId(1))?.trashed).toBe(true);
    const write = db.writes.driveFile?.[0];
    expect(write?.op).toBe("updateMany");
    expect(write?.where).toEqual({
      userId: "user-1",
      provider: "GOOGLE",
      sourceKey: "acct-1",
      externalId: fileId(1),
    });
  });

  it("a 404 deletes that row only, through the writer's per-file delete", async () => {
    const gone = driveRow(1);
    const kept = driveRow(2);
    const otherUsers = driveRow(3, {
      userId: "user-2",
      sourceKey: "acct-9",
      sourceAccountId: "acct-9",
      externalId: fileId(1),
    });
    seed({
      linkedDriveAccount: [account({ id: "acct-1" }), account({ id: "acct-9", userId: "user-2" })],
      driveFile: [gone, kept, otherUsers],
      driveFileSummary: [],
    });
    googleAnswers({ [fileId(2)]: resource(kept) });
    expect(await refreshGoogleDriveAccount("user-1", "acct-1", NOW)).toBe("refreshed");
    expect(db.tables.driveFile?.map((r) => r.id)).toEqual([kept.id, otherUsers.id]);
    const deletes = (db.writes.driveFile ?? []).filter((w) => w.op === "deleteMany");
    expect(deletes).toEqual([
      {
        op: "deleteMany",
        where: {
          userId: "user-1",
          provider: "GOOGLE",
          sourceKey: "acct-1",
          externalId: { in: [fileId(1)] },
        },
      },
    ]);
    expect(accountRow("acct-1")?.lastRefreshedAt).toEqual(NOW);
  });

  it.each([
    ["a 401", googleError(401)],
    ["invalid_grant", Object.assign(new Error("invalid_grant"), { code: "invalid_grant" })],
  ])("a revoked grant (%s) flags the account, ends the pass, and is not marked refreshed", async (_l, err) => {
    const rows = Array.from({ length: 10 }, (_, i) => driveRow(i + 1));
    seed({ linkedDriveAccount: [account({ id: "acct-1" })], driveFile: rows });
    google.filesGet.mockRejectedValue(err);
    expect(await refreshGoogleDriveAccount("user-1", "acct-1", NOW)).toBe("needs-reconnect");
    expect(accountRow("acct-1")).toMatchObject({ needsReconnect: true, lastRefreshedAt: null });
    expect(google.filesGet.mock.calls.length).toBeLessThanOrEqual(GOOGLE_REFRESH_IN_FLIGHT);
    expect(db.tables.driveFile).toHaveLength(10);
  });

  it.each([
    ["a 429", googleError(429)],
    [
      "a 403 userRateLimitExceeded",
      googleError(403, { errors: [{ reason: "userRateLimitExceeded" }] }),
    ],
    [
      "a 403 rateLimitExceeded (in the body)",
      googleError(403, {
        response: { status: 403, data: { error: { errors: [{ reason: "rateLimitExceeded" }] } } },
      }),
    ],
    ["a 500", googleError(500)],
    ["a 503", googleError(503)],
    ["a network error", googleError(null)],
  ])("%s ends that account's pass: no further call, not marked refreshed", async (_l, err) => {
    const rows = Array.from({ length: 10 }, (_, i) => driveRow(i + 1));
    seed({ linkedDriveAccount: [account({ id: "acct-1" })], driveFile: rows });
    const answers = Object.fromEntries(rows.map((r) => [r.externalId as string, resource(r)]));
    googleAnswers({ ...answers, [fileId(1)]: err });
    expect(await refreshGoogleDriveAccount("user-1", "acct-1", NOW)).toBe("stopped");
    // The four already in flight finish; nothing more starts.
    expect(google.filesGet).toHaveBeenCalledTimes(GOOGLE_REFRESH_IN_FLIGHT);
    expect(accountRow("acct-1")).toMatchObject({ needsReconnect: false, lastRefreshedAt: null });
    expect(db.tables.driveFile).toHaveLength(10);
  });

  it("a rate limit on one account does not stop the next account of the sweep", async () => {
    const limited = driveRow(1);
    const fine = driveRow(2, { sourceKey: "acct-2", sourceAccountId: "acct-2" });
    seed({
      linkedDriveAccount: [
        account({ id: "acct-1", lastRefreshedAt: ago(30 * HOUR) }),
        account({ id: "acct-2", lastRefreshedAt: ago(20 * HOUR) }),
      ],
      driveFile: [limited, fine],
    });
    googleAnswers({ [fileId(1)]: googleError(429), [fileId(2)]: resource(fine) });
    const result = await runGoogleDriveRefreshSweep(NOW);
    expect(result).toMatchObject({ state: "ran", accounts: 2, refreshed: 1, stopped: 1 });
    expect(accountRow("acct-1")?.lastRefreshedAt).toEqual(ago(30 * HOUR));
    expect(accountRow("acct-2")?.lastRefreshedAt).toEqual(NOW);
  });

  it("a file-level 403 (appNotAuthorizedToFile) leaves that row and goes on", async () => {
    const rows = [driveRow(1), driveRow(2)];
    seed({ linkedDriveAccount: [account({ id: "acct-1" })], driveFile: rows });
    googleAnswers({
      [fileId(1)]: googleError(403, { errors: [{ reason: "appNotAuthorizedToFile" }] }),
      [fileId(2)]: resource(rows[1] as Row, { name: "renamed.pdf" }),
    });
    expect(await refreshGoogleDriveAccount("user-1", "acct-1", NOW)).toBe("refreshed");
    expect(fileRow(fileId(1))?.name).toBe("file 1.pdf");
    expect(fileRow(fileId(2))?.name).toBe("renamed.pdf");
  });

  it("any other failure ends the pass and is reported by status and reason only, never the error", async () => {
    seed({ linkedDriveAccount: [account({ id: "acct-1" })], driveFile: [driveRow(1)] });
    const err = googleError(403, { errors: [{ reason: "accessNotConfigured" }] });
    googleAnswers({ [fileId(1)]: err });
    expect(await refreshGoogleDriveAccount("user-1", "acct-1", NOW)).toBe("stopped");
    expect(accountRow("acct-1")?.lastRefreshedAt).toBeNull();
    expect(google.captureError).toHaveBeenCalledTimes(1);
    const [reported] = google.captureError.mock.calls[0] as [Error];
    expect(reported).not.toBe(err);
    expect(reported.message).toBe("Google Drive refresh failed: 403 accessNotConfigured");
    expect(JSON.stringify(google.captureError.mock.calls)).not.toContain("SECRET");
  });

  it("at most 4 files.get in flight, and every row is read", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => driveRow(i + 1));
    seed({ linkedDriveAccount: [account({ id: "acct-1" })], driveFile: rows });
    let inFlight = 0;
    let most = 0;
    google.filesGet.mockImplementation(async (params: { fileId: string }) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      const row = rows.find((r) => r.externalId === params.fileId) as Row;
      return { data: resource(row) };
    });
    expect(await refreshGoogleDriveAccount("user-1", "acct-1", NOW)).toBe("refreshed");
    expect(GOOGLE_REFRESH_IN_FLIGHT).toBe(4);
    expect(most).toBe(4);
    expect(google.filesGet).toHaveBeenCalledTimes(10);
  });
});

describe("the summary follows the etag, and only the etag", () => {
  function summary(row: Row): Row {
    return {
      id: `sum-${String(row.id)}`,
      driveFileId: row.id,
      userId: "user-1",
      status: "DONE",
      sourceEtag: row.etag,
      summary: "An old summary.",
      nextAttemptAt: ago(HOUR),
    };
  }

  beforeEach(() => vi.stubEnv("DRIVE_SUMMARIES_ENABLED", "true"));

  it.each([
    ["md5: a rename keeps the checksum", driveRow(1), { name: "renamed.pdf" }],
    [
      "v: the version is unchanged",
      driveRow(1, {
        etag: "v:17",
        mimeType: "application/vnd.google-apps.document",
        sizeBytes: null,
      }),
      {},
    ],
  ])("%s: no write to the summary table", async (_l, row, change) => {
    seed({
      linkedDriveAccount: [account({ id: "acct-1" })],
      driveFile: [row],
      driveFileSummary: [summary(row)],
    });
    googleAnswers({ [fileId(1)]: resource(row, change) });
    expect(await refreshGoogleDriveAccount("user-1", "acct-1", NOW)).toBe("refreshed");
    expect(db.writes.driveFileSummary).toBeUndefined();
    expect(db.reads).not.toContain("driveFileSummary");
    expect(db.tables.driveFileSummary?.[0]).toMatchObject({ status: "DONE" });
  });

  it.each([
    ["md5: the content changed", driveRow(1), { md5Checksum: "new-checksum" }, "md5:new-checksum"],
    [
      "v: a Google Doc's version moved",
      driveRow(1, {
        etag: "v:17",
        mimeType: "application/vnd.google-apps.document",
        sizeBytes: null,
      }),
      { version: "18" },
      "v:18",
    ],
  ])("%s: the summary is queued again at the new etag", async (_l, row, change, etag) => {
    seed({
      linkedDriveAccount: [account({ id: "acct-1" })],
      driveFile: [row],
      driveFileSummary: [summary(row)],
    });
    googleAnswers({ [fileId(1)]: resource(row, change) });
    expect(await refreshGoogleDriveAccount("user-1", "acct-1", NOW)).toBe("refreshed");
    expect(fileRow(fileId(1))?.etag).toBe(etag);
    expect(db.tables.driveFileSummary?.[0]).toMatchObject({ status: "PENDING", sourceEtag: etag });
  });

  it("a trashed file is not queued, whatever its etag", async () => {
    const row = driveRow(1);
    seed({
      linkedDriveAccount: [account({ id: "acct-1" })],
      driveFile: [row],
      driveFileSummary: [summary(row)],
    });
    googleAnswers({ [fileId(1)]: resource(row, { trashed: true, md5Checksum: "new" }) });
    expect(await refreshGoogleDriveAccount("user-1", "acct-1", NOW)).toBe("refreshed");
    expect(db.writes.driveFileSummary).toBeUndefined();
  });
});

describe("the job", () => {
  it("one sweep at a time: a second sweep while one runs is busy", async () => {
    seed({ linkedDriveAccount: [account({ id: "acct-1" })], driveFile: [driveRow(1)] });
    let release: () => void = () => {};
    google.filesGet.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ data: resource(driveRow(1)) });
        }),
    );
    const first = runGoogleDriveRefreshSweep(NOW);
    await vi.waitFor(() => expect(google.filesGet).toHaveBeenCalled());
    expect((await runGoogleDriveRefreshSweep(NOW)).state).toBe("busy");
    release();
    expect((await first).state).toBe("ran");
  });

  it("registers an hourly heartbeat that /api/health/schedulers reports, and stops cleanly", () => {
    resetSchedulerHeartbeats();
    expect(EXPECTED_SCHEDULERS).toContain("drive-google-refresh");
    startDriveGoogleRefreshScheduler();
    const report = buildSchedulerHealthReport({ disabled: false, uptimeMs: 10 * 60_000 });
    const entry = report.body.schedulers?.find((s) => s.name === "drive-google-refresh");
    expect(GOOGLE_DRIVE_REFRESH_INTERVAL_MS).toBe(HOUR);
    expect(entry).toMatchObject({ intervalMs: HOUR, stale: false, disabled: false });
    expect(report.body.missing).not.toContain("drive-google-refresh");
    stopDriveGoogleRefreshScheduler();
  });

  it("a sweep that throws is reported and records no heartbeat", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    resetSchedulerHeartbeats();
    startDriveGoogleRefreshScheduler();
    vi.setSystemTime(NOW.getTime() + 60_000);
    dbHolder.current = {
      ...db,
      model: () => {
        throw new Error("database is down");
      },
    };
    await driveGoogleRefreshTick();
    expect(google.captureError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { scope: "drive.google.refresh.sweep" },
    });
    const entry = getSchedulerHealth().schedulers.find((s) => s.name === "drive-google-refresh");
    expect(entry?.lastSeenAt).toBe(NOW.getTime());
  });
});
