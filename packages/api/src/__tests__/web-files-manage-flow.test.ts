/**
 * Managing the Klorn drive on /files (D3's web UI step) — the flows behind
 * the pure rules: the upload run (packages/web/src/app/files/upload-run.ts),
 * which keeps going past a refusal about one file and stops on one every
 * later file would get too (a 401 among them); "Retry failed"; the sheets'
 * open/close tokens (dialog-state.ts), so a late answer never closes another
 * sheet; and where focus and a fresh list read go after a change
 * (drive-model.ts).
 */

import type { DriveFileWire } from "@klorn/contract";
import { describe, expect, it, vi } from "vitest";
import { closeDialog, openDialog, type RowAction } from "../../../web/src/app/files/dialog-state";
import { type DriveMessageKey, driveErrorKey } from "../../../web/src/app/files/drive-errors";
import {
  neighborId,
  refreshesAfterFailure,
  removesFromList,
} from "../../../web/src/app/files/drive-model";
import {
  pendingIndices,
  resetForRetry,
  retryableIndices,
  startBatch,
  type UploadBatch,
} from "../../../web/src/app/files/upload-model";
import { runUploads, type UploadDeps } from "../../../web/src/app/files/upload-run";

function apiError(status: number, body: unknown): Error {
  return new Error(`API ${status}: ${JSON.stringify(body)}`);
}

const refusal = (status: number, code: string) =>
  apiError(status, { error: "The server's sentence.", code, retryable: false });

function files(...names: string[]): File[] {
  return names.map((name) => new File(["x"], name));
}

/** A batch the run updates in place of React's state. */
function harness(picked: File[], answers: Record<string, unknown>) {
  let batch: UploadBatch = startBatch(
    picked.map((file) => ({ name: file.name, size: file.size })),
    1_000,
  );
  const upload = vi.fn((file: File) => {
    const answer = answers[file.name];
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve({ id: file.name });
  });
  const report = vi.fn();
  const deps: UploadDeps = { upload, classify: driveErrorKey, report };
  const step = (update: (current: UploadBatch) => UploadBatch) => {
    batch = update(batch);
  };
  return {
    deps,
    upload,
    report,
    step,
    get batch() {
      return batch;
    },
  };
}

const sentNames = (upload: ReturnType<typeof vi.fn>) =>
  upload.mock.calls.map((call) => (call[0] as File).name);

describe("runUploads: one file after another", () => {
  it("keeps going past a refusal about one file", async () => {
    const picked = files("a.txt", "b.txt", "c.txt");
    const run = harness(picked, { "b.txt": refusal(400, "invalid-name") });
    await runUploads(picked, pendingIndices(run.batch), "folder-1", run.deps, run.step);
    expect(sentNames(run.upload)).toEqual(["a.txt", "b.txt", "c.txt"]);
    expect(run.upload.mock.calls[0]?.[1]).toBe("folder-1");
    expect(run.batch.items.map((item) => item.status)).toEqual(["done", "failed", "done"]);
    expect(run.batch.items[1]?.errorKey).toBe("files.drive.error.invalidName");
  });

  it("stops at a 401: nothing more is sent once the session is over", async () => {
    const picked = files("a.txt", "b.txt", "c.txt", "d.txt");
    const run = harness(picked, { "b.txt": apiError(401, { error: "Unauthorized" }) });
    await runUploads(picked, pendingIndices(run.batch), null, run.deps, run.step);
    expect(sentNames(run.upload)).toEqual(["a.txt", "b.txt"]);
    expect(run.batch.items.map((item) => [item.status, item.cause, item.errorKey])).toEqual([
      ["done", null, null],
      ["failed", "sent", "files.drive.error.signedOut"],
      ["failed", "skipped", "files.drive.error.signedOut"],
      ["failed", "skipped", "files.drive.error.signedOut"],
    ]);
    expect(run.report).toHaveBeenCalledTimes(1);
    expect(run.report.mock.calls[0]?.[1]).toBe("files.drive.error.signedOut");
  });

  it("stops at the rate limit and at a network failure", async () => {
    for (const [answer, key] of [
      [refusal(429, "rate-limited"), "files.drive.error.rateLimited"],
      [new TypeError("Failed to fetch"), "files.drive.error.offline"],
    ] as const) {
      const picked = files("a.txt", "b.txt", "c.txt");
      const run = harness(picked, { "a.txt": answer });
      await runUploads(picked, pendingIndices(run.batch), null, run.deps, run.step);
      expect(sentNames(run.upload), key).toEqual(["a.txt"]);
      expect(run.batch.items.map((item) => item.errorKey)).toEqual([key, key, key]);
    }
  });

  it("keeps going past a server fault, and hands it to the reporter", async () => {
    const picked = files("a.txt", "b.txt");
    const run = harness(picked, { "a.txt": apiError(500, { error: "Internal" }) });
    await runUploads(picked, pendingIndices(run.batch), null, run.deps, run.step);
    expect(sentNames(run.upload)).toEqual(["a.txt", "b.txt"]);
    expect(run.report.mock.calls[0]?.[1]).toBe("files.drive.error.generic");
  });

  it("never sends a file the size check refused", async () => {
    const picked = [new File(["x"], "small.txt"), new File(["x".repeat(2_000)], "big.txt")];
    const run = harness(picked, {});
    expect(run.batch.items[1]?.cause).toBe("precheck");
    await runUploads(picked, pendingIndices(run.batch), null, run.deps, run.step);
    expect(sentNames(run.upload)).toEqual(["small.txt"]);
  });
});

describe("Retry failed", () => {
  it("offers the files that may pass now, and only those", async () => {
    const picked = files("ok.txt", "bad-name.txt", "server.txt", "limited.txt", "after.txt");
    const run = harness(picked, {
      "bad-name.txt": refusal(400, "invalid-name"),
      "server.txt": apiError(500, {}),
      "limited.txt": refusal(429, "rate-limited"),
    });
    await runUploads(picked, pendingIndices(run.batch), null, run.deps, run.step);
    // Not the bad name (it would fail again); the fault, the limit and the skipped one.
    expect(retryableIndices(run.batch)).toEqual([2, 3, 4]);
  });

  it("does not offer a file over the cap, a full drive's own refusal, or a done file", () => {
    let batch = startBatch(
      [
        { name: "big", size: 99 },
        { name: "full", size: 1 },
        { name: "done", size: 1 },
      ],
      50,
    );
    batch = {
      items: batch.items.map((item, at) =>
        at === 1
          ? { ...item, status: "failed", errorKey: "files.drive.error.full", cause: "sent" }
          : at === 2
            ? { ...item, status: "done" }
            : item,
      ),
    };
    expect(retryableIndices(batch)).toEqual([]);
  });

  it("sends the retried files again, and nothing else", async () => {
    const picked = files("ok.txt", "limited.txt", "after.txt");
    const answers: Record<string, unknown> = { "limited.txt": refusal(429, "rate-limited") };
    const run = harness(picked, answers);
    await runUploads(picked, pendingIndices(run.batch), null, run.deps, run.step);
    const again = retryableIndices(run.batch);
    expect(again).toEqual([1, 2]);
    run.step((batch) => resetForRetry(batch, again));
    expect(run.batch.items.map((item) => item.status)).toEqual(["done", "waiting", "waiting"]);
    delete answers["limited.txt"];
    run.upload.mockClear();
    await runUploads(picked, again, null, run.deps, run.step);
    expect(sentNames(run.upload)).toEqual(["limited.txt", "after.txt"]);
    expect(run.batch.items.map((item) => item.status)).toEqual(["done", "done", "done"]);
  });
});

const ROW = { id: "row-1", name: "a.pdf" } as DriveFileWire;
const OTHER = { id: "row-2", name: "b.pdf" } as DriveFileWire;

describe("the sheets: one open at a time, closed only by their own answer", () => {
  it("gives every opening a new token and keeps the row while it closes", () => {
    const first = openDialog(null, "rename", ROW);
    const second = openDialog(first, "delete", OTHER);
    expect(second.token).toBeGreaterThan(first.token);
    const closed = closeDialog(second, second.token);
    expect(closed).toMatchObject({ kind: "delete", file: OTHER, open: false });
  });

  it("ignores a close from an earlier opening: a late answer never closes another sheet", () => {
    const rename = openDialog(null, "rename", ROW);
    const move = openDialog(rename, "move" satisfies RowAction, OTHER);
    expect(closeDialog(move, rename.token)).toBe(move);
    expect(closeDialog(null, rename.token)).toBeNull();
  });

  it("opens the folder sheet without a row", () => {
    expect(openDialog(null, "folder", null)).toMatchObject({
      kind: "folder",
      file: null,
      open: true,
    });
  });
});

describe("after a change: where focus goes, and when the list is read again", () => {
  it("goes to the next row, else the previous one, else nowhere", () => {
    expect(neighborId(["a", "b", "c"], "b")).toBe("c");
    expect(neighborId(["a", "b", "c"], "c")).toBe("b");
    expect(neighborId(["a"], "a")).toBeNull();
    expect(neighborId(["a", "b"], "gone")).toBeNull();
  });

  it("knows which changes take the row out of the list on screen", () => {
    expect(removesFromList("delete", false)).toBe(true);
    expect(removesFromList("delete", true)).toBe(true);
    // The unfiltered list shows every row wherever it lives.
    expect(removesFromList("move", false)).toBe(false);
    expect(removesFromList("move", true)).toBe(true);
    expect(removesFromList("rename", true)).toBe(false);
  });

  it("reads the list again after a refusal that says it is out of date", () => {
    const notFound: DriveMessageKey = "files.drive.error.notFound";
    expect(refreshesAfterFailure("rename", notFound)).toBe(true);
    expect(refreshesAfterFailure("move", notFound)).toBe(true);
    expect(refreshesAfterFailure("delete", notFound)).toBe(true);
    // A partial delete (503, retryable) already took some rows with it.
    expect(refreshesAfterFailure("delete", "files.drive.error.storage")).toBe(true);
    expect(refreshesAfterFailure("move", "files.drive.error.storage")).toBe(false);
    expect(refreshesAfterFailure("delete", "files.drive.error.generic")).toBe(false);
  });
});
