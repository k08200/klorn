/**
 * D5c: what Klorn reads of a Google Drive file and how it becomes the seam's
 * ProviderDriveFile (drive/providers/google-files.ts), and the session's reads
 * (drive/providers/google.ts) over a mocked googleapis: no Google call is real.
 *
 *   - `files.get` asks for EXACTLY the plan's fields, with supportsAllDrives;
 *   - a 404 is "not granted": null, never an error;
 *   - the link is kept only on docs.google.com or drive.google.com, over https;
 *   - the etag is `md5:<md5Checksum>` when Drive reports one, else `v:<version>`;
 *   - the listing and the search quote what they put in Drive's query language.
 *
 * `fetchForSummary` is D5d: it still refuses, and calls nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  drive: vi.fn(),
}));

vi.mock("googleapis", () => ({
  google: {
    drive: (options: unknown) => {
      api.drive(options);
      return { files: { get: api.get, list: api.list } };
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
  api.drive.mockReset();
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

describe("fetchForSummary is D5d", () => {
  it("refuses with a message naming D5d, and calls nothing", async () => {
    await expect(
      googleDriveSession(linked).fetchForSummary("1AbC", { maxBytes: 10 }),
    ).rejects.toThrow(/D5d/);
    expect(api.get).not.toHaveBeenCalled();
    expect(api.list).not.toHaveBeenCalled();
  });
});
