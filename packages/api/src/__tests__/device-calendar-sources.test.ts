/**
 * C6: the device calendar sources of a user. The list shows only the user's DEVICE
 * sources, by the device's key and the calendar's title (never another provider's
 * account, never a raw identifier). Turning a calendar off removes that one
 * source, its rows and their attention items through the shared unlink, scoped to
 * the user and to provider DEVICE.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  findMany: vi.fn(),
  findFirst: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock("../db.js", () => {
  const prisma = { linkedCalendarAccount: { findMany: m.findMany, findFirst: m.findFirst } };
  return { prisma, db: prisma };
});
vi.mock("../pim/linked-calendar-unlink.js", () => ({ unlinkCalendarAccount: m.unlink }));

import {
  deviceSourceEmail,
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
