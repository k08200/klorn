/**
 * Managing the Klorn drive on /files (D3's web UI step) — what happens around
 * a running upload batch: it outlives the page (in-app navigation does not end
 * it) and reports when it ends off the page; it stops when the session that
 * started it ends or changes; leaving the site asks first, except on the
 * signed-out path; "Cancel" skips the rest so "Retry failed" works. Also the
 * "New folder" timeout copy and the "Load more" focus marker.
 */

import { describe, expect, it, vi } from "vitest";
import { driveErrorKey, SessionChangedError } from "../../../web/src/app/files/drive-errors";
import { createFailureKey } from "../../../web/src/app/files/drive-model";
import { initialMarker, markLoad, observeLoad } from "../../../web/src/app/files/load-more-marker";
import {
  backgroundResult,
  cancelBatch,
  markDone,
  markUploading,
  retryableIndices,
  startBatch,
} from "../../../web/src/app/files/upload-model";
import { boundToSession, warnsOnLeave } from "../../../web/src/app/files/upload-run";
import de from "../../../web/src/lib/locales/de";
import en from "../../../web/src/lib/locales/en";
import es from "../../../web/src/lib/locales/es";
import fr from "../../../web/src/lib/locales/fr";
import ja from "../../../web/src/lib/locales/ja";
import ko from "../../../web/src/lib/locales/ko";
import zh from "../../../web/src/lib/locales/zh";

const picked = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ name: `f${index}.txt`, size: 1 }));

describe("Cancel: the running batch stops, and what was not sent can be retried", () => {
  it("skips the file in flight and the ones waiting, as cancelled", () => {
    const running = markUploading(markDone(startBatch(picked(4), 100), 0), 1);
    const cancelled = cancelBatch(running);
    expect(cancelled.items.map((item) => [item.status, item.cause, item.errorKey])).toEqual([
      ["done", null, null],
      ["failed", "skipped", "files.drive.error.cancelled"],
      ["failed", "skipped", "files.drive.error.cancelled"],
      ["failed", "skipped", "files.drive.error.cancelled"],
    ]);
    expect(retryableIndices(cancelled)).toEqual([1, 2, 3]);
    // The batch it was given is unchanged.
    expect(running.items[1]?.status).toBe("uploading");
  });

  it("leaves a refusal the server already gave as it is", () => {
    const batch = startBatch([...picked(1), { name: "big", size: 999 }], 100);
    expect(cancelBatch(batch).items[1]).toMatchObject({
      errorKey: "files.drive.error.tooLarge",
      cause: "precheck",
    });
  });
});

describe("the batch's session", () => {
  it("stops sending once the session that started the batch has ended or changed", async () => {
    let token: string | null = "token-a";
    const upload = vi.fn(() => Promise.resolve({}));
    const send = boundToSession("token-a", () => token, upload);
    await send(new File(["x"], "a.txt"), null);
    expect(upload).toHaveBeenCalledTimes(1);
    token = "token-b";
    await expect(send(new File(["x"], "b.txt"), null)).rejects.toBeInstanceOf(SessionChangedError);
    token = null;
    await expect(send(new File(["x"], "c.txt"), null)).rejects.toBeInstanceOf(SessionChangedError);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("reads a changed session as signed out, which stops the batch", () => {
    expect(driveErrorKey(new SessionChangedError())).toBe("files.drive.error.signedOut");
  });

  it("asks before the site is left while signed in, never on the signed-out path", () => {
    expect(warnsOnLeave("token-a")).toBe(true);
    // apiFetch clears the token before it sends the person to /login.
    expect(warnsOnLeave(null)).toBe(false);
  });
});

describe("a batch that ends after the person left /files", () => {
  it("says how it went, and where to upload what did not go", () => {
    const all = markDone(markDone(startBatch(picked(2), 100), 0), 1);
    expect(backgroundResult(all)).toEqual({
      key: "files.drive.upload.backgroundAll",
      vars: { done: "2" },
      failed: false,
    });
    const some = cancelBatch(markDone(startBatch(picked(3), 100), 0));
    expect(backgroundResult(some)).toEqual({
      key: "files.drive.upload.backgroundSome",
      vars: { done: "1", failed: "2" },
      failed: true,
    });
  });
});

describe('"New folder" past its deadline', () => {
  it("says to look at the list first: the server allows two folders with one name", () => {
    expect(createFailureKey("files.drive.error.timeout")).toBe("files.drive.error.timeoutCreate");
    expect(createFailureKey("files.drive.error.invalidName")).toBe("files.drive.error.invalidName");
  });
});

describe("Load more's focus marker", () => {
  it("moves focus to the first new item when the last page arrives", () => {
    let marker = markLoad(initialMarker(), 50);
    let seen = observeLoad(marker, { count: 50, loading: true, hasMore: true });
    expect(seen.focusFrom).toBeNull();
    seen = observeLoad(seen.marker, { count: 70, loading: false, hasMore: false });
    expect(seen.focusFrom).toBe(50);
    marker = seen.marker;
    // Spent: a later growth moves nothing.
    expect(observeLoad(marker, { count: 90, loading: false, hasMore: false }).focusFrom).toBeNull();
  });

  it("keeps focus on the button while more pages remain", () => {
    const marker = markLoad(initialMarker(), 50);
    const seen = observeLoad(marker, { count: 100, loading: false, hasMore: true });
    expect(seen.focusFrom).toBeNull();
    expect(
      observeLoad(seen.marker, { count: 120, loading: false, hasMore: false }).focusFrom,
    ).toBeNull();
  });

  it("drops the marker when the load ends without new items (a failure)", () => {
    const loading = observeLoad(markLoad(initialMarker(), 50), {
      count: 50,
      loading: true,
      hasMore: true,
    });
    const failed = observeLoad(loading.marker, { count: 50, loading: false, hasMore: true });
    expect(failed.focusFrom).toBeNull();
    // A later, unrelated growth (a refresh) must not move focus.
    expect(
      observeLoad(failed.marker, { count: 60, loading: false, hasMore: false }).focusFrom,
    ).toBeNull();
  });
});

describe("the new messages", () => {
  it("exist, non-empty, in all seven locales", () => {
    const keys = [
      "files.drive.error.cancelled",
      "files.drive.error.timeoutCreate",
      "files.drive.upload.backgroundAll",
      "files.drive.upload.backgroundSome",
      "files.drive.upload.cancel",
    ];
    for (const [name, table] of Object.entries({ de, en, es, fr, ja, ko, zh })) {
      for (const key of keys) expect(table[key], `${name}: ${key}`).toBeTruthy();
    }
  });
});
