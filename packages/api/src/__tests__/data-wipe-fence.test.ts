import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertWorkMayWrite,
  DATA_WIPE_FENCE_MARKER,
  DataWipeFenceError,
  type DataWipeState,
  fencedWriteOwners,
  isDataWipeFenceError,
  rememberDataWipe,
  setDataWipeReader,
} from "../privacy/data-wipe-fence.js";
import { runAsNewWork } from "../work-context.js";

const at = (iso: string) => new Date(iso);

let rows: Map<string, DataWipeState>;
let reads: number;

beforeEach(() => {
  rows = new Map();
  reads = 0;
  setDataWipeReader(async (userId) => {
    reads++;
    return rows.get(userId) ?? null;
  });
  vi.useFakeTimers();
  vi.setSystemTime(at("2026-10-19T03:00:00Z"));
});

afterEach(() => {
  setDataWipeReader(null);
  vi.useRealTimers();
});

describe("assertWorkMayWrite", () => {
  it("lets any work write for an account that was never wiped", async () => {
    await expect(runAsNewWork(() => assertWorkMayWrite("u1"))).resolves.toBeUndefined();
  });

  it("rejects every write while the wipe is pending, whatever the work's start", async () => {
    rows.set("u1", { purgedAt: null, fenceUntil: null });
    await expect(runAsNewWork(() => assertWorkMayWrite("u1"))).rejects.toBeInstanceOf(
      DataWipeFenceError,
    );
  });

  it("rejects work that began before fenceUntil, however late it writes", async () => {
    const stale = runAsNewWork(async () => {
      // The work began at 03:00; the wipe's fence ended at 03:10; it writes at 09:00.
      rows.set("u1", {
        purgedAt: at("2026-10-19T03:05:00Z"),
        fenceUntil: at("2026-10-19T03:10:00Z"),
      });
      vi.setSystemTime(at("2026-10-19T09:00:00Z"));
      return assertWorkMayWrite("u1");
    });
    await expect(stale).rejects.toBeInstanceOf(DataWipeFenceError);
  });

  it("lets work that began after fenceUntil write", async () => {
    rows.set("u1", {
      purgedAt: at("2026-10-19T03:05:00Z"),
      fenceUntil: at("2026-10-19T03:10:00Z"),
    });
    vi.setSystemTime(at("2026-10-19T03:11:00Z"));
    await expect(runAsNewWork(() => assertWorkMayWrite("u1"))).resolves.toBeUndefined();
  });

  it("treats a write outside any work as old (the process start), never as new", async () => {
    rows.set("u1", {
      purgedAt: at("2026-10-19T03:05:00Z"),
      fenceUntil: at("2099-01-01T00:00:00Z"),
    });
    await expect(assertWorkMayWrite("u1")).rejects.toBeInstanceOf(DataWipeFenceError);
  });

  it("reads each account's state at most once per cache window", async () => {
    await runAsNewWork(() => assertWorkMayWrite("u1"));
    await runAsNewWork(() => assertWorkMayWrite("u1"));
    expect(reads).toBe(1);
    vi.setSystemTime(at("2026-10-19T03:00:31Z"));
    await runAsNewWork(() => assertWorkMayWrite("u1"));
    expect(reads).toBe(2);
  });

  it("sees a wipe this process recorded at once, before the cache expires", async () => {
    await runAsNewWork(() => assertWorkMayWrite("u1"));
    rememberDataWipe("u1", { purgedAt: null, fenceUntil: null });
    await expect(runAsNewWork(() => assertWorkMayWrite("u1"))).rejects.toBeInstanceOf(
      DataWipeFenceError,
    );
  });
});

// Prisma's own error classes, matched by name as the module does.
class PrismaClientUnknownRequestError extends Error {}
class PrismaClientKnownRequestError extends Error {
  constructor(
    message: string,
    readonly meta: { code: string },
  ) {
    super(message);
  }
}
class PrismaClientValidationError extends Error {}

describe("isDataWipeFenceError", () => {
  it("recognizes the app error and both shapes Prisma gives the trigger's error", () => {
    expect(isDataWipeFenceError(new DataWipeFenceError())).toBe(true);
    // A model query: an unknown request error that carries the SQLSTATE.
    expect(
      isDataWipeFenceError(
        new PrismaClientUnknownRequestError(
          `Error occurred during query execution: ConnectorError(... code: "KW001", message: "${DATA_WIPE_FENCE_MARKER}: insert into Note rejected" ...)`,
        ),
      ),
    ).toBe(true);
    // Raw SQL: a known request error with meta.code.
    expect(
      isDataWipeFenceError(
        new PrismaClientKnownRequestError("Raw query failed.", { code: "KW001" }),
      ),
    ).toBe(true);
  });

  it("ignores other errors, even one whose text quotes the marker", () => {
    expect(isDataWipeFenceError(new Error("unique constraint failed"))).toBe(false);
    expect(isDataWipeFenceError(new Error(`${DATA_WIPE_FENCE_MARKER} KW001`))).toBe(false);
    // A validation error echoes the caller's input.
    expect(
      isDataWipeFenceError(
        new PrismaClientValidationError(`Unknown arg: "${DATA_WIPE_FENCE_MARKER} KW001"`),
      ),
    ).toBe(false);
  });
});

describe("fencedWriteOwners", () => {
  it("reads the owner of a create, by column or by relation", () => {
    expect(fencedWriteOwners("Note", "create", { data: { userId: "u1", title: "t" } })).toEqual([
      "u1",
    ]);
    expect(
      fencedWriteOwners("Note", "create", {
        data: { user: { connect: { id: "u2" } }, title: "t" },
      }),
    ).toEqual(["u2"]);
  });

  it("reads every owner of a createMany and the create side of an upsert", () => {
    expect(
      fencedWriteOwners("EmailMessage", "createMany", {
        data: [{ userId: "u1" }, { userId: "u2" }, { userId: "u1" }],
      }),
    ).toEqual(["u1", "u2"]);
    expect(
      fencedWriteOwners("AttentionItem", "upsert", {
        where: {},
        create: { userId: "u3" },
        update: {},
      }),
    ).toEqual(["u3"]);
  });

  it("ignores reads, updates and models the fence leaves alone", () => {
    expect(fencedWriteOwners("Note", "findMany", { where: { userId: "u1" } })).toEqual([]);
    expect(fencedWriteOwners("Note", "update", { data: { userId: "u1" } })).toEqual([]);
    expect(fencedWriteOwners("Device", "create", { data: { userId: "u1" } })).toEqual([]);
  });
});
