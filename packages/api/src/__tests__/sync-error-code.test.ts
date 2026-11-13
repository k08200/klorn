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
    // imapflow marks every refused LOGIN; a busy or rate-limiting server is not a revoked password.
    const refused = (code?: string) =>
      Object.assign(new Error("x"), { authenticationFailed: true, serverResponseCode: code });
    expect(imapSyncErrorCode(refused("AUTHENTICATIONFAILED"))).toBe("auth");
    expect(imapSyncErrorCode(refused())).toBe("auth");
    expect(imapSyncErrorCode(refused("UNAVAILABLE"))).toBe("throttled");
    expect(imapSyncErrorCode(refused("limit"))).toBe("throttled");
  });
});

describe("recordSyncError", () => {
  beforeEach(() => {
    updateMany.mockReset();
  });

  it("binds the write to the password the poll used, when given", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    await recordSyncError("u1", "row-1", "auth", "v2:old");
    expect(updateMany.mock.calls[0]?.[0]?.where).toMatchObject({ imapPasswordCipher: "v2:old" });
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
