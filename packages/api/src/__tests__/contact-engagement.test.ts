import { beforeEach, describe, expect, it, vi } from "vitest";

const upsert = vi.fn();
vi.mock("../db.js", () => ({
  prisma: { contactEngagementScore: { upsert: (a: unknown) => upsert(a) } },
}));

import { recordContactEngagement } from "../learning/contact-engagement.js";

describe("recordContactEngagement", () => {
  beforeEach(() => upsert.mockReset());

  it("increments outboundCount, normalizing the address to a lowercased addr-spec", async () => {
    upsert.mockResolvedValue({});
    await recordContactEngagement("u1", "Boss <BOSS@Corp.com>", "outbound");

    const arg = upsert.mock.calls[0][0] as {
      where: { userId_contactEmail: { userId: string; contactEmail: string } };
      create: { outboundCount: number; dismissCount: number; contactEmail: string };
      update: { outboundCount?: { increment: number }; dismissCount?: { increment: number } };
    };
    expect(arg.where).toEqual({
      userId_contactEmail: { userId: "u1", contactEmail: "boss@corp.com" },
    });
    expect(arg.create).toMatchObject({
      contactEmail: "boss@corp.com",
      outboundCount: 1,
      dismissCount: 0,
    });
    expect(arg.update.outboundCount).toEqual({ increment: 1 });
    expect(arg.update.dismissCount).toBeUndefined();
  });

  it("increments dismissCount for a dismiss engagement", async () => {
    upsert.mockResolvedValue({});
    await recordContactEngagement("u1", "x@y.com", "dismiss");

    const arg = upsert.mock.calls[0][0] as {
      create: { outboundCount: number; dismissCount: number };
      update: { dismissCount?: { increment: number } };
    };
    expect(arg.create).toMatchObject({ outboundCount: 0, dismissCount: 1 });
    expect(arg.update.dismissCount).toEqual({ increment: 1 });
  });

  it("skips the write when the address can't be parsed", async () => {
    await recordContactEngagement("u1", "", "outbound");
    expect(upsert).not.toHaveBeenCalled();
  });
});
