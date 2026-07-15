import { beforeEach, describe, expect, it, vi } from "vitest";

const findManySpy = vi.fn();

vi.mock("../db.js", () => {
  const prisma = {
    pendingAction: {
      findMany: (...args: unknown[]) => findManySpy(...args),
    },
  };
  return { prisma, db: prisma };
});

import { buildRejectionHintForPrompt, REJECTION_HINT_LIMIT } from "../learning/rejection-hint.js";

beforeEach(() => {
  findManySpy.mockReset();
});

describe("buildRejectionHintForPrompt", () => {
  it("returns empty string when the user has no rejections with reasons", async () => {
    findManySpy.mockResolvedValue([]);
    expect(await buildRejectionHintForPrompt("u1")).toBe("");
  });

  it("returns empty string when the query throws (hints never break the agent)", async () => {
    findManySpy.mockRejectedValue(new Error("db down"));
    expect(await buildRejectionHintForPrompt("u1")).toBe("");
  });

  it("renders most-recent-first lines with toolName and reason", async () => {
    findManySpy.mockResolvedValue([
      { toolName: "send_email", rejectionReason: "Wrong recipient" },
      { toolName: "create_event", rejectionReason: "Already scheduled" },
    ]);

    const hint = await buildRejectionHintForPrompt("u1");
    expect(hint).toContain("The user rejected these proposed actions recently");
    expect(hint).toContain("avoid repeating these mistakes");
    expect(hint.indexOf("Wrong recipient")).toBeLessThan(hint.indexOf("Already scheduled"));
    expect(hint).toContain("send_email");
    expect(hint).toContain("create_event");
  });

  it("queries only REJECTED rows with a reason, capped at the limit, newest first", async () => {
    findManySpy.mockResolvedValue([]);
    await buildRejectionHintForPrompt("u1");

    expect(findManySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "u1",
          status: "REJECTED",
          rejectionReason: { not: null },
        }),
        orderBy: { updatedAt: "desc" },
        take: REJECTION_HINT_LIMIT,
      }),
    );
    expect(REJECTION_HINT_LIMIT).toBe(5);
  });

  it("truncates a single overlong reason so the hint stays small", async () => {
    findManySpy.mockResolvedValue([{ toolName: "send_email", rejectionReason: "a".repeat(500) }]);

    const hint = await buildRejectionHintForPrompt("u1");
    expect(hint.length).toBeLessThan(400);
    expect(hint).toContain("…");
  });

  it("skips rows whose reason is blank after trimming", async () => {
    findManySpy.mockResolvedValue([
      { toolName: "send_email", rejectionReason: "   " },
      { toolName: "create_event", rejectionReason: "Duplicate of an existing event" },
    ]);

    const hint = await buildRejectionHintForPrompt("u1");
    expect(hint).not.toContain("send_email");
    expect(hint).toContain("Duplicate of an existing event");
  });
});
