/**
 * D2: drive/drive-rows.ts is the one place a DriveFile row is written. It states
 * the row's source (provider, sourceKey, externalId) and cleans what an external
 * drive sends: the name, the link, the type and the size are all attacker-controlled.
 * An update writes only what the input names, so a rename cannot turn a folder
 * into a file, move it, or bring it back from the trash.
 */

import { DriveProvider } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(() => dbHolder.current as FakeDb);
  return { prisma, db: prisma };
});

import { DRIVE_PROVIDER_NAMES, isReadOnlyDriveProvider } from "../drive/drive-providers.js";
import {
  connectedDriveSource,
  DRIVE_ID_MAX_CHARS,
  DRIVE_NAME_MAX_CHARS,
  type DriveFileInput,
  type DriveFileSource,
  driveRowData,
  KLORN_DRIVE_SOURCE_KEY,
  klornDriveSource,
  upsertDriveFileRow,
} from "../drive/drive-rows.js";

const MODIFIED = new Date("2026-10-01T09:00:00.000Z");
const LATER = new Date("2026-10-02T09:00:00.000Z");
const GOOGLE = connectedDriveSource("GOOGLE", "acct-1", "file-1");
const ONEDRIVE = connectedDriveSource("ONEDRIVE", "acct-2", "item-9");
const KLORN = klornDriveSource("k-1");

function input(init: Partial<DriveFileInput> = {}): DriveFileInput {
  return { name: "Q3 report.pdf", modifiedAt: MODIFIED, ...init };
}

function rowOf(source: DriveFileSource, init: Partial<DriveFileInput> = {}) {
  const result = driveRowData("user-1", source, input(init));
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result;
}

const dataOf = (source: DriveFileSource, init: Partial<DriveFileInput> = {}) =>
  rowOf(source, init).data;
const changesOf = (source: DriveFileSource, init: Partial<DriveFileInput> = {}) =>
  rowOf(source, init).changes;

function refusalOf(source: DriveFileSource, init: Partial<DriveFileInput> = {}) {
  const result = driveRowData("user-1", source, input(init));
  return result.ok ? null : result.reason;
}

describe("drive providers", () => {
  it("are exactly the Prisma enum's values, in its order", () => {
    expect([...DRIVE_PROVIDER_NAMES]).toEqual(Object.values(DriveProvider));
    expect([...DRIVE_PROVIDER_NAMES]).toEqual(["KLORN", "GOOGLE", "ONEDRIVE"]);
  });

  it("only the Klorn drive is writable; an external drive is read-only (decision V4)", () => {
    expect(DRIVE_PROVIDER_NAMES.filter((provider) => !isReadOnlyDriveProvider(provider))).toEqual([
      "KLORN",
    ]);
  });
});

describe("drive sources", () => {
  it("a Klorn file's source is the user's one Klorn drive", () => {
    expect(KLORN).toEqual({
      provider: "KLORN",
      sourceKey: KLORN_DRIVE_SOURCE_KEY,
      externalId: "k-1",
    });
    expect(KLORN_DRIVE_SOURCE_KEY).toBe("klorn");
  });

  it("a connected source carries its provider and the account it came from", () => {
    expect(GOOGLE).toEqual({ provider: "GOOGLE", sourceKey: "acct-1", externalId: "file-1" });
    expect(ONEDRIVE).toEqual({ provider: "ONEDRIVE", sourceKey: "acct-2", externalId: "item-9" });
  });
});

describe("driveRowData: the row's identity", () => {
  it("states the user, the provider, the source and the upstream id", () => {
    expect(dataOf(GOOGLE)).toMatchObject({
      userId: "user-1",
      provider: "GOOGLE",
      sourceKey: "acct-1",
      externalId: "file-1",
    });
  });

  it("the changes never carry the identity: an update cannot rewrite it", () => {
    const changes = changesOf(GOOGLE, { mimeType: "application/pdf", trashed: true });
    for (const key of ["userId", "provider", "sourceKey", "externalId"]) {
      expect(changes).not.toHaveProperty(key);
    }
  });

  it.each([
    ["an empty upstream id", connectedDriveSource("GOOGLE", "acct-1", "")],
    ["an empty source key", connectedDriveSource("GOOGLE", "", "file-1")],
    [
      "an oversized upstream id",
      connectedDriveSource("GOOGLE", "acct-1", "x".repeat(DRIVE_ID_MAX_CHARS + 1)),
    ],
    [
      "a control character in the upstream id",
      connectedDriveSource("GOOGLE", "acct-1", "a\u0000b"),
    ],
    ["a control character in the source key", connectedDriveSource("GOOGLE", "acct\n1", "file-1")],
  ])("refuses %s", (_label, source) => {
    expect(refusalOf(source)).toBe("identity");
  });

  it("refuses a parent id that could not be an upstream id, instead of dropping the parent", () => {
    expect(refusalOf(GOOGLE, { parentExternalId: "" })).toBe("identity");
    expect(refusalOf(GOOGLE, { parentExternalId: "a\u0000b" })).toBe("identity");
    expect(dataOf(GOOGLE, { parentExternalId: "folder-7" }).parentExternalId).toBe("folder-7");
  });

  it("a row with no parent named has no known parent", () => {
    expect(dataOf(GOOGLE).parentExternalId).toBeNull();
    expect(dataOf(GOOGLE, { parentExternalId: null }).parentExternalId).toBeNull();
  });

  it("refuses a modified time that is not a time", () => {
    expect(refusalOf(GOOGLE, { modifiedAt: new Date("nope") })).toBe("modifiedAt");
  });
});

describe("driveRowData: the name", () => {
  it("drops control characters and bidi overrides, which can disguise an extension", () => {
    expect(dataOf(GOOGLE, { name: "invoice‮fdp.exe" }).name).toBe("invoicefdp.exe");
    expect(dataOf(GOOGLE, { name: "a\u0000b\u0007c⁦d⁩" }).name).toBe("abcd");
    expect(dataOf(GOOGLE, { name: "  notes\n.txt  " }).name).toBe("notes.txt");
  });

  it("stores the composed form, so a name typed on a Mac and a search for it meet", () => {
    const decomposed = "보고서".normalize("NFD");
    expect(decomposed).not.toBe("보고서");
    expect(dataOf(GOOGLE, { name: `${decomposed}.pdf` }).name).toBe("보고서.pdf");
  });

  it("caps the length by character, never splitting one", () => {
    const long = `${"가".repeat(DRIVE_NAME_MAX_CHARS)}😀tail`;
    expect([...dataOf(GOOGLE, { name: long }).name]).toHaveLength(DRIVE_NAME_MAX_CHARS);
    const edge = `${"a".repeat(DRIVE_NAME_MAX_CHARS - 1)}😀b`;
    expect(dataOf(GOOGLE, { name: edge }).name.endsWith("😀")).toBe(true);
  });

  it("refuses a name with nothing left", () => {
    expect(refusalOf(GOOGLE, { name: " \u0000‮ " })).toBe("name");
    expect(refusalOf(GOOGLE, { name: 7 as unknown as string })).toBe("name");
  });
});

describe("driveRowData: the link", () => {
  it("keeps an https link of an external file", () => {
    expect(dataOf(GOOGLE, { webUrl: "https://drive.google.com/file/d/abc/view" }).webUrl).toBe(
      "https://drive.google.com/file/d/abc/view",
    );
  });

  it.each([
    "javascript:alert(1)",
    "http://drive.google.com/file/d/abc",
    "file:///etc/passwd",
    "https://user:pass@evil.example/x",
    "//evil.example/x",
    `https://example.com/${"a".repeat(2100)}`,
  ])("drops %s", (webUrl) => {
    expect(dataOf(GOOGLE, { webUrl }).webUrl).toBeNull();
    expect(changesOf(GOOGLE, { webUrl })).toMatchObject({ webUrl: null });
  });

  it("stores no link for a file Klorn holds: it opens through Klorn's own routes", () => {
    expect(dataOf(KLORN, { webUrl: "https://example.com/x" }).webUrl).toBeNull();
  });
});

describe("driveRowData: type, size, version, flags", () => {
  it("keeps a well-formed media type, lower-cased, and drops anything else", () => {
    expect(dataOf(GOOGLE, { mimeType: "Application/PDF" }).mimeType).toBe("application/pdf");
    expect(dataOf(GOOGLE, { mimeType: "application/vnd.google-apps.folder" }).mimeType).toBe(
      "application/vnd.google-apps.folder",
    );
    expect(dataOf(GOOGLE, { mimeType: "text/html; <script>" }).mimeType).toBeNull();
    expect(dataOf(GOOGLE, { mimeType: "nonsense" }).mimeType).toBeNull();
    expect(dataOf(GOOGLE).mimeType).toBeNull();
  });

  it("stores a size only when it is a whole, non-negative number of bytes", () => {
    expect(dataOf(GOOGLE, { sizeBytes: 5_000_000_000 }).sizeBytes).toBe(5_000_000_000n);
    expect(dataOf(GOOGLE, { sizeBytes: 12n }).sizeBytes).toBe(12n);
    expect(dataOf(GOOGLE, { sizeBytes: 0 }).sizeBytes).toBe(0n);
    for (const sizeBytes of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, -3n]) {
      expect(dataOf(GOOGLE, { sizeBytes }).sizeBytes).toBeNull();
    }
  });

  it("a folder has no size, whatever the source reports", () => {
    expect(dataOf(GOOGLE, { sizeBytes: 10, isFolder: true }).sizeBytes).toBeNull();
    expect(changesOf(GOOGLE, { isFolder: true })).toMatchObject({
      isFolder: true,
      sizeBytes: null,
    });
  });

  it("keeps the source's version as an opaque, bounded string", () => {
    expect(dataOf(GOOGLE, { etag: '"MTcyNzc4"' }).etag).toBe('"MTcyNzc4"');
    expect(dataOf(GOOGLE).etag).toBeNull();
    expect(dataOf(GOOGLE, { etag: null }).etag).toBeNull();
    expect(dataOf(GOOGLE, { etag: "" }).etag).toBeNull();
    expect(dataOf(GOOGLE, { etag: "a\u0000b" }).etag).toBeNull();
    expect(dataOf(GOOGLE, { etag: "e".repeat(DRIVE_ID_MAX_CHARS + 1) }).etag).toBeNull();
    expect(dataOf(GOOGLE, { etag: 7 as unknown as string }).etag).toBeNull();
  });

  it("a new row is a file, not trashed, unless the source says otherwise", () => {
    expect(dataOf(GOOGLE)).toMatchObject({ isFolder: false, trashed: false });
    expect(dataOf(GOOGLE, { isFolder: true, trashed: true })).toMatchObject({
      isFolder: true,
      trashed: true,
    });
  });

  it("has no read-only flag to store: that follows from the provider", () => {
    expect(dataOf(GOOGLE)).not.toHaveProperty("readOnly");
    expect(dataOf(KLORN)).not.toHaveProperty("readOnly");
  });
});

describe("driveRowData: the storage key", () => {
  it("is kept, opaque, for a file Klorn holds", () => {
    expect(dataOf(KLORN, { storageKey: "u/user-1/drive/k-1" }).storageKey).toBe(
      "u/user-1/drive/k-1",
    );
    expect(dataOf(KLORN).storageKey).toBeNull();
    expect(changesOf(KLORN)).not.toHaveProperty("storageKey");
  });

  it("is refused on an external row: a connector's row never points at an object", () => {
    expect(refusalOf(GOOGLE, { storageKey: "u/user-1/drive/x" })).toBe("storageKey");
    expect(refusalOf(ONEDRIVE, { storageKey: "x" })).toBe("storageKey");
  });

  it("is refused when it could not be a key", () => {
    expect(refusalOf(KLORN, { storageKey: "" })).toBe("storageKey");
    expect(refusalOf(KLORN, { storageKey: "a\u0000b" })).toBe("storageKey");
    expect(refusalOf(KLORN, { storageKey: "k".repeat(1025) })).toBe("storageKey");
  });
});

describe("driveRowData: the changes are only what the input names", () => {
  it("a name and a modified time alone change nothing else", () => {
    expect(changesOf(GOOGLE)).toEqual({ name: "Q3 report.pdf", modifiedAt: MODIFIED });
  });

  it("each field the input names is in the changes, cleaned", () => {
    expect(
      changesOf(GOOGLE, {
        mimeType: "Application/PDF",
        isFolder: false,
        sizeBytes: 42,
        parentExternalId: "folder-7",
        webUrl: "https://drive.google.com/file/d/abc/view",
        etag: "v7",
        trashed: true,
      }),
    ).toEqual({
      name: "Q3 report.pdf",
      modifiedAt: MODIFIED,
      mimeType: "application/pdf",
      isFolder: false,
      sizeBytes: 42n,
      parentExternalId: "folder-7",
      webUrl: "https://drive.google.com/file/d/abc/view",
      etag: "v7",
      trashed: true,
    });
  });

  it("an explicit null clears a field; leaving it out does not", () => {
    expect(changesOf(GOOGLE, { parentExternalId: null, mimeType: null, sizeBytes: null })).toEqual({
      name: "Q3 report.pdf",
      modifiedAt: MODIFIED,
      parentExternalId: null,
      mimeType: null,
      sizeBytes: null,
    });
  });

  it("the row to create is the defaults with the changes over them", () => {
    expect(dataOf(GOOGLE)).toEqual({
      userId: "user-1",
      provider: "GOOGLE",
      sourceKey: "acct-1",
      externalId: "file-1",
      name: "Q3 report.pdf",
      modifiedAt: MODIFIED,
      mimeType: null,
      isFolder: false,
      sizeBytes: null,
      parentExternalId: null,
      webUrl: null,
      storageKey: null,
      etag: null,
      trashed: false,
    });
  });
});

describe("upsertDriveFileRow", () => {
  let db: FakeDb;

  beforeEach(() => {
    db = createFakeDb({ driveFile: [] });
    dbHolder.current = db;
  });

  const rows = () => db.tables.driveFile ?? [];

  it("writes one row that states its provider and source", async () => {
    const result = await upsertDriveFileRow("user-1", GOOGLE, input({ sizeBytes: 42, etag: "v1" }));
    expect(result.ok).toBe(true);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      userId: "user-1",
      provider: "GOOGLE",
      sourceKey: "acct-1",
      externalId: "file-1",
      name: "Q3 report.pdf",
      sizeBytes: 42n,
      etag: "v1",
      trashed: false,
      storageKey: null,
    });
    expect(result.ok && result.id).toBe(rows()[0]?.id);
  });

  it("the same file again updates its row; it never makes a second", async () => {
    await upsertDriveFileRow("user-1", GOOGLE, input());
    const again = await upsertDriveFileRow(
      "user-1",
      GOOGLE,
      input({ name: "Q3 report (final).pdf", trashed: true, modifiedAt: LATER }),
    );
    expect(again.ok).toBe(true);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      name: "Q3 report (final).pdf",
      trashed: true,
      modifiedAt: LATER,
    });
  });

  it("the same upstream id in another source, provider or user is another row", async () => {
    await upsertDriveFileRow("user-1", GOOGLE, input());
    await upsertDriveFileRow("user-1", connectedDriveSource("GOOGLE", "acct-2", "file-1"), input());
    await upsertDriveFileRow(
      "user-1",
      connectedDriveSource("ONEDRIVE", "acct-1", "file-1"),
      input(),
    );
    await upsertDriveFileRow("user-2", GOOGLE, input());
    expect(rows()).toHaveLength(4);
  });

  it("updating only the name leaves every other field of a file untouched", async () => {
    await upsertDriveFileRow(
      "user-1",
      GOOGLE,
      input({
        mimeType: "application/pdf",
        sizeBytes: 2_048,
        parentExternalId: "folder-7",
        webUrl: "https://drive.google.com/file/d/file-1/view",
        etag: "v1",
        trashed: true,
      }),
    );
    await upsertDriveFileRow("user-1", GOOGLE, { name: "renamed.pdf", modifiedAt: LATER });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      name: "renamed.pdf",
      modifiedAt: LATER,
      isFolder: false,
      mimeType: "application/pdf",
      sizeBytes: 2_048n,
      parentExternalId: "folder-7",
      webUrl: "https://drive.google.com/file/d/file-1/view",
      etag: "v1",
      trashed: true,
    });
  });

  it("renaming a folder leaves it a folder, where it was", async () => {
    await upsertDriveFileRow(
      "user-1",
      GOOGLE,
      input({
        name: "Reports",
        isFolder: true,
        parentExternalId: "root-folder",
        mimeType: "application/vnd.google-apps.folder",
      }),
    );
    await upsertDriveFileRow("user-1", GOOGLE, { name: "Reports 2026", modifiedAt: LATER });
    expect(rows()[0]).toMatchObject({
      name: "Reports 2026",
      isFolder: true,
      parentExternalId: "root-folder",
      mimeType: "application/vnd.google-apps.folder",
      sizeBytes: null,
      trashed: false,
    });
  });

  it("a field the source names is written, a null included", async () => {
    await upsertDriveFileRow(
      "user-1",
      GOOGLE,
      input({ parentExternalId: "folder-7", trashed: true, sizeBytes: 10, etag: "v1" }),
    );
    await upsertDriveFileRow(
      "user-1",
      GOOGLE,
      input({ parentExternalId: null, trashed: false, sizeBytes: 20, etag: "v2" }),
    );
    expect(rows()[0]).toMatchObject({
      parentExternalId: null,
      trashed: false,
      sizeBytes: 20n,
      etag: "v2",
    });
  });

  it("an update that names no storage key leaves the stored one alone", async () => {
    await upsertDriveFileRow("user-1", KLORN, input({ storageKey: "u/user-1/drive/k-1" }));
    await upsertDriveFileRow("user-1", KLORN, input({ name: "renamed.pdf" }));
    expect(rows()[0]).toMatchObject({ name: "renamed.pdf", storageKey: "u/user-1/drive/k-1" });
  });

  it("a refused row is not written, and says why", async () => {
    const result = await upsertDriveFileRow("user-1", GOOGLE, input({ storageKey: "x" }));
    expect(result).toEqual({ ok: false, reason: "storageKey" });
    expect(rows()).toHaveLength(0);
    expect(db.writes.driveFile ?? []).toEqual([]);
  });
});
