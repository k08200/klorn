import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * trackTokenUsage persists per-call LLM token counts + estimated cost for cost
 * monitoring. It is fire-and-forget from the agent loop, so a telemetry write
 * must never break the loop — but the old `catch {}` swallowed failures
 * silently, losing ALL cost observability with zero signal. These tests pin the
 * doctrine fix: on a DB failure it logs + captures (never throws), and the
 * happy/edge paths still behave.
 */

const state = vi.hoisted(() => ({ shouldThrow: false }));

vi.mock("../db.js", () => ({
  db: {
    tokenUsage: {
      create: vi.fn(async (args: { data: unknown }) => {
        if (state.shouldThrow) throw new Error("db down");
        return args.data;
      }),
    },
  },
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { db } from "../db.js";
import { captureError } from "../sentry.js";
import { trackTokenUsage } from "../token-usage.js";

const dataOf = (call: number) =>
  vi.mocked(db.tokenUsage.create).mock.calls[call]?.[0].data as Record<string, unknown>;

describe("trackTokenUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.shouldThrow = false;
  });

  it("persists token counts and an estimated cost", async () => {
    await trackTokenUsage(
      "user-1",
      { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      "gpt-test",
    );
    expect(db.tokenUsage.create).toHaveBeenCalledTimes(1);
    expect(dataOf(0)).toMatchObject({
      userId: "user-1",
      model: "gpt-test",
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    });
    expect(typeof dataOf(0).estimatedCost).toBe("number");
  });

  it("derives total when total_tokens is absent", async () => {
    await trackTokenUsage("u", { prompt_tokens: 10, completion_tokens: 7 }, "m");
    expect(dataOf(0).totalTokens).toBe(17);
  });

  it("no-ops when usage is undefined (no write)", async () => {
    await trackTokenUsage("u", undefined, "m");
    expect(db.tokenUsage.create).not.toHaveBeenCalled();
  });

  it("on a DB failure: captures + logs, never throws (no silent swallow)", async () => {
    state.shouldThrow = true;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(trackTokenUsage("user-9", { total_tokens: 5 }, "m")).resolves.toBeUndefined();

    expect(captureError).toHaveBeenCalledTimes(1);
    const scope = (vi.mocked(captureError).mock.calls[0]?.[1] as { tags?: { scope?: string } })
      ?.tags?.scope;
    expect(scope).toBe("agent.track_token_usage");
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
