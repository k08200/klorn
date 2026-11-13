import { beforeEach, describe, expect, it, vi } from "vitest";

const updateMany = vi.hoisted(() => vi.fn());
vi.mock("../db.js", () => ({ prisma: { linkedInboxAccount: { updateMany } }, db: {} }));

const { imapSyncErrorCode, recordSyncError } = await import("../mail/sync-error-code.js");

describe("imapSyncErrorCode", () => {
  it("maps a refused login, a dead host, and anything else to short codes", () => {
    expect(imapSyncErrorCode(Object.assign(new Error("x"), { authenticationFailed: true }))).toBe(
      "auth",
    );
    expect(imapSyncErrorCode(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))).toBe(
      "unreachable",
    );
    expect(imapSyncErrorCode(Object.assign(new Error("x"), { code: "NoConnection" }))).toBe(
      "unreachable",
    );
    expect(imapSyncErrorCode(new Error("server said something odd"))).toBe("error");
  });
});

describe("recordSyncError", () => {
  beforeEach(() => {
    updateMany.mockReset();
  });

  it("writes the code only when it changed, scoped by id AND user", async () => {
    updateMany.mockResolvedValue({ count: 1 });
    await recordSyncError("u1", "row-1", "auth");
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "row-1",
        userId: "u1",
        OR: [{ syncErrorCode: null }, { syncErrorCode: { not: "auth" } }],
      },
      data: { syncErrorCode: "auth", syncErrorAt: expect.any(Date) },
    });
  });

  it("never throws", async () => {
    updateMany.mockImplementation(async () => {
      throw new Error("db down");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let threw = false;
    try {
      await recordSyncError("u1", "row-1", "error");
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
