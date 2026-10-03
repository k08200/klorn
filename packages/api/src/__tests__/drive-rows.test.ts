/**
 * D2: drive/drive-rows.ts is the one place a DriveFile row is written. It states
 * the row's source (provider, sourceKey, externalId) and cleans what an external
 * drive sends: the name, the link, the type and the size are all attacker-controlled.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(() => dbHolder.current as FakeDb);
  return { prisma, db: prisma };
});

import { DRIVE_PROVIDER_NAMES } from "../drive/drive-providers.js";
import {
  connectedDriveSource,
  DRIVE_ID_MAX_CHARS,
  DRIVE_NAME_MAX_CHARS,
  type DriveFileInput,
  driveRowData,
  KLORN_DRIVE_SOURCE_KEY,
  klornDriveSource,
  upsertDriveFileRow,
} from "../drive/drive-rows.js";

const MODIFIED = new Date("2026-10-01T09:00:00.000Z");
const GOOGLE = connectedDriveSource("GOOGLE", "acct-1", "file-1");
const KLORN = klornDriveSource("k-1");

function input(init: Partial<DriveFileInput> = {}): DriveFileInput {
  return { name: "Q3 report.pdf", modifiedAt: MODIFIED, ...init };
}

function dataOf(source: typeof GOOGLE, init: Partial<DriveFileInput> = {}) {
  const result = driveRowData("user-1", source, input(init));
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.data;
}

function refusalOf(source: typeof GOOGLE, init: Partial<DriveFileInput> = {}) {
  const result = driveRowData("user-1", source, input(init));
  return result.ok ? null : result.reason;
}

describe("drive sources", () => {
  it("names exactly the providers of the Prisma enum", () => {
    expect([...DRIVE_PROVIDER_NAMES]).toEqual(["KLORN", "GOOGLE", "ONEDRIVE", "DEVICE"]);
  });

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
    expect(connectedDriveSource("ONEDRIVE", "acct-2", "item-9")).toEqual({
      provider: "ONEDRIVE",
      sourceKey: "acct-2",
      externalId: "item-9",
    });
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

  it("refuses a parent id that could not be an upstream id, instead of moving the file to the root", () => {
    expect(refusalOf(GOOGLE, { parentExternalId: "" })).toBe("identity");
    expect(refusalOf(GOOGLE, { parentExternalId: "a\u0000b" })).toBe("identity");
    expect(dataOf(GOOGLE, { parentExternalId: "folder-7" }).parentExternalId).toBe("folder-7");
    expect(dataOf(GOOGLE).parentExternalId).toBeNull();
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
    const stored = dataOf(GOOGLE, { name: long }).name;
    expect([...stored]).toHaveLength(DRIVE_NAME_MAX_CHARS);
    expect(
      dataOf(GOOGLE, { name: `${"a".repeat(DRIVE_NAME_MAX_CHARS - 1)}😀b` }).name.endsWith("😀"),
    ).toBe(true);
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
  });

  it("stores no link for a file Klorn holds: it opens through Klorn's own routes", () => {
    expect(dataOf(KLORN, { webUrl: "https://example.com/x" }).webUrl).toBeNull();
    expect(
      dataOf(connectedDriveSource("DEVICE", "mac-1", "d-1"), { webUrl: "https://example.com/x" })
        .webUrl,
    ).toBeNull();
  });
});

describe("driveRowData: type, size, flags", () => {
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
    expect(dataOf(GOOGLE, { sizeBytes: 10, isFolder: true }).sizeBytes).toBeNull();
  });

  it("an external row is always read-only (decision V4), whatever the caller says", () => {
    expect(dataOf(GOOGLE, { readOnly: false }).readOnly).toBe(true);
    expect(
      dataOf(connectedDriveSource("ONEDRIVE", "acct-2", "i-1"), { readOnly: false }).readOnly,
    ).toBe(true);
  });

  it("a Klorn file is editable unless the caller says otherwise", () => {
    expect(dataOf(KLORN).readOnly).toBe(false);
    expect(dataOf(KLORN, { readOnly: true }).readOnly).toBe(true);
  });

  it("defaults: a file, not trashed", () => {
    expect(dataOf(GOOGLE)).toMatchObject({ isFolder: false, trashed: false });
    expect(dataOf(GOOGLE, { isFolder: true, trashed: true })).toMatchObject({
      isFolder: true,
      trashed: true,
    });
  });
});

describe("driveRowData: the storage key", () => {
  it("is kept, opaque, for a file Klorn holds", () => {
    expect(dataOf(KLORN, { storageKey: "u/user-1/drive/k-1" }).storageKey).toBe(
      "u/user-1/drive/k-1",
    );
    expect(dataOf(KLORN).storageKey).toBeUndefined();
  });

  it("is refused on an external row: a connector's row never points at an object", () => {
    expect(refusalOf(GOOGLE, { storageKey: "u/user-1/drive/x" })).toBe("storageKey");
    expect(refusalOf(connectedDriveSource("ONEDRIVE", "a", "b"), { storageKey: "x" })).toBe(
      "storageKey",
    );
  });

  it("is refused when it could not be a key", () => {
    expect(refusalOf(KLORN, { storageKey: "" })).toBe("storageKey");
    expect(refusalOf(KLORN, { storageKey: "a\u0000b" })).toBe("storageKey");
    expect(refusalOf(KLORN, { storageKey: "k".repeat(1025) })).toBe("storageKey");
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
    const result = await upsertDriveFileRow("user-1", GOOGLE, input({ sizeBytes: 42 }));
    expect(result.ok).toBe(true);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      userId: "user-1",
      provider: "GOOGLE",
      sourceKey: "acct-1",
      externalId: "file-1",
      name: "Q3 report.pdf",
      sizeBytes: 42n,
      readOnly: true,
      trashed: false,
      storageKey: null,
      summaryStatus: "NONE",
    });
    expect(result.ok && result.id).toBe(rows()[0]?.id);
  });

  it("the same file again updates its row; it never makes a second", async () => {
    await upsertDriveFileRow("user-1", GOOGLE, input());
    const again = await upsertDriveFileRow(
      "user-1",
      GOOGLE,
      input({
        name: "Q3 report (final).pdf",
        trashed: true,
        modifiedAt: new Date("2026-10-02T00:00:00.000Z"),
      }),
    );
    expect(again.ok).toBe(true);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ name: "Q3 report (final).pdf", trashed: true });
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

  it("an update that names no storage key leaves the stored one alone", async () => {
    await upsertDriveFileRow("user-1", KLORN, input({ storageKey: "u/user-1/drive/k-1" }));
    await upsertDriveFileRow("user-1", KLORN, input({ name: "renamed.pdf" }));
    expect(rows()[0]).toMatchObject({ name: "renamed.pdf", storageKey: "u/user-1/drive/k-1" });
  });

  it("an update never touches the summary state, which D4 owns", async () => {
    await upsertDriveFileRow("user-1", GOOGLE, input());
    const [row] = rows();
    if (row) row.summaryStatus = "ANALYZED";
    await upsertDriveFileRow("user-1", GOOGLE, input({ name: "again.pdf" }));
    expect(rows()[0]?.summaryStatus).toBe("ANALYZED");
  });

  it("a refused row is not written, and says why", async () => {
    const result = await upsertDriveFileRow("user-1", GOOGLE, input({ storageKey: "x" }));
    expect(result).toEqual({ ok: false, reason: "storageKey" });
    expect(rows()).toHaveLength(0);
    expect(db.writes.driveFile ?? []).toEqual([]);
  });
});
