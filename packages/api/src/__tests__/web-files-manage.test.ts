/**
 * Managing the Klorn drive on /files (D3's web UI step) — the pure rules in
 * packages/web/src/app/files/drive-errors.ts, drive-model.ts and
 * upload-model.ts: which server answer reads as which message, whether the
 * drive is on, what an upload sends and in what order, the upload batch, the
 * folder picker of "Move", and the name check.
 */

import type { DriveErrorCode, DriveFileWire } from "@klorn/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DRIVE_MESSAGE_KEYS,
  type DriveMessageKey,
  driveErrorKey,
  isDriveOff,
  isUnexpectedDriveError,
} from "../../../web/src/app/files/drive-errors";
import {
  canMoveHere,
  DRIVE_UPLOAD_PATH,
  driveItemPath,
  driveUsage,
  isKlornEditable,
  moveChoices,
  NAME_MAX_CHARS,
  nameErrorKey,
  pickerEnter,
  pickerListFolder,
  pickerTarget,
  pickerUp,
} from "../../../web/src/app/files/drive-model";
import { filesListPath } from "../../../web/src/app/files/model";
import {
  batchSummary,
  failRemaining,
  markDone,
  markFailed,
  markUploading,
  pendingIndices,
  precheckFailures,
  resetForRetry,
  startBatch,
  stopsBatch,
  uploadForm,
  uploadSizeErrorKey,
} from "../../../web/src/app/files/upload-model";
import de from "../../../web/src/lib/locales/de";
import en from "../../../web/src/lib/locales/en";
import es from "../../../web/src/lib/locales/es";
import fr from "../../../web/src/lib/locales/fr";
import ja from "../../../web/src/lib/locales/ja";
import ko from "../../../web/src/lib/locales/ko";
import zh from "../../../web/src/lib/locales/zh";
import { KLORN_DRIVE_ERROR_STATUS } from "../drive/klorn-errors.js";

const MAX_FILE_BYTES = 25 * 1024 * 1024;

function wire(overrides: Partial<DriveFileWire> = {}): DriveFileWire {
  return {
    id: "row-1",
    provider: "KLORN",
    sourceKey: "klorn",
    externalId: "ext-1",
    name: "report.pdf",
    mimeType: "application/pdf",
    isFolder: false,
    sizeBytes: 1024,
    parentExternalId: null,
    modifiedAt: "2026-10-15T00:00:00.000Z",
    webUrl: null,
    readOnly: false,
    ...overrides,
  };
}

/** An error as apiFetch throws it: "API <status>: <body text>". */
function apiError(status: number, body: unknown): Error {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Error(`API ${status}: ${text}`);
}

function driveError(code: DriveErrorCode): Error {
  const status = KLORN_DRIVE_ERROR_STATUS[code];
  return apiError(status, { error: "The server's English sentence.", code, retryable: false });
}

/** Fastify's default 404, which every D3 route answers while the drive is off. */
const DARK_404 = {
  message: "Route GET:/api/drive/limits not found",
  error: "Not Found",
  statusCode: 404,
};

describe("driveErrorKey: a failed drive request as a localized message key", () => {
  const expected: Readonly<Record<DriveErrorCode, DriveMessageKey>> = {
    "invalid-upload": "files.drive.error.invalidUpload",
    "invalid-name": "files.drive.error.invalidName",
    "multipart-malformed": "files.drive.error.malformed",
    "not-found": "files.drive.error.notFound",
    "parent-not-found": "files.drive.error.parentNotFound",
    "read-only": "files.drive.error.readOnly",
    "is-folder": "files.drive.error.isFolder",
    cycle: "files.drive.error.cycle",
    "too-deep": "files.drive.error.tooDeep",
    "folder-too-large": "files.drive.error.folderTooLarge",
    "account-purging": "files.drive.error.purging",
    "too-large": "files.drive.error.tooLarge",
    "quota-exceeded": "files.drive.error.full",
    "rate-limited": "files.drive.error.rateLimited",
    "quota-not-configured": "files.drive.error.notConfigured",
    "storage-unavailable": "files.drive.error.storage",
  };

  it("maps every code the server can send (its own status table) to its own message", () => {
    const serverCodes = Object.keys(KLORN_DRIVE_ERROR_STATUS) as DriveErrorCode[];
    expect(serverCodes.sort()).toEqual((Object.keys(expected) as DriveErrorCode[]).sort());
    for (const code of serverCodes) {
      expect(driveErrorKey(driveError(code)), code).toBe(expected[code]);
    }
  });

  it("branches on the code, never on the status alone", () => {
    // Two 404s, two meanings: the row is gone, or the folder it was put in is.
    expect(driveErrorKey(driveError("not-found"))).toBe("files.drive.error.notFound");
    expect(driveErrorKey(driveError("parent-not-found"))).toBe("files.drive.error.parentNotFound");
  });

  it("falls back on the status when the body carries no drive code", () => {
    expect(driveErrorKey(apiError(404, DARK_404))).toBe("files.drive.error.unavailable");
    expect(driveErrorKey(apiError(429, "Too Many Requests"))).toBe("files.drive.error.rateLimited");
    expect(driveErrorKey(apiError(413, "<html>Request Entity Too Large</html>"))).toBe(
      "files.drive.error.tooLarge",
    );
    expect(driveErrorKey(apiError(503, ""))).toBe("files.drive.error.storage");
    expect(driveErrorKey(apiError(500, { error: "Internal Server Error" }))).toBe(
      "files.drive.error.generic",
    );
  });

  it("does not trust a code it does not know (Fastify's own validation error)", () => {
    const validation = { statusCode: 400, code: "FST_ERR_VALIDATION", error: "Bad Request" };
    expect(driveErrorKey(apiError(400, validation))).toBe("files.drive.error.generic");
    expect(driveErrorKey(apiError(409, { code: "__proto__" }))).toBe("files.drive.error.generic");
  });

  it("reads fetch's own network failure as offline, in each browser's words", () => {
    for (const message of [
      "Failed to fetch",
      "NetworkError when attempting to fetch resource.",
      "Load failed",
      "Network request failed",
      "The network connection was lost.",
      "The Internet connection appears to be offline.",
    ]) {
      expect(driveErrorKey(new TypeError(message)), message).toBe("files.drive.error.offline");
    }
  });

  it("does not take any other TypeError for offline: that is a bug, reported", () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'file')");
    expect(driveErrorKey(bug)).toBe("files.drive.error.generic");
    expect(isUnexpectedDriveError(driveErrorKey(bug))).toBe(true);
    expect(driveErrorKey(new SyntaxError("Unexpected token"))).toBe("files.drive.error.generic");
    expect(driveErrorKey("boom")).toBe("files.drive.error.generic");
    expect(driveErrorKey(null)).toBe("files.drive.error.generic");
  });

  it("is offline for a TypeError while the browser says it has no network", () => {
    vi.stubGlobal("navigator", { onLine: false });
    try {
      expect(driveErrorKey(new TypeError("Anything at all"))).toBe("files.drive.error.offline");
      // An answer the server did send is still that answer.
      expect(driveErrorKey(driveError("cycle"))).toBe("files.drive.error.cycle");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reads a 401 (session over or device signed out) as signed out, never as a fault", () => {
    const plain = apiError(401, { error: "Unauthorized" });
    const kicked = apiError(401, { error: "This device was signed out.", code: "DEVICE_KICKED" });
    expect(driveErrorKey(plain)).toBe("files.drive.error.signedOut");
    expect(driveErrorKey(kicked)).toBe("files.drive.error.signedOut");
    expect(isUnexpectedDriveError("files.drive.error.signedOut")).toBe(false);
  });

  it("every message key exists, non-empty, in all seven locales", () => {
    const locales = { de, en, es, fr, ja, ko, zh };
    for (const key of DRIVE_MESSAGE_KEYS) {
      for (const [name, table] of Object.entries(locales)) {
        expect(table[key], `${name}: ${key}`).toBeTruthy();
      }
    }
  });
});

describe("isDriveOff: the /limits probe", () => {
  it("is off on Fastify's default 404 (the flag or the cohort)", () => {
    expect(isDriveOff(apiError(404, DARK_404))).toBe(true);
    expect(isDriveOff(apiError(404, ""))).toBe(true);
  });

  it("is not off on a drive 404, a server failure or a network failure", () => {
    expect(isDriveOff(driveError("not-found"))).toBe(false);
    expect(isDriveOff(apiError(500, ""))).toBe(false);
    expect(isDriveOff(apiError(503, ""))).toBe(false);
    expect(isDriveOff(new TypeError("Failed to fetch"))).toBe(false);
  });
});

describe("upload: the size check and the request body", () => {
  it("refuses a file over the cap before any request, and accepts the cap itself", () => {
    expect(uploadSizeErrorKey(MAX_FILE_BYTES + 1, MAX_FILE_BYTES)).toBe(
      "files.drive.error.tooLarge",
    );
    expect(uploadSizeErrorKey(MAX_FILE_BYTES, MAX_FILE_BYTES)).toBeNull();
    expect(uploadSizeErrorKey(0, MAX_FILE_BYTES)).toBeNull();
  });

  it("sends size, then the parent, then the one file part, in that order", () => {
    const file = new File(["hello world"], "notes.txt", { type: "text/plain" });
    const form = uploadForm(file, "folder-ext-9");
    expect([...form.keys()]).toEqual(["size", "parentExternalId", "file"]);
    expect(form.get("size")).toBe("11");
    expect(form.get("parentExternalId")).toBe("folder-ext-9");
    const part = form.get("file");
    expect(part).toBeInstanceOf(File);
    expect((part as File).name).toBe("notes.txt");
    expect((part as File).size).toBe(11);
  });

  it("leaves the parent out for the drive's top level", () => {
    const file = new File([new Uint8Array(3)], "a.bin");
    const form = uploadForm(file, null);
    expect([...form.keys()]).toEqual(["size", "file"]);
    expect(form.get("size")).toBe("3");
  });
});

describe("upload batch: one file after another, with each file's outcome", () => {
  const picked = [
    { name: "a.pdf", size: 10 },
    { name: "b.png", size: 20 },
    { name: "c.txt", size: 30 },
  ];

  it("starts with every file waiting and nothing uploading", () => {
    const batch = startBatch(picked, MAX_FILE_BYTES);
    expect(batch.items.map((item) => [item.name, item.status])).toEqual([
      ["a.pdf", "waiting"],
      ["b.png", "waiting"],
      ["c.txt", "waiting"],
    ]);
    expect(new Set(batch.items.map((item) => item.key)).size).toBe(3);
    expect(pendingIndices(batch)).toEqual([0, 1, 2]);
    expect(batchSummary(batch)).toEqual({
      total: 3,
      current: null,
      done: 0,
      failed: 0,
      finished: false,
    });
  });

  it("refuses a file over the cap up front, without a request, and names it once", () => {
    const batch = startBatch([...picked, { name: "huge.mov", size: 99 }], 50);
    expect(batch.items[3]).toMatchObject({
      status: "failed",
      errorKey: "files.drive.error.tooLarge",
      cause: "precheck",
    });
    expect(pendingIndices(batch)).toEqual([0, 1, 2]);
    expect(precheckFailures(batch)).toEqual(["huge.mov"]);
  });

  it("reports which file of how many is uploading, then the outcome", () => {
    const first = markUploading(startBatch(picked, MAX_FILE_BYTES), 0);
    expect(batchSummary(first).current).toBe(1);
    const second = markUploading(markDone(first, 0), 1);
    expect(batchSummary(second)).toMatchObject({ current: 2, done: 1, finished: false });
    const third = markUploading(markFailed(second, 1, "files.drive.error.invalidName"), 2);
    const last = markDone(third, 2);
    expect(last.items[1]).toMatchObject({
      status: "failed",
      errorKey: "files.drive.error.invalidName",
      cause: "sent",
    });
    expect(batchSummary(last)).toEqual({
      total: 3,
      current: null,
      done: 2,
      failed: 1,
      finished: true,
    });
  });

  it("never changes the batch it was given", () => {
    const batch = startBatch(picked, MAX_FILE_BYTES);
    const snapshot = JSON.stringify(batch);
    markUploading(batch, 0);
    markDone(batch, 1);
    markFailed(batch, 2, "files.drive.error.generic");
    failRemaining(batch, 0, "files.drive.error.rateLimited");
    resetForRetry(batch, [0, 1]);
    expect(JSON.stringify(batch)).toBe(snapshot);
  });

  it("fails the files not yet sent as skipped, with the reason the batch stopped", () => {
    const stopped = failRemaining(
      markFailed(markDone(startBatch(picked, MAX_FILE_BYTES), 0), 1, "files.drive.error.full"),
      2,
      "files.drive.error.full",
    );
    expect(stopped.items.map((item) => item.status)).toEqual(["done", "failed", "failed"]);
    expect(stopped.items[2]).toMatchObject({
      errorKey: "files.drive.error.full",
      cause: "skipped",
    });
    // The refused file has its own reason; the one after it was never sent.
    expect(stopped.items.map((item) => item.cause)).toEqual([null, "sent", "skipped"]);
    expect(batchSummary(stopped)).toMatchObject({ done: 1, failed: 2, finished: true });
  });

  it("stops on a refusal every later file would get too, not on one about this file", () => {
    const stopping: DriveMessageKey[] = [
      "files.drive.error.rateLimited",
      "files.drive.error.full",
      "files.drive.error.notConfigured",
      "files.drive.error.purging",
      "files.drive.error.parentNotFound",
      "files.drive.error.storage",
      "files.drive.error.unavailable",
      "files.drive.error.offline",
      "files.drive.error.signedOut",
    ];
    for (const key of stopping) expect(stopsBatch(key), key).toBe(true);
    const perFile: DriveMessageKey[] = [
      "files.drive.error.tooLarge",
      "files.drive.error.invalidName",
      "files.drive.error.invalidUpload",
      "files.drive.error.malformed",
      "files.drive.error.generic",
    ];
    for (const key of perFile) expect(stopsBatch(key), key).toBe(false);
  });
});

describe("which rows can be managed", () => {
  it("is only the Klorn drive's own rows (V4 keeps external sources read-only)", () => {
    expect(isKlornEditable(wire())).toBe(true);
    expect(isKlornEditable(wire({ isFolder: true }))).toBe(true);
    expect(isKlornEditable(wire({ provider: "GOOGLE", readOnly: true }))).toBe(false);
    expect(isKlornEditable(wire({ provider: "ONEDRIVE", readOnly: true }))).toBe(false);
    // The wire's own flag wins if it ever says read-only.
    expect(isKlornEditable(wire({ readOnly: true }))).toBe(false);
  });

  it("addresses one row by its URL-encoded id", () => {
    expect(driveItemPath("row-1")).toBe("/api/drive/files/row-1");
    expect(driveItemPath("a/b?c")).toBe("/api/drive/files/a%2Fb%3Fc");
  });
});

describe("Move: the folder picker, one level at a time from the top", () => {
  const folderA = wire({ id: "row-a", externalId: "ext-a", name: "A", isFolder: true });
  const folderB = wire({
    id: "row-b",
    externalId: "ext-b",
    name: "B",
    isFolder: true,
    parentExternalId: "ext-a",
  });

  it("starts at the top level and lists it with the server's `root` value", () => {
    expect(pickerListFolder([])).toBe("root");
    expect(pickerTarget([])).toBeNull();
  });

  it("walks into a folder and back out, returning new arrays", () => {
    const start: ReturnType<typeof pickerEnter> = [];
    const inA = pickerEnter(start, folderA);
    expect(start).toEqual([]);
    expect(inA).toEqual([{ id: "row-a", externalId: "ext-a", name: "A" }]);
    expect(pickerListFolder(inA)).toBe("ext-a");
    expect(pickerTarget(inA)).toBe("ext-a");
    const inB = pickerEnter(inA, folderB);
    expect(pickerTarget(inB)).toBe("ext-b");
    expect(pickerUp(inB)).toEqual(inA);
    expect(inB).toHaveLength(2);
    expect(pickerUp([])).toEqual([]);
  });

  it("offers folders only, and never lets the moved folder be opened", () => {
    const file = wire({ id: "row-f", externalId: "ext-f", name: "f.txt" });
    const choices = moveChoices([folderA, file, folderB], folderA);
    expect(choices.map((choice) => [choice.folder.id, choice.enterable])).toEqual([
      ["row-a", false],
      ["row-b", true],
    ]);
    expect(moveChoices([folderA], file).map((choice) => choice.enterable)).toEqual([true]);
  });

  it("refuses the place the item already is, and the moved folder itself", () => {
    const atTop = wire();
    expect(canMoveHere(atTop, null)).toBe(false);
    expect(canMoveHere(atTop, "ext-a")).toBe(true);
    expect(canMoveHere(folderB, "ext-a")).toBe(false);
    expect(canMoveHere(folderB, null)).toBe(true);
    expect(canMoveHere(folderA, "ext-a")).toBe(false);
  });
});

describe("Move's folder levels: folders only, from the server", () => {
  it("asks for one level's folders, the top level as `root`", () => {
    const root = new URL(filesListPath({ folder: "root", foldersOnly: true }), "https://x");
    expect(root.searchParams.get("folder")).toBe("root");
    expect(root.searchParams.get("foldersOnly")).toBe("true");
    const inner = new URL(
      filesListPath({ folder: "ext-a", foldersOnly: true, cursor: "c1" }),
      "https://x",
    );
    expect(inner.searchParams.get("folder")).toBe("ext-a");
    expect(inner.searchParams.get("cursor")).toBe("c1");
  });

  it("leaves the parameter out of every other list", () => {
    expect(filesListPath({ folder: "root" })).not.toContain("foldersOnly");
    expect(filesListPath({ q: "q4", foldersOnly: false })).not.toContain("foldersOnly");
  });
});

describe("names: the client's check before the server's", () => {
  it("asks for a name when there is none", () => {
    expect(nameErrorKey("")).toBe("files.drive.name.required");
    expect(nameErrorKey("   ")).toBe("files.drive.name.required");
  });

  it("says why: . and .. are reserved, and a name past 255 characters is too long", () => {
    expect(nameErrorKey(".")).toBe("files.drive.name.reserved");
    expect(nameErrorKey(" .. ")).toBe("files.drive.name.reserved");
    expect(nameErrorKey("a".repeat(NAME_MAX_CHARS))).toBeNull();
    expect(nameErrorKey("a".repeat(NAME_MAX_CHARS + 1))).toBe("files.drive.name.tooLong");
    // Characters, not UTF-16 units: 255 emoji are a valid name.
    expect(nameErrorKey("😀".repeat(NAME_MAX_CHARS))).toBeNull();
  });

  it("accepts an ordinary name", () => {
    expect(nameErrorKey("Q4 reports")).toBeNull();
    expect(nameErrorKey("보고서")).toBeNull();
  });

  it("has every name message in all seven locales", () => {
    const locales = { de, en, es, fr, ja, ko, zh };
    for (const key of [
      "files.drive.name.required",
      "files.drive.name.reserved",
      "files.drive.name.tooLong",
    ]) {
      for (const [name, table] of Object.entries(locales)) {
        expect(table[key], `${name}: ${key}`).toBeTruthy();
      }
    }
  });
});

describe("driveUsage: the storage line", () => {
  it("formats used and quota with the shared size format", () => {
    expect(
      driveUsage({ maxFileBytes: MAX_FILE_BYTES, quotaBytes: 1024 ** 3, usedBytes: 1536 }, "en"),
    ).toEqual({ used: "1.5 KB", quota: "1 GB" });
  });

  it("has no quota while the server has none (every upload refused)", () => {
    expect(
      driveUsage({ maxFileBytes: MAX_FILE_BYTES, quotaBytes: null, usedBytes: 0 }, "en"),
    ).toEqual({ used: "0 B", quota: null });
  });
});

describe("apiFetch with an upload's multipart body", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function sent(init: RequestInit): Promise<RequestInit> {
    vi.stubGlobal("window", { localStorage: undefined, location: { pathname: "/", search: "" } });
    vi.stubGlobal("localStorage", { getItem: () => "token-1", setItem() {}, removeItem() {} });
    const fetchMock = vi.fn(async () => new Response("{}", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await import("../../../web/src/lib/api");
    await apiFetch(DRIVE_UPLOAD_PATH, init);
    return (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
  }

  it("leaves Content-Type to the browser, which adds the boundary", async () => {
    const body = uploadForm(new File(["x"], "a.txt"), null);
    const init = await sent({ method: "POST", body });
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain("content-type");
    expect(headers.Authorization).toBe("Bearer token-1");
    expect(init.body).toBe(body);
  });

  it("still sends JSON as JSON", async () => {
    const init = await sent({ method: "POST", body: JSON.stringify({ name: "Q4" }) });
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });
});
