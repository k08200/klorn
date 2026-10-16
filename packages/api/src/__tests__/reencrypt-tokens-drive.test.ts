/**
 * D5a adds LinkedDriveAccount: a linked Google Drive (D5) or OneDrive (D6)
 * account's OAuth token pair, encrypted under the TOKEN_ENCRYPTION_KEYS ring.
 * The key-rotation sweep must cover it from day one: a rotation that skipped it
 * would strand every linked drive on the retired key (the lesson recorded for
 * LinkedInboxAccount.imapPasswordCipher and LinkedCalendarAccount.caldavPasswordCipher).
 */

import { describe, expect, it, vi } from "vitest";

const driveFindMany = vi.hoisted(() =>
  vi.fn(async (_args: unknown) => [
    { id: "drv-1", accessToken: "old:at", refreshToken: "old:rt" },
    { id: "drv-2", accessToken: "new:at2", refreshToken: "old:rt2" },
    { id: "drv-3", accessToken: "new:at3", refreshToken: "new:rt3" },
  ]),
);
const driveUpdateMany = vi.hoisted(() => vi.fn(async (_args: unknown) => ({ count: 1 })));
const disconnect = vi.hoisted(() => vi.fn(async () => {}));
const empty = { findMany: async () => [], updateMany: async () => ({ count: 0 }) };

vi.mock("../db.js", () => ({
  prisma: {
    userToken: empty,
    linkedInboxAccount: empty,
    linkedCalendarAccount: empty,
    user: empty,
    linkedDriveAccount: { findMany: driveFindMany, updateMany: driveUpdateMany },
    $disconnect: disconnect,
  },
}));
vi.mock("../crypto-tokens.js", () => ({
  activeKeyId: () => "k2",
  needsReencryption: (v: string | null | undefined) =>
    typeof v === "string" && v.startsWith("old:"),
  reencryptToActiveKey: (v: string) => v.replace("old:", "new:"),
}));

describe("re-encryption sweep — LinkedDriveAccount", () => {
  it("selects the token pair and rewrites only the stale ciphers, guarded by what it read", async () => {
    process.argv.push("--apply");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await import("../scripts/reencrypt-tokens.js");
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalled());
    const logged = logSpy.mock.calls.map((call) => String(call[0]));
    logSpy.mockRestore();
    process.argv.pop();

    expect(driveFindMany).toHaveBeenCalledTimes(1);
    const select = (driveFindMany.mock.calls[0]?.[0] as { select: Record<string, boolean> }).select;
    expect(select).toEqual({ id: true, accessToken: true, refreshToken: true });

    const writes = driveUpdateMany.mock.calls.map(
      (c) => c[0] as { where: Record<string, unknown>; data: Record<string, string> },
    );
    expect(writes).toHaveLength(2);
    const drv1 = writes.find((w) => w.where.id === "drv-1");
    expect(drv1?.data).toEqual({ accessToken: "new:at", refreshToken: "new:rt" });
    // Guarded by the ciphertext we read, so a concurrent refresh is never clobbered.
    expect(drv1?.where).toEqual({ id: "drv-1", accessToken: "old:at", refreshToken: "old:rt" });
    const drv2 = writes.find((w) => w.where.id === "drv-2");
    expect(drv2?.data).toEqual({ refreshToken: "new:rt2" });
    expect(drv2?.where).toEqual({ id: "drv-2", refreshToken: "old:rt2" });
    // Already current: never rewritten.
    expect(writes.find((w) => w.where.id === "drv-3")).toBeUndefined();

    expect(logged).toContain("  LinkedDriveAccount: scanned=3 rewritten=2 skipped=0 failed=0");
  });
});
