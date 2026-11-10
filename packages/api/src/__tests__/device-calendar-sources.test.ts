/**
 * C6: the device calendar sources of a user. The list shows only the user's DEVICE
 * sources, by the device's key and the calendar's title (never another provider's
 * account, never a raw identifier). Turning a calendar off removes that one
 * source, its rows and their attention items through the shared unlink, scoped to
 * the user and to provider DEVICE.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  captureError: vi.fn(),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock("../db.js", () => {
  const prisma = { linkedCalendarAccount: { findMany: m.findMany, findFirst: m.findFirst } };
  return { prisma, db: prisma };
});
vi.mock("../pim/linked-calendar-unlink.js", () => ({ unlinkCalendarAccount: m.unlink }));
vi.mock("../sentry.js", () => ({ captureError: m.captureError }));

import {
  DEVICE_SOURCE_EXPIRY_DAYS,
  deviceSourceEmail,
  expireStaleDeviceSources,
  listDeviceSources,
  removeDeviceSource,
} from "../pim/device-calendar/device-sources.js";

const KEY = "d".repeat(64);
const UPLOADED = new Date("2026-10-02T02:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  m.findMany.mockResolvedValue([]);
  m.findFirst.mockResolvedValue(null);
  m.unlink.mockResolvedValue(true);
});

describe("listDeviceSources", () => {
  it("asks for this user's DEVICE accounts only", async () => {
    await listDeviceSources("u1");
    expect(m.findMany).toHaveBeenCalledWith({
      where: { userId: "u1", provider: "DEVICE" },
      select: { email: true, displayName: true, updatedAt: true },
      orderBy: { createdAt: "asc" },
    });
  });

  it("answers the device's key and the calendar title, never the stored email", async () => {
    m.findMany.mockResolvedValue([
      { email: deviceSourceEmail(KEY), displayName: "Family", updatedAt: UPLOADED },
      // A malformed row (cannot be written by this code) is left out, not echoed.
      { email: "device:not-a-key", displayName: "Odd", updatedAt: UPLOADED },
    ]);
    expect(await listDeviceSources("u1")).toEqual([
      { key: KEY, title: "Family", uploadedAt: UPLOADED },
    ]);
  });
});

describe("removeDeviceSource (the user turned the calendar off)", () => {
  it("removes the user's source with its rows through the shared unlink, scoped to DEVICE", async () => {
    m.findFirst.mockResolvedValue({ id: "acct-dev" });

    expect(await removeDeviceSource("u1", KEY)).toBe(true);

    expect(m.findFirst).toHaveBeenCalledWith({
      where: { userId: "u1", provider: "DEVICE", email: deviceSourceEmail(KEY) },
      select: { id: true },
    });
    expect(m.unlink).toHaveBeenCalledWith("u1", "acct-dev", "DEVICE");
  });

  it("removes nothing for a calendar the user does not have", async () => {
    expect(await removeDeviceSource("u1", KEY)).toBe(false);
    expect(m.unlink).not.toHaveBeenCalled();
  });

  it("removes nothing, and asks nothing, for a malformed key", async () => {
    expect(await removeDeviceSource("u1", "5C7B3D2E-1F4A-4B6C-9D8E-0A1B2C3D4E5F")).toBe(false);
    expect(m.findFirst).not.toHaveBeenCalled();
    expect(m.unlink).not.toHaveBeenCalled();
  });

  it("answers what the unlink did (a concurrent removal that lost answers false)", async () => {
    m.findFirst.mockResolvedValue({ id: "acct-dev" });
    m.unlink.mockResolvedValue(false);
    expect(await removeDeviceSource("u1", KEY)).toBe(false);
  });
});

describe("expireStaleDeviceSources (a Mac wiped, offline or uninstalled: P4)", () => {
  const NOW = new Date("2026-10-20T00:00:00.000Z");

  it(`removes every DEVICE source not refreshed for ${DEVICE_SOURCE_EXPIRY_DAYS} days, through the shared unlink`, async () => {
    m.findMany.mockResolvedValue([
      { id: "acct-1", userId: "u1" },
      { id: "acct-2", userId: "u2" },
    ]);

    expect(await expireStaleDeviceSources(NOW)).toBe(2);

    expect(m.findMany).toHaveBeenCalledWith({
      where: {
        provider: "DEVICE",
        updatedAt: { lt: new Date(NOW.getTime() - DEVICE_SOURCE_EXPIRY_DAYS * 86_400_000) },
      },
      select: { id: true, userId: true },
      orderBy: { updatedAt: "asc" },
      take: expect.any(Number),
    });
    expect(m.unlink).toHaveBeenNthCalledWith(1, "u1", "acct-1", "DEVICE");
    expect(m.unlink).toHaveBeenNthCalledWith(2, "u2", "acct-2", "DEVICE");
  });

  it("counts only what the unlink removed, and finds nothing to do quietly", async () => {
    m.findMany.mockResolvedValue([{ id: "acct-1", userId: "u1" }]);
    m.unlink.mockResolvedValue(false);
    expect(await expireStaleDeviceSources(NOW)).toBe(0);
    m.findMany.mockResolvedValue([]);
    expect(await expireStaleDeviceSources(NOW)).toBe(0);
  });

  it("one failing source does not block the rest of the sweep", async () => {
    m.findMany.mockResolvedValue([
      { id: "acct-1", userId: "u1" },
      { id: "acct-2", userId: "u2" },
      { id: "acct-3", userId: "u3" },
    ]);
    m.unlink
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("deadlock detected"))
      .mockResolvedValueOnce(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await expireStaleDeviceSources(NOW)).toBe(2);

    expect(m.unlink).toHaveBeenCalledTimes(3);
    expect(m.unlink).toHaveBeenNthCalledWith(3, "u3", "acct-3", "DEVICE");
    expect(m.captureError).toHaveBeenCalledTimes(1);
    expect(m.captureError.mock.calls[0]?.[1]).toMatchObject({
      tags: { scope: "calendar.device.source_expiry" },
    });
    warn.mockRestore();
  });

  it("the scheduler's comment claims no index that does not exist", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const scheduler = readFileSync(
      fileURLToPath(new URL("../automation-scheduler.ts", import.meta.url)),
      "utf8",
    );
    expect(scheduler).not.toContain("one indexed read");
  });

  it("runs from the scheduler's hourly block", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const scheduler = readFileSync(
      fileURLToPath(new URL("../automation-scheduler.ts", import.meta.url)),
      "utf8",
    );
    expect(scheduler).toContain("expireStaleDeviceSources(");
    expect(scheduler).toContain("DEVICE_SOURCE_EXPIRY_INTERVAL_MS");
    // Behind the flag, like every other DEVICE path.
    expect(scheduler).toMatch(
      /deviceCalendarEnabled\(\) &&\s+Date\.now\(\) - lastDeviceSourceExpiryAt/,
    );
  });
});
