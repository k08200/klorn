/**
 * Reply state (2026-09-14): the chip every reference client shows first.
 * "replied" is a recorded fact and beats the judged "needsReply"; marking
 * is user-scoped and fail-soft (a send that went out must not fail on
 * bookkeeping).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  updateManyCalls: [] as unknown[],
  fail: false,
  captured: [] as unknown[],
}));

vi.mock("../db.js", () => ({
  prisma: {
    emailMessage: {
      updateMany: vi.fn(async (args: unknown) => {
        if (state.fail) throw new Error("db down");
        state.updateManyCalls.push(args);
        return { count: 1 };
      }),
    },
  },
}));

vi.mock("../sentry.js", () => ({
  captureError: vi.fn((err: unknown) => {
    state.captured.push(err);
  }),
}));

import { markEmailReplied, replyStateOf } from "../mail/reply-state.js";

describe("replyStateOf", () => {
  it("a recorded reply beats the judged need; nothing claims nothing", () => {
    expect(replyStateOf({ needsReply: true, repliedAt: null })).toBe("needsReply");
    expect(replyStateOf({ needsReply: true, repliedAt: new Date() })).toBe("replied");
    expect(replyStateOf({ needsReply: false, repliedAt: null })).toBeNull();
    // Rows from a partially-selected query (older callers) carry neither.
    expect(replyStateOf({})).toBeNull();
  });
});

describe("markEmailReplied", () => {
  beforeEach(() => {
    state.updateManyCalls.length = 0;
    state.captured.length = 0;
    state.fail = false;
  });

  it("stamps repliedAt on the user's own row by id or gmailId", async () => {
    await markEmailReplied("user-1", "abc123");
    expect(state.updateManyCalls).toHaveLength(1);
    const call = state.updateManyCalls[0] as { where: unknown; data: { repliedAt: Date } };
    expect(call.where).toEqual({ userId: "user-1", OR: [{ id: "abc123" }, { gmailId: "abc123" }] });
    expect(call.data.repliedAt).toBeInstanceOf(Date);
  });

  it("never throws — a bookkeeping failure is captured, the send already went out", async () => {
    state.fail = true;
    await expect(markEmailReplied("user-1", "abc123")).resolves.toBeUndefined();
    expect(state.captured).toHaveLength(1);
  });
});
