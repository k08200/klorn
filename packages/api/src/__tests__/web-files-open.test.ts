/**
 * Opening a Klorn drive file and walking its folders (P12 follow-up), and
 * stale Teams free time — the pure rules in packages/web/src/app/files/open.ts,
 * packages/web/src/app/files/model.ts and packages/web/src/app/today/free-time-model.ts.
 */

import type { DriveFileWire, TeamFreeSlotWire } from "@klorn/contract";
import { describe, expect, it } from "vitest";
import { filesListPath } from "../../../web/src/app/files/model";
import {
  downloadErrorKey,
  downloadLinkPath,
  fileOpenAction,
  folderHref,
  safeDownloadUrl,
  trailTo,
} from "../../../web/src/app/files/open";
import {
  FREE_TIME_STALE_MS,
  freeTimeStale,
  upcomingSlots,
} from "../../../web/src/app/today/free-time-model";

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

describe("fileOpenAction", () => {
  it("downloads a Klorn drive file through the API", () => {
    expect(fileOpenAction(wire())).toEqual({ kind: "download" });
  });

  it("walks into a Klorn drive folder", () => {
    expect(fileOpenAction(wire({ isFolder: true, sizeBytes: null }))).toEqual({ kind: "folder" });
  });

  it("opens an external file's own https link, normalised", () => {
    const action = fileOpenAction(
      wire({ provider: "GOOGLE", readOnly: true, webUrl: "https://docs.google.com/x" }),
    );
    expect(action).toEqual({ kind: "link", href: "https://docs.google.com/x" });
  });

  it("leaves an external row without a safe link inert, folder or not", () => {
    expect(fileOpenAction(wire({ provider: "GOOGLE", webUrl: null }))).toEqual({ kind: "none" });
    expect(fileOpenAction(wire({ provider: "ONEDRIVE", webUrl: "javascript:alert(1)" }))).toEqual({
      kind: "none",
    });
    expect(fileOpenAction(wire({ provider: "GOOGLE", isFolder: true, webUrl: null }))).toEqual({
      kind: "none",
    });
  });

  it("prefers a Klorn row's own handling over any link it carries", () => {
    expect(fileOpenAction(wire({ webUrl: "https://example.com/x" }))).toEqual({
      kind: "download",
    });
  });
});

describe("downloadLinkPath", () => {
  it("asks the authenticated API for the signed link, id URL-encoded", () => {
    expect(downloadLinkPath("abc")).toBe("/api/drive/files/abc/download");
    expect(downloadLinkPath("a/../b?c#d")).toBe("/api/drive/files/a%2F..%2Fb%3Fc%23d/download");
  });
});

describe("safeDownloadUrl", () => {
  it("accepts an https signed link and returns the parsed href", () => {
    const url = "https://bucket.r2.example.com/u/k?X-Amz-Expires=300&X-Amz-Signature=abc";
    expect(safeDownloadUrl(url)).toBe(url);
  });

  it("accepts http only on a loopback host (a local object store)", () => {
    expect(safeDownloadUrl("http://localhost:9000/b/k")).toBe("http://localhost:9000/b/k");
    expect(safeDownloadUrl("http://127.0.0.1:9000/b/k")).toBe("http://127.0.0.1:9000/b/k");
    expect(safeDownloadUrl("http://[::1]:9000/b/k")).toBe("http://[::1]:9000/b/k");
    expect(safeDownloadUrl("http://bucket.example.com/k")).toBeNull();
    expect(safeDownloadUrl("http://localhost.evil.com/k")).toBeNull();
  });

  it("refuses every other scheme, credentials, relative paths and junk", () => {
    expect(safeDownloadUrl("javascript:alert(1)")).toBeNull();
    expect(safeDownloadUrl("data:text/html,<script>1</script>")).toBeNull();
    expect(safeDownloadUrl("blob:https://app.klorn.ai/uuid")).toBeNull();
    expect(safeDownloadUrl("https://user:pass@bucket.example.com/k")).toBeNull();
    expect(safeDownloadUrl("/api/drive/files/x")).toBeNull();
    expect(safeDownloadUrl("//bucket.example.com/k")).toBeNull();
    expect(safeDownloadUrl("")).toBeNull();
    expect(safeDownloadUrl(undefined)).toBeNull();
    expect(safeDownloadUrl(42)).toBeNull();
  });
});

describe("downloadErrorKey", () => {
  it("names a missing file, a busy limit and anything else apart", () => {
    expect(downloadErrorKey(new Error('API 404: {"error":"not-found"}'))).toBe(
      "files.download.gone",
    );
    expect(downloadErrorKey(new Error("API 429: slow down"))).toBe("files.download.busy");
    expect(downloadErrorKey(new Error("API 503: storage"))).toBe("files.download.error");
    expect(downloadErrorKey(new Error("unsafe link"))).toBe("files.download.error");
    expect(downloadErrorKey("weird")).toBe("files.download.error");
  });
});

describe("folder trail", () => {
  const a = { id: "1", externalId: "e1", name: "A" };
  const b = { id: "2", externalId: "e2", name: "B" };

  it("cuts the trail back to a crumb, or to all files", () => {
    expect(trailTo([a, b], 0)).toEqual([a]);
    expect(trailTo([a, b], 1)).toEqual([a, b]);
    expect(trailTo([a, b], -1)).toEqual([]);
  });

  it("returns a new array, leaving the old trail alone", () => {
    const trail = [a, b];
    const cut = trailTo(trail, 0);
    expect(cut).not.toBe(trail);
    expect(trail).toHaveLength(2);
  });
});

describe("folderHref", () => {
  it("opens /files at one folder by row id, URL-encoded", () => {
    expect(folderHref("abc")).toBe("/files?folder=abc");
    expect(folderHref("a&b=c")).toBe("/files?folder=a%26b%3Dc");
  });
});

describe("filesListPath folder", () => {
  it("lists one Klorn drive folder by its externalId", () => {
    const params = new URLSearchParams(filesListPath({ folder: "e 1" }).split("?")[1]);
    expect(params.get("folder")).toBe("e 1");
  });

  it("sends no folder at the top level", () => {
    expect(filesListPath({ folder: null })).not.toContain("folder=");
    expect(filesListPath({})).not.toContain("folder=");
  });
});

describe("Teams free time staleness", () => {
  const now = new Date("2026-10-15T10:00:00.000Z");
  const slot = (start: string, end: string): TeamFreeSlotWire => ({
    startTime: start,
    endTime: end,
  });
  const past = slot("2026-10-15T09:00:00.000Z", "2026-10-15T09:30:00.000Z");
  const running = slot("2026-10-15T09:45:00.000Z", "2026-10-15T10:15:00.000Z");
  const later = slot("2026-10-15T11:00:00.000Z", "2026-10-15T11:30:00.000Z");

  it("drops slots that have already started, keeping the order", () => {
    expect(upcomingSlots([past, running, later], now)).toEqual([later]);
    expect(upcomingSlots([later], now)).toEqual([later]);
    expect(upcomingSlots([], now)).toEqual([]);
  });

  it("drops an unreadable slot rather than show it", () => {
    expect(upcomingSlots([slot("nope", "nope"), later], now)).toEqual([later]);
  });

  it("is stale once older than the limit", () => {
    const fresh = now.getTime() - FREE_TIME_STALE_MS + 1;
    const old = now.getTime() - FREE_TIME_STALE_MS - 1;
    expect(freeTimeStale(fresh, [later], now)).toBe(false);
    expect(freeTimeStale(old, [later], now)).toBe(true);
  });

  it("is stale as soon as its first slot has started, however new", () => {
    expect(freeTimeStale(now.getTime(), [running, later], now)).toBe(true);
    expect(freeTimeStale(now.getTime(), [], now)).toBe(false);
  });

  it("treats an unknown fetch time as stale", () => {
    expect(freeTimeStale(0, [later], now)).toBe(true);
  });
});
