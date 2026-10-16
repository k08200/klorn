/**
 * D5c: what Klorn reads of a Google Drive file and how it becomes the seam's
 * ProviderDriveFile (drive/providers/google-files.ts), and the session's reads
 * (drive/providers/google.ts) over a mocked googleapis: no Google call is real.
 *
 *   - `files.get` asks for EXACTLY the plan's fields, with supportsAllDrives;
 *   - a 404 is "not granted": null, never an error;
 *   - the link is kept only on docs.google.com or drive.google.com, over https;
 *   - the etag is `md5:<md5Checksum>` when Drive reports one, else `v:<version>`;
 *   - the listing and the search quote what they put in Drive's query language;
 *   - D5d's byte read for a summary: Docs and Slides exported as text/plain,
 *     Sheets as text/csv, anything else read with alt=media, streamed into the
 *     cap within D4's deadline; never a link Google hands over; Google's export
 *     size error is `too-large`, a 429, a 5xx or a network error a retryable
 *     StorageError.
 */

import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  export: vi.fn(),
  drive: vi.fn(),
}));

vi.mock("googleapis", () => ({
  google: {
    drive: (options: unknown) => {
      api.drive(options);
      return { files: { get: api.get, list: api.list, export: api.export } };
    },
  },
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { googleDriveSession } from "../drive/providers/google.js";
import {
  GOOGLE_DRIVE_FILE_FIELDS,
  GOOGLE_FOLDER_MIME,
  googleEtag,
  googleWebUrl,
  toProviderDriveFile,
} from "../drive/providers/google-files.js";
import { DRIVE_SUMMARY_READ_TIMEOUT_MS } from "../drive/summary-policy.js";
import { StorageError } from "../storage/errors.js";

const PLAN_FIELDS =
  "id,name,mimeType,size,md5Checksum,version,modifiedTime,webViewLink,parents,trashed";

const linked = { client: { marker: "oauth-client" } as never, id: "acct-1", email: "me@x.com" };

function resource(over: Record<string, unknown> = {}) {
  return {
    id: "1AbCdEfGhIjKlMnOpQrStUvWxYz012345",
    name: "Q3 plan.pdf",
    mimeType: "application/pdf",
    size: "20480",
    md5Checksum: "0cc175b9c0f1b6a831c399e269772661",
    version: "17",
    modifiedTime: "2026-10-14T09:30:00.000Z",
    webViewLink: "https://drive.google.com/file/d/1AbC/view?usp=drivesdk",
    parents: ["0ParentFolderId0000000000"],
    trashed: false,
    ...over,
  };
}

beforeEach(() => {
  api.get.mockReset();
  api.list.mockReset();
  api.export.mockReset();
  api.drive.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the fields mask", () => {
  it("is exactly the plan's list: nothing more is ever read from Google", () => {
    expect(GOOGLE_DRIVE_FILE_FIELDS).toBe(PLAN_FIELDS);
  });

  it("getMetadata calls files.get with exactly that mask and supportsAllDrives, on the account's client", async () => {
    api.get.mockResolvedValue({ data: resource() });
    const session = googleDriveSession(linked);
    await session.getMetadata("1AbCdEfGhIjKlMnOpQrStUvWxYz012345");
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get.mock.calls[0]).toEqual([
      { fileId: "1AbCdEfGhIjKlMnOpQrStUvWxYz012345", fields: PLAN_FIELDS, supportsAllDrives: true },
    ]);
    expect(api.drive).toHaveBeenCalledWith({ version: "v3", auth: linked.client });
  });
});

describe("a file as the seam carries it", () => {
  it("maps every field: the first parent, a whole size, the md5 etag", () => {
    expect(toProviderDriveFile(resource())).toEqual({
      externalId: "1AbCdEfGhIjKlMnOpQrStUvWxYz012345",
      name: "Q3 plan.pdf",
      mimeType: "application/pdf",
      isFolder: false,
      sizeBytes: 20480,
      parentExternalId: "0ParentFolderId0000000000",
      modifiedAt: new Date("2026-10-14T09:30:00.000Z"),
      webUrl: "https://drive.google.com/file/d/1AbC/view?usp=drivesdk",
      etag: "md5:0cc175b9c0f1b6a831c399e269772661",
      trashed: false,
    });
  });

  it("parent is parents[0] and only that; none reported is null", () => {
    expect(toProviderDriveFile(resource({ parents: ["p-1", "p-2"] })).parentExternalId).toBe("p-1");
    expect(toProviderDriveFile(resource({ parents: [] })).parentExternalId).toBeNull();
    expect(toProviderDriveFile(resource({ parents: undefined })).parentExternalId).toBeNull();
  });

  it("a Google Doc has no size; a size that is not a whole safe number is null", () => {
    expect(toProviderDriveFile(resource({ size: undefined })).sizeBytes).toBeNull();
    expect(toProviderDriveFile(resource({ size: "-1" })).sizeBytes).toBeNull();
    expect(toProviderDriveFile(resource({ size: "12.5" })).sizeBytes).toBeNull();
    expect(toProviderDriveFile(resource({ size: "99999999999999999999" })).sizeBytes).toBeNull();
  });

  it("a folder is a folder; trashed is exactly true or false", () => {
    const folder = toProviderDriveFile(resource({ mimeType: GOOGLE_FOLDER_MIME }));
    expect(folder.isFolder).toBe(true);
    expect(toProviderDriveFile(resource({ trashed: true })).trashed).toBe(true);
    expect(toProviderDriveFile(resource({ trashed: "yes" })).trashed).toBe(false);
  });
});

describe("the link: https on Google's own two hosts only", () => {
  it.each([
    "https://docs.google.com/document/d/1AbC/edit?usp=drivesdk",
    "https://drive.google.com/file/d/1AbC/view?usp=drivesdk",
  ])("keeps %s", (link) => {
    expect(googleWebUrl(link)).toBe(link);
  });

  it.each([
    ["http, not https", "http://docs.google.com/document/d/1AbC/edit"],
    ["another host", "https://evil.example/document/d/1AbC"],
    ["a look-alike suffix", "https://docs.google.com.evil.example/d/1AbC"],
    ["a sub-domain", "https://x.drive.google.com/file/d/1AbC"],
    ["credentials", "https://user:pw@drive.google.com/file/d/1AbC"],
    ["a port", "https://drive.google.com:8443/file/d/1AbC"],
    ["javascript", "javascript:alert(1)"],
    ["not a string", 42],
    ["nothing", undefined],
  ])("drops %s", (_label, link) => {
    expect(googleWebUrl(link)).toBeNull();
    expect(toProviderDriveFile(resource({ webViewLink: link })).webUrl).toBeNull();
  });
});

describe("the etag", () => {
  it("is md5:<md5Checksum> when Drive reports one (a rename keeps it)", () => {
    expect(googleEtag({ md5Checksum: "abc123", version: "9" })).toBe("md5:abc123");
  });

  it("is v:<version> when there is no checksum (a Google Doc)", () => {
    expect(googleEtag({ md5Checksum: undefined, version: "9" })).toBe("v:9");
    expect(googleEtag({ md5Checksum: "", version: "9" })).toBe("v:9");
  });

  it("is null when Drive reports neither", () => {
    expect(googleEtag({})).toBeNull();
    expect(googleEtag({ md5Checksum: null, version: null })).toBeNull();
  });
});

describe("getMetadata", () => {
  it.each([
    ["status", { status: 404 }],
    ["response.status", { response: { status: 404 } }],
    ["code", { code: 404 }],
    ["code as text", { code: "404" }],
  ])("a 404 (%s) is a file this grant cannot see: null", async (_label, shape) => {
    api.get.mockRejectedValue(Object.assign(new Error("File not found: 1AbC."), shape));
    expect(await googleDriveSession(linked).getMetadata("1AbC")).toBeNull();
  });

  it("any other failure throws to the caller, which owns its policy", async () => {
    api.get.mockRejectedValue(Object.assign(new Error("Backend Error"), { status: 503 }));
    await expect(googleDriveSession(linked).getMetadata("1AbC")).rejects.toThrow("Backend Error");
  });
});

describe("list and search: Drive's query language, quoted", () => {
  it("lists a folder's untrashed children with the same per-file mask", async () => {
    api.list.mockResolvedValue({ data: { files: [resource()], nextPageToken: "next-1" } });
    const page = await googleDriveSession(linked).list({
      pageSize: 25,
      parentExternalId: "0ParentFolderId0000000000",
    });
    expect(api.list.mock.calls[0]).toEqual([
      {
        q: "'0ParentFolderId0000000000' in parents and trashed = false",
        fields: `nextPageToken,files(${PLAN_FIELDS})`,
        pageSize: 25,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        spaces: "drive",
      },
    ]);
    expect(page.files.map((f) => f.externalId)).toEqual(["1AbCdEfGhIjKlMnOpQrStUvWxYz012345"]);
    expect(page.nextPageToken).toBe("next-1");
  });

  it("null lists the root; the page size is clamped; the token is passed on", async () => {
    api.list.mockResolvedValue({ data: {} });
    const page = await googleDriveSession(linked).list({
      pageSize: 5000,
      pageToken: "tok",
      parentExternalId: null,
    });
    expect(api.list.mock.calls[0]?.[0]).toMatchObject({
      q: "'root' in parents and trashed = false",
      pageSize: 100,
      pageToken: "tok",
    });
    expect(page).toEqual({ files: [], nextPageToken: null });
  });

  it("a parent id that is not a Drive id lists nothing and calls nothing", async () => {
    const page = await googleDriveSession(linked).list({
      pageSize: 10,
      parentExternalId: "x' or name contains '",
    });
    expect(page).toEqual({ files: [], nextPageToken: null });
    expect(api.list).not.toHaveBeenCalled();
  });

  it("search escapes the quote and the backslash of the text", async () => {
    api.list.mockResolvedValue({ data: { files: [] } });
    await googleDriveSession(linked).search({ pageSize: 10, text: "it's a \\ test" });
    expect(api.list.mock.calls[0]?.[0]).toMatchObject({
      q: "name contains 'it\\'s a \\\\ test' and trashed = false",
      fields: `nextPageToken,files(${PLAN_FIELDS})`,
    });
  });

  it("an empty search text matches nothing and calls nothing", async () => {
    expect(await googleDriveSession(linked).search({ pageSize: 10, text: "   " })).toEqual({
      files: [],
      nextPageToken: null,
    });
    expect(api.list).not.toHaveBeenCalled();
  });
});

describe("fetchForSummary (D5d): the bytes a summary is made from", () => {
  const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345";
  const DOC = "application/vnd.google-apps.document";
  const SLIDES = "application/vnd.google-apps.presentation";
  const SHEET = "application/vnd.google-apps.spreadsheet";
  const LINKS = /webContentLink|exportLinks|thumbnailLink/;

  const streamOf = (text: string) => ({ data: Readable.from([Buffer.from(text, "utf8")]) });
  const fetch = (mimeType: string | null, maxBytes = 1_000) =>
    googleDriveSession(linked).fetchForSummary(ID, { maxBytes, mimeType });
  const failure = (status: number | null, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error("Request failed"), {
      ...(status === null ? { code: "ECONNRESET" } : { status, response: { status } }),
      config: { headers: { Authorization: "Bearer ya29.SECRET" } },
      ...extra,
    });

  it.each([
    ["a Doc", DOC, "text/plain"],
    ["a Slides deck", SLIDES, "text/plain"],
    ["a Sheet (its first sheet only)", SHEET, "text/csv"],
  ])("%s (%s) is exported as %s, streamed, on the account's client", async (_label, type, exported) => {
    api.export.mockResolvedValue(streamOf("Minutes of the review."));
    expect(await fetch(type)).toEqual({ ok: true, bytes: Buffer.from("Minutes of the review.") });
    expect(api.export).toHaveBeenCalledTimes(1);
    const [params, options] = api.export.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(params).toEqual({ fileId: ID, mimeType: exported });
    expect(options).toMatchObject({ responseType: "stream" });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(api.get).not.toHaveBeenCalled();
    expect(api.drive).toHaveBeenCalledWith({ version: "v3", auth: linked.client });
  });

  it.each([
    ["a PDF", "application/pdf"],
    ["a text file", "text/plain"],
    ["an unknown type", null],
  ])("%s is read with alt=media", async (_label, type) => {
    api.get.mockResolvedValue(streamOf("%PDF-1.4"));
    expect(await fetch(type)).toEqual({ ok: true, bytes: Buffer.from("%PDF-1.4") });
    const [params, options] = api.get.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(params).toEqual({ fileId: ID, alt: "media", supportsAllDrives: true });
    expect(options).toMatchObject({ responseType: "stream" });
    expect(api.export).not.toHaveBeenCalled();
  });

  it("asks for no field and no link: it never fetches a URL Google hands over", async () => {
    api.export.mockResolvedValue(streamOf("a"));
    api.get.mockResolvedValue(streamOf("b"));
    await fetch(DOC);
    await fetch("application/pdf");
    for (const call of [...api.export.mock.calls, ...api.get.mock.calls]) {
      expect(JSON.stringify(call[0])).not.toMatch(LINKS);
      expect(call[0]).not.toHaveProperty("fields");
    }
  });

  it("past the cap it stops reading and answers too-large, whatever was declared", async () => {
    let pulled = 0;
    const body = Readable.from(
      (function* () {
        for (let i = 0; i < 100; i += 1) {
          pulled += 1;
          yield Buffer.alloc(100, 0x61);
        }
      })(),
    );
    api.get.mockResolvedValue({ data: body });
    expect(await fetch("text/plain", 250)).toEqual({ ok: false, reason: "too-large" });
    expect(pulled).toBeLessThan(10);
    expect(body.destroyed).toBe(true);
  });

  it.each([
    ["in the parsed error", failure(403, { errors: [{ reason: "exportSizeLimitExceeded" }] })],
    [
      "in a streamed request's text body",
      failure(403, {
        response: {
          status: 403,
          data: '{"error":{"code":403,"errors":[{"reason":"exportSizeLimitExceeded"}]}}',
        },
      }),
    ],
  ])("Google's export size error (%s) is too-large", async (_label, err) => {
    api.export.mockRejectedValue(err);
    expect(await fetch(DOC)).toEqual({ ok: false, reason: "too-large" });
  });

  it("a 404 is a file this grant no longer sees: null", async () => {
    api.export.mockRejectedValue(failure(404));
    expect(await fetch(DOC)).toBeNull();
  });

  it.each([
    ["a 429", failure(429)],
    ["a 403 rate limit", failure(403, { errors: [{ reason: "userRateLimitExceeded" }] })],
    ["a 500", failure(500)],
    ["a 503", failure(503)],
    ["a network error", failure(null)],
    ["a revoked grant (the refresh job flags the account)", failure(401)],
  ])("%s throws a retryable StorageError, naming no secret", async (_label, err) => {
    api.get.mockRejectedValue(err);
    const thrown = await fetch("application/pdf").catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(StorageError);
    expect((thrown as StorageError).retryable).toBe(true);
    expect((thrown as StorageError).message).not.toMatch(/SECRET|Bearer/);
    expect((thrown as StorageError).cause).toBeUndefined();
  });

  it("any other refusal is a StorageError that is not retried", async () => {
    api.get.mockRejectedValue(failure(403, { errors: [{ reason: "fileNotDownloadable" }] }));
    const thrown = await fetch("application/pdf").catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(StorageError);
    expect((thrown as StorageError).retryable).toBe(false);
    expect((thrown as StorageError).message).toBe("Google Drive answered 403 fileNotDownloadable");
  });

  it("a body that never ends is given up at D4's deadline: retryable, aborted, released", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const body = new Readable({ read() {} });
    let signal: AbortSignal | undefined;
    api.get.mockImplementation(async (_params: unknown, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return { data: body };
    });
    const pending = fetch("application/pdf").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(DRIVE_SUMMARY_READ_TIMEOUT_MS);
    const thrown = await pending;
    expect(thrown).toBeInstanceOf(StorageError);
    expect((thrown as StorageError).retryable).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(body.destroyed).toBe(true);
  });

  it("a Google format with no text export, or an id that is not a Drive id, calls nothing", async () => {
    await expect(fetch("application/vnd.google-apps.form")).rejects.toThrow(/no text export/);
    expect(
      await googleDriveSession(linked).fetchForSummary("not an id", {
        maxBytes: 10,
        mimeType: "application/pdf",
      }),
    ).toBeNull();
    expect(api.get).not.toHaveBeenCalled();
    expect(api.export).not.toHaveBeenCalled();
  });
});
