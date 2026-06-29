import { beforeEach, describe, expect, it, vi } from "vitest";

// Controllable device-table state for isDeviceSessionValid.
// Declared before vi.mock so the (lazily-invoked) factory closes over it.
const deviceState = { rowExists: false, count: 0 };

vi.mock("../db.js", () => {
  const device = {
    findUnique: vi.fn(async () => (deviceState.rowExists ? { id: "d1", userId: "u-1" } : null)),
    count: vi.fn(async () => deviceState.count),
    update: vi.fn(async () => ({})),
  };
  const prisma = { device, user: { findUnique: vi.fn(async () => null) } };
  return { prisma, db: prisma };
});

const { isDeviceSessionValid, signToken } = await import("../auth.js");
const token = signToken({ userId: "u-1", email: "a@b.com" });

describe("isDeviceSessionValid — session revocation on logout/kick", () => {
  beforeEach(() => {
    deviceState.rowExists = false;
    deviceState.count = 0;
  });

  it("accepts a token whose device row is present", async () => {
    deviceState.rowExists = true;
    expect(await isDeviceSessionValid(token)).toBe(true);
  });

  it("rejects a kicked token while the user still has other devices", async () => {
    deviceState.rowExists = false;
    deviceState.count = 2;
    expect(await isDeviceSessionValid(token)).toBe(false);
  });

  it("rejects a logged-out token even when it was the user's LAST device (H1)", async () => {
    // logout deletes this token's device row, dropping the user to zero devices.
    // The legacy "0 devices = allow through" branch must no longer re-accept it:
    // every real session has registered a device since 2026-03, and any
    // pre-device-tracking token expired long ago (7d TTL).
    deviceState.rowExists = false;
    deviceState.count = 0;
    expect(await isDeviceSessionValid(token)).toBe(false);
  });
});
