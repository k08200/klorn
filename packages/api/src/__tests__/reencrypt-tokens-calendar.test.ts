/**
 * C1 adds LinkedCalendarAccount.caldavPasswordCipher — an AES-256-GCM secret.
 * The key-rotation sweep must cover it from day one: a rotation that skipped
 * it would strand every CalDAV account on the retired key (the same lesson
 * Phase 0b recorded for LinkedInboxAccount.imapPasswordCipher).
 */

import { describe, expect, it, vi } from "vitest";

const calendarFindMany = vi.hoisted(() =>
  vi.fn(async (_args: unknown) => [
    { id: "cal-1", accessToken: null, refreshToken: null, caldavPasswordCipher: "old:caldav" },
    { id: "cal-2", accessToken: "old:at", refreshToken: "old:rt", caldavPasswordCipher: null },
  ]),
);
const calendarUpdateMany = vi.hoisted(() => vi.fn(async () => ({ count: 1 })));
const disconnect = vi.hoisted(() => vi.fn(async () => {}));
const empty = { findMany: async () => [], updateMany: async () => ({ count: 0 }) };

vi.mock("../db.js", () => ({
  prisma: {
    userToken: empty,
    linkedInboxAccount: empty,
    user: empty,
    linkedCalendarAccount: { findMany: calendarFindMany, updateMany: calendarUpdateMany },
    $disconnect: disconnect,
  },
}));
vi.mock("../crypto-tokens.js", () => ({
  activeKeyId: () => "k2",
  needsReencryption: (v: string | null | undefined) =>
    typeof v === "string" && v.startsWith("old:"),
  reencryptToActiveKey: (v: string) => v.replace("old:", "new:"),
}));

describe("re-encryption sweep — LinkedCalendarAccount", () => {
  it("selects and rewrites caldavPasswordCipher alongside the OAuth token pair", async () => {
    process.argv.push("--apply");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await import("../scripts/reencrypt-tokens.js");
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalled());
    logSpy.mockRestore();
    process.argv.pop();

    const select = (calendarFindMany.mock.calls[0]?.[0] as { select: Record<string, boolean> })
      .select;
    expect(select).toMatchObject({ caldavPasswordCipher: true, accessToken: true });

    const writes = calendarUpdateMany.mock.calls.map(
      (c) => c[0] as unknown as { where: Record<string, unknown>; data: Record<string, string> },
    );
    const cal1 = writes.find((w) => w.where.id === "cal-1");
    expect(cal1?.data).toEqual({ caldavPasswordCipher: "new:caldav" });
    // Guarded by the ciphertext we read, so a concurrent rewrite is never clobbered.
    expect(cal1?.where).toEqual({ id: "cal-1", caldavPasswordCipher: "old:caldav" });

    const cal2 = writes.find((w) => w.where.id === "cal-2");
    expect(cal2?.data).toEqual({ accessToken: "new:at", refreshToken: "new:rt" });
  });
});
