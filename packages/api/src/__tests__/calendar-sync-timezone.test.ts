import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The sync's zone is the user's configured one. It lives on AutomationConfig
 * (schema: AutomationConfig.timezone); User has no timezone column, so reading it
 * there gave every sync the default Asia/Seoul whatever the user configured.
 */

const h = vi.hoisted(() => ({
  config: null as null | { timezone: string },
  automationFindUnique: vi.fn(),
  userFindUnique: vi.fn(),
}));

vi.mock("../db.js", () => ({
  prisma: {
    automationConfig: { findUnique: h.automationFindUnique },
    user: { findUnique: h.userFindUnique },
  },
}));

import { readSyncTimezone } from "../pim/calendar-sync.js";

beforeEach(() => {
  h.automationFindUnique.mockReset();
  h.userFindUnique.mockReset();
  h.automationFindUnique.mockImplementation(async () => h.config);
  h.userFindUnique.mockResolvedValue({ id: "u1", email: "u1@example.test" });
});

describe("readSyncTimezone", () => {
  it("is the zone the user configured", async () => {
    h.config = { timezone: "America/New_York" };
    expect(await readSyncTimezone("u1")).toBe("America/New_York");
    expect(h.automationFindUnique).toHaveBeenCalledWith({
      where: { userId: "u1" },
      select: { timezone: true },
    });
    expect(h.userFindUnique).not.toHaveBeenCalled();
  });

  it("is the product default when the user has no configuration yet", async () => {
    h.config = null;
    expect(await readSyncTimezone("u1")).toBe("Asia/Seoul");
  });

  it("is the product default when the configured zone is not a real one", async () => {
    h.config = { timezone: "Mars/Olympus_Mons" };
    expect(await readSyncTimezone("u1")).toBe("Asia/Seoul");
  });
});
