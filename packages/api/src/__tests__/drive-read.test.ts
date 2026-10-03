/**
 * D2: the one drive read path (drive/drive-read.ts) and the export
 * (drive/drive-export.ts), against a fake database that EVALUATES each `where`:
 * the tests prove which rows a caller gets, not that a query was issued.
 *
 * Every read is scoped to one user, hides the rows of a provider whose flag is
 * off, is paged with a hard ceiling, and searches names with a bounded, escaped
 * pattern.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(() => dbHolder.current as FakeDb);
  return { prisma, db: prisma };
});

import { exportDriveFiles } from "../drive/drive-export.js";
import {
  DRIVE_PAGE_DEFAULT,
  DRIVE_PAGE_MAX,
  DRIVE_SEARCH_MAX_CHARS,
  decodeDriveCursor,
  encodeDriveCursor,
  escapeLikePattern,
  getFile,
  listFiles,
  normaliseDriveSearchText,
  searchFiles,
} from "../drive/drive-read.js";
import type { DriveProviderEnabledMap } from "../drive/drive-scope.js";

const on = () => true;
const off = () => false;
/** GOOGLE and KLORN connectors on, ONEDRIVE registered but off, DEVICE not registered. */
const MAP: DriveProviderEnabledMap = { KLORN: on, GOOGLE: on, ONEDRIVE: off };
const ME = "user-1";
const OTHER = "user-2";
const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const minutes = (n: number) => new Date(T0 + n * 60_000);

let seq = 0;
function file(over: Row = {}): Row {
  seq += 1;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  return {
    id,
    userId: ME,
    provider: "GOOGLE",
    sourceKey: "acct-1",
    externalId: `ext-${seq}`,
    name: `file ${seq}.pdf`,
    mimeType: "application/pdf",
    isFolder: false,
    sizeBytes: 1_000n,
    parentExternalId: null,
    modifiedAt: minutes(seq),
    webUrl: `https://drive.google.com/file/d/ext-${seq}/view`,
    storageKey: null,
    readOnly: true,
    trashed: false,
    ...over,
  };
}

let db: FakeDb;
function seed(rows: Row[]): void {
  db = createFakeDb({ driveFile: rows });
  dbHolder.current = db;
}

const names = (page: { files: Array<{ name: string }> }) => page.files.map((f) => f.name);

beforeEach(() => {
  seq = 0;
  vi.stubEnv("DRIVE_ENABLED", "true");
  seed([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("listFiles: whose rows", () => {
  beforeEach(() => {
    seed([
      file({ name: "mine old" }),
      file({ name: "theirs", userId: OTHER }),
      file({ name: "mine new" }),
      file({
        name: "mine klorn",
        provider: "KLORN",
        sourceKey: "klorn",
        webUrl: null,
        readOnly: false,
      }),
      file({ name: "mine onedrive (flag off)", provider: "ONEDRIVE", sourceKey: "acct-2" }),
      file({ name: "mine device (not registered)", provider: "DEVICE", sourceKey: "mac-1" }),
      file({ name: "mine trashed", trashed: true }),
    ]);
  });

  it("returns the caller's visible, untrashed rows, newest first", async () => {
    expect(names(await listFiles({ userId: ME }, MAP))).toEqual([
      "mine klorn",
      "mine new",
      "mine old",
    ]);
  });

  it("never returns another user's row", async () => {
    expect(names(await listFiles({ userId: OTHER }, MAP))).toEqual(["theirs"]);
    expect(names(await listFiles({ userId: "nobody" }, MAP))).toEqual([]);
  });

  it("hides every row while DRIVE_ENABLED is off", async () => {
    vi.stubEnv("DRIVE_ENABLED", "false");
    expect(await listFiles({ userId: ME }, MAP)).toEqual({ files: [], nextCursor: null });
  });

  it("hides every row with the shipped registry: D2 has no connector", async () => {
    expect(await listFiles({ userId: ME })).toEqual({ files: [], nextCursor: null });
  });

  it("a provider's rows come back the moment its flag is on", async () => {
    const page = await listFiles({ userId: ME }, { ...MAP, ONEDRIVE: on });
    expect(names(page)).toContain("mine onedrive (flag off)");
  });

  it("narrows to one provider or one source, and a filter never widens the kill switch", async () => {
    expect(names(await listFiles({ userId: ME, provider: "KLORN" }, MAP))).toEqual(["mine klorn"]);
    expect(
      names(await listFiles({ userId: ME, provider: "GOOGLE", sourceKey: "acct-1" }, MAP)),
    ).toEqual(["mine new", "mine old"]);
    expect(names(await listFiles({ userId: ME, sourceKey: "nope" }, MAP))).toEqual([]);
    expect(names(await listFiles({ userId: ME, provider: "ONEDRIVE" }, MAP))).toEqual([]);
    expect(names(await listFiles({ userId: ME, provider: "DEVICE" }, MAP))).toEqual([]);
  });
});

describe("listFiles: the wire shape", () => {
  it("is metadata only, JSON-safe, with no storage key", async () => {
    seed([
      file({
        provider: "KLORN",
        sourceKey: "klorn",
        webUrl: null,
        readOnly: false,
        sizeBytes: 5_000_000_000n,
        storageKey: "u/user-1/drive/secret",
        parentExternalId: "folder-1",
      }),
    ]);
    const { files } = await listFiles({ userId: ME }, MAP);
    expect(files).toEqual([
      {
        id: "00000000-0000-4000-8000-000000000001",
        provider: "KLORN",
        sourceKey: "klorn",
        externalId: "ext-1",
        name: "file 1.pdf",
        mimeType: "application/pdf",
        isFolder: false,
        sizeBytes: 5_000_000_000,
        parentExternalId: "folder-1",
        modifiedAt: "2026-10-01T00:01:00.000Z",
        webUrl: null,
        readOnly: false,
      },
    ]);
    expect(JSON.stringify(files)).not.toContain("secret");
  });

  it("never hands on a stored link that is not a safe https link", async () => {
    seed([file({ webUrl: "javascript:alert(1)" }), file({ webUrl: "http://example.com/x" })]);
    const { files } = await listFiles({ userId: ME }, MAP);
    expect(files.map((f) => f.webUrl)).toEqual([null, null]);
  });
});

describe("listFiles: paging", () => {
  it("serves the default page, and never more than the ceiling", async () => {
    seed(Array.from({ length: DRIVE_PAGE_MAX + 30 }, () => file()));
    expect((await listFiles({ userId: ME }, MAP)).files).toHaveLength(DRIVE_PAGE_DEFAULT);
    expect((await listFiles({ userId: ME, limit: 7 }, MAP)).files).toHaveLength(7);
    for (const limit of [DRIVE_PAGE_MAX + 1, 100_000, Number.MAX_SAFE_INTEGER]) {
      expect((await listFiles({ userId: ME, limit }, MAP)).files).toHaveLength(DRIVE_PAGE_MAX);
    }
  });

  it("falls back to the default for a limit that is not a positive whole number", async () => {
    seed(Array.from({ length: DRIVE_PAGE_DEFAULT + 5 }, () => file()));
    for (const limit of [0, -3, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect((await listFiles({ userId: ME, limit }, MAP)).files).toHaveLength(DRIVE_PAGE_DEFAULT);
    }
  });

  it("walks every visible row exactly once, in order, across rows that share a modified time", async () => {
    const same = minutes(500);
    seed([
      ...Array.from({ length: 7 }, () => file()),
      ...Array.from({ length: 6 }, () => file({ modifiedAt: same })),
      file({ userId: OTHER, modifiedAt: same }),
      file({ provider: "ONEDRIVE", modifiedAt: same }),
    ]);
    const all = (await listFiles({ userId: ME, limit: 100 }, MAP)).files.map((f) => f.id);
    expect(all).toHaveLength(13);

    const walked: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const decoded = cursor === null ? undefined : (decodeDriveCursor(cursor) ?? undefined);
      const page = await listFiles({ userId: ME, limit: 4, cursor: decoded }, MAP);
      walked.push(...page.files.map((f) => f.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);

    expect(pages).toBe(4);
    expect(walked).toEqual(all);
    expect(new Set(walked).size).toBe(13);
  });

  it("answers no next cursor when the page is the last one, exactly full or not", async () => {
    seed(Array.from({ length: 4 }, () => file()));
    expect((await listFiles({ userId: ME, limit: 4 }, MAP)).nextCursor).toBeNull();
    expect((await listFiles({ userId: ME, limit: 3 }, MAP)).nextCursor).not.toBeNull();
  });

  it("a cursor cannot reach another user's rows", async () => {
    seed([file({ userId: OTHER }), file({ userId: OTHER }), file()]);
    const cursor = { modifiedAt: minutes(10_000), id: "zzzz" };
    expect(names(await listFiles({ userId: ME, cursor }, MAP))).toEqual(["file 3.pdf"]);
  });
});

describe("the cursor", () => {
  it("round-trips", () => {
    const cursor = { modifiedAt: minutes(3), id: "00000000-0000-4000-8000-000000000003" };
    expect(decodeDriveCursor(encodeDriveCursor(cursor))).toEqual(cursor);
  });

  it("is opaque text a URL can carry", () => {
    expect(encodeDriveCursor({ modifiedAt: minutes(3), id: "abc" })).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");
  it.each([
    ["not a string", 42],
    ["empty", ""],
    ["not base64url", "!!!"],
    ["no separator", b64("2026-10-01T00:00:00.000Z")],
    ["a date that is not one", b64("2026-13-45T00:00:00.000Z|abc")],
    ["a date in another format", b64("Thu Oct 01 2026|abc")],
    ["an id with a space", b64("2026-10-01T00:00:00.000Z|a b")],
    ["an id with a NUL", b64("2026-10-01T00:00:00.000Z|a\u0000b")],
    ["an empty id", b64("2026-10-01T00:00:00.000Z|")],
    ["an oversized value", b64(`2026-10-01T00:00:00.000Z|${"a".repeat(300)}`)],
  ])("refuses %s", (_label, raw) => {
    expect(decodeDriveCursor(raw)).toBeNull();
  });
});

describe("searchFiles", () => {
  beforeEach(() => {
    seed([
      file({ name: "Q3 Report.pdf" }),
      file({ name: "q3 report draft.docx" }),
      file({ name: "Q3 Report (theirs).pdf", userId: OTHER }),
      file({ name: "Q3 Report onedrive.pdf", provider: "ONEDRIVE" }),
      file({ name: "Q3 Report trashed.pdf", trashed: true }),
      file({ name: "100% done.txt" }),
      file({ name: "100 percent.txt" }),
      file({ name: "a_b.txt" }),
      file({ name: "axb.txt" }),
      file({ name: "back\\slash.txt" }),
      file({ name: "보고서 최종.pdf" }),
    ]);
  });

  it("matches a part of the name, whatever the case, newest first", async () => {
    expect(names(await searchFiles({ userId: ME, text: "q3 REPORT" }, MAP))).toEqual([
      "q3 report draft.docx",
      "Q3 Report.pdf",
    ]);
  });

  it("never matches another user's row, a hidden provider's or a trashed one", async () => {
    const found = names(await searchFiles({ userId: ME, text: "report" }, MAP));
    expect(found).not.toContain("Q3 Report (theirs).pdf");
    expect(found).not.toContain("Q3 Report onedrive.pdf");
    expect(found).not.toContain("Q3 Report trashed.pdf");
    expect(names(await searchFiles({ userId: OTHER, text: "report" }, MAP))).toEqual([
      "Q3 Report (theirs).pdf",
    ]);
  });

  it("finds nothing while DRIVE_ENABLED is off, and nothing with the shipped registry", async () => {
    expect(await searchFiles({ userId: ME, text: "report" })).toEqual({
      files: [],
      nextCursor: null,
    });
    vi.stubEnv("DRIVE_ENABLED", "false");
    expect(await searchFiles({ userId: ME, text: "report" }, MAP)).toEqual({
      files: [],
      nextCursor: null,
    });
  });

  it("reads % and _ as the characters they are, never as wildcards", async () => {
    expect(names(await searchFiles({ userId: ME, text: "%" }, MAP))).toEqual(["100% done.txt"]);
    expect(names(await searchFiles({ userId: ME, text: "100%" }, MAP))).toEqual(["100% done.txt"]);
    expect(names(await searchFiles({ userId: ME, text: "_" }, MAP))).toEqual(["a_b.txt"]);
    expect(names(await searchFiles({ userId: ME, text: "a_b" }, MAP))).toEqual(["a_b.txt"]);
    expect(names(await searchFiles({ userId: ME, text: "%%%" }, MAP))).toEqual([]);
  });

  it("reads a backslash as a backslash", async () => {
    expect(names(await searchFiles({ userId: ME, text: "back\\slash" }, MAP))).toEqual([
      "back\\slash.txt",
    ]);
    expect(names(await searchFiles({ userId: ME, text: "\\" }, MAP))).toEqual(["back\\slash.txt"]);
  });

  it("finds a composed name from a decomposed query", async () => {
    const typed = "보고서".normalize("NFD");
    expect(names(await searchFiles({ userId: ME, text: typed }, MAP))).toEqual(["보고서 최종.pdf"]);
  });

  it("uses at most the first DRIVE_SEARCH_MAX_CHARS characters of the query", async () => {
    const long = "x".repeat(DRIVE_SEARCH_MAX_CHARS);
    seed([file({ name: `${long}.txt` })]);
    const text = `${long}${"y".repeat(400)}`;
    expect(names(await searchFiles({ userId: ME, text }, MAP))).toEqual([`${long}.txt`]);
  });

  it("a query with nothing to match on reads nothing at all", async () => {
    for (const text of ["", "   ", "\u0000\n\t"]) {
      expect(await searchFiles({ userId: ME, text }, MAP)).toEqual({ files: [], nextCursor: null });
    }
    expect(db.reads).toEqual([]);
  });

  it("is paged like the list, under the same ceiling", async () => {
    seed(Array.from({ length: DRIVE_PAGE_MAX + 20 }, () => file({ name: "match.txt" })));
    const first = await searchFiles({ userId: ME, text: "match", limit: 100_000 }, MAP);
    expect(first.files).toHaveLength(DRIVE_PAGE_MAX);
    const cursor = decodeDriveCursor(first.nextCursor) ?? undefined;
    const second = await searchFiles({ userId: ME, text: "match", limit: 100_000, cursor }, MAP);
    expect(second.files).toHaveLength(20);
    expect(second.nextCursor).toBeNull();
    const ids = new Set([...first.files, ...second.files].map((f) => f.id));
    expect(ids.size).toBe(DRIVE_PAGE_MAX + 20);
  });

  it("narrows to one provider like the list", async () => {
    seed([
      file({ name: "match a" }),
      file({ name: "match b", provider: "KLORN", sourceKey: "klorn" }),
    ]);
    expect(names(await searchFiles({ userId: ME, text: "match", provider: "KLORN" }, MAP))).toEqual(
      ["match b"],
    );
  });
});

describe("the search text", () => {
  it("is trimmed, composed, stripped of control characters and capped", () => {
    expect(normaliseDriveSearchText("  q3\u0000 report\n ")).toBe("q3 report");
    expect(normaliseDriveSearchText("보고서".normalize("NFD"))).toBe("보고서");
    expect([...(normaliseDriveSearchText("가".repeat(500)) ?? "")]).toHaveLength(
      DRIVE_SEARCH_MAX_CHARS,
    );
    expect(DRIVE_SEARCH_MAX_CHARS).toBe(100);
  });

  it.each([undefined, null, 7, "", "   ", "\u0000"])("is null for %j", (raw) => {
    expect(normaliseDriveSearchText(raw)).toBeNull();
  });

  it("escapes exactly the three characters LIKE gives a meaning to", () => {
    expect(escapeLikePattern("100%_a\\b")).toBe("100\\%\\_a\\\\b");
    expect(escapeLikePattern("plain.*(text)")).toBe("plain.*(text)");
  });
});

describe("getFile", () => {
  let mine: Row;
  let theirs: Row;
  let hidden: Row;
  let trashed: Row;

  beforeEach(() => {
    mine = file({ name: "mine" });
    theirs = file({ name: "theirs", userId: OTHER });
    hidden = file({ name: "hidden", provider: "ONEDRIVE" });
    trashed = file({ name: "trashed", trashed: true });
    seed([mine, theirs, hidden, trashed]);
  });

  it("returns the caller's own visible row", async () => {
    expect((await getFile(ME, mine.id as string, MAP))?.name).toBe("mine");
  });

  it("answers null for another user's row, a hidden provider's, a trashed one and an unknown id", async () => {
    expect(await getFile(ME, theirs.id as string, MAP)).toBeNull();
    expect(await getFile(ME, hidden.id as string, MAP)).toBeNull();
    expect(await getFile(ME, trashed.id as string, MAP)).toBeNull();
    expect(await getFile(ME, "00000000-0000-4000-8000-999999999999", MAP)).toBeNull();
  });

  it("answers null while DRIVE_ENABLED is off, and with the shipped registry", async () => {
    expect(await getFile(ME, mine.id as string)).toBeNull();
    vi.stubEnv("DRIVE_ENABLED", "false");
    expect(await getFile(ME, mine.id as string, MAP)).toBeNull();
  });

  it("the row comes back when its provider's flag is on", async () => {
    expect((await getFile(ME, hidden.id as string, { ...MAP, ONEDRIVE: on }))?.name).toBe("hidden");
  });

  it.each([
    "",
    "a b",
    "a\u0000b",
    "x".repeat(65),
    "../etc",
    7,
    null,
    undefined,
  ])("answers null for the id %j without a query", async (id) => {
    expect(await getFile(ME, id as string, MAP)).toBeNull();
    expect(db.reads).toEqual([]);
  });
});

describe("exportDriveFiles (the user's own data, on request)", () => {
  beforeEach(() => {
    seed([
      file({ name: "visible" }),
      file({ name: "hidden provider", provider: "ONEDRIVE" }),
      file({ name: "trashed", trashed: true }),
      file({
        name: "klorn",
        provider: "KLORN",
        sourceKey: "klorn",
        webUrl: null,
        storageKey: "u/user-1/secret",
        sizeBytes: 9_000_000_000n,
      }),
      file({ name: "theirs", userId: OTHER }),
    ]);
  });

  it("returns every row the system holds for the user, whatever the flags", async () => {
    vi.stubEnv("DRIVE_ENABLED", "false");
    const rows = await exportDriveFiles(ME);
    expect(rows.map((r) => r.name).sort()).toEqual([
      "hidden provider",
      "klorn",
      "trashed",
      "visible",
    ]);
  });

  it("never returns another user's row", async () => {
    expect((await exportDriveFiles(OTHER)).map((r) => r.name)).toEqual(["theirs"]);
    expect(await exportDriveFiles("nobody")).toEqual([]);
  });

  it("is JSON-safe and carries no storage key", async () => {
    const rows = await exportDriveFiles(ME);
    const json = JSON.stringify(rows);
    expect(json).not.toContain("secret");
    expect(json).not.toContain("storageKey");
    const klorn = rows.find((r) => r.name === "klorn");
    expect(klorn).toMatchObject({
      sizeBytes: 9_000_000_000,
      trashed: false,
      summaryStatus: "NONE",
    });
    expect(typeof klorn?.createdAt).toBe("string");
    expect(rows.find((r) => r.name === "trashed")?.trashed).toBe(true);
  });
});
