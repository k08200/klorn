/**
 * The drive's background jobs reach only the cohort while a flag of theirs is
 * `cohort` (L23): the summary sweep's user pick and the Google refresh's
 * account pick narrow their query to the cohort's ids, so a user outside it
 * has no file sent to the model and no token used.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const prisma = vi.hoisted(() => ({
  driveFileSummary: { groupBy: vi.fn(async () => [] as unknown[]) },
  linkedDriveAccount: { findMany: vi.fn(async () => [] as unknown[]) },
}));
vi.mock("../db.js", () => ({ prisma, db: prisma }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const { dueSummaryUsers } = await import("../drive/summary-store.js");
const { dueDriveRefreshAccounts } = await import("../drive/linked-drive-accounts.js");

const NOW = new Date("2026-10-23T00:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the summary sweep's pick", () => {
  it("is every user by default", async () => {
    await dueSummaryUsers(NOW, 10);
    const where = (prisma.driveFileSummary.groupBy.mock.calls[0]?.[0] as { where: object }).where;
    expect(where).not.toHaveProperty("userId");
  });

  it("is only the cohort's users in cohort mode", async () => {
    await dueSummaryUsers(NOW, 10, { kind: "only", userIds: ["u1"] });
    expect(prisma.driveFileSummary.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: { in: ["u1"] } }) }),
    );
  });

  it("is no one, without a query, when the feature reaches no one", async () => {
    await expect(dueSummaryUsers(NOW, 10, { kind: "none" })).resolves.toEqual([]);
    expect(prisma.driveFileSummary.groupBy).not.toHaveBeenCalled();
  });
});

describe("the Google refresh's pick", () => {
  it("is only the cohort's accounts in cohort mode", async () => {
    await dueDriveRefreshAccounts("GOOGLE", NOW, 5, { kind: "only", userIds: ["u1", "u2"] });
    expect(prisma.linkedDriveAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: { in: ["u1", "u2"] } }),
      }),
    );
  });

  it("is no one, without a query, when the feature reaches no one", async () => {
    await expect(dueDriveRefreshAccounts("GOOGLE", NOW, 5, { kind: "none" })).resolves.toEqual([]);
    expect(prisma.linkedDriveAccount.findMany).not.toHaveBeenCalled();
  });
});
