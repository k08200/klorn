import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the heavy dependencies BEFORE importing the module under test
vi.mock("../autonomous-agent.js", () => ({
  runAgentForUser: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../db.js", () => ({
  prisma: {
    automationConfig: {
      findUnique: vi.fn(),
    },
  },
}));

import { runAgentForUser } from "../autonomous-agent.js";
import { prisma } from "../db.js";
import {
  __resetEmailActionTriggerState,
  scheduleAgentForActionableEmail,
} from "../email-action-trigger.js";

const flushImmediate = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("scheduleAgentForActionableEmail", () => {
  beforeEach(() => {
    __resetEmailActionTriggerState();
    vi.mocked(runAgentForUser).mockClear();
    vi.mocked(prisma.automationConfig.findUnique).mockReset();
    vi.mocked(prisma.automationConfig.findUnique).mockResolvedValue({
      agentMode: "SUGGEST",
      autonomousAgent: true,
    } as never);
  });

  afterEach(() => {
    __resetEmailActionTriggerState();
  });

  it("triggers the agent for PUSH-tier emails", async () => {
    scheduleAgentForActionableEmail("user-a", "PUSH");
    await flushImmediate();
    await flushImmediate();
    expect(runAgentForUser).toHaveBeenCalledTimes(1);
    expect(runAgentForUser).toHaveBeenCalledWith("user-a", "SUGGEST");
  });

  it("triggers the agent for QUEUE-tier emails", async () => {
    scheduleAgentForActionableEmail("user-a", "QUEUE");
    await flushImmediate();
    await flushImmediate();
    expect(runAgentForUser).toHaveBeenCalledTimes(1);
  });

  it("does NOT trigger the agent for SILENT-tier emails", async () => {
    scheduleAgentForActionableEmail("user-a", "SILENT");
    await flushImmediate();
    await flushImmediate();
    expect(runAgentForUser).not.toHaveBeenCalled();
  });

  it("does NOT trigger the agent for AUTO-tier emails by default (flag off)", async () => {
    scheduleAgentForActionableEmail("user-a", "AUTO");
    await flushImmediate();
    await flushImmediate();
    expect(runAgentForUser).not.toHaveBeenCalled();
  });

  it("triggers the agent for AUTO-tier emails when AUTO_TIER_EXECUTION is enabled", async () => {
    const prev = process.env.AUTO_TIER_EXECUTION;
    process.env.AUTO_TIER_EXECUTION = "true";
    try {
      scheduleAgentForActionableEmail("user-a", "AUTO");
      await flushImmediate();
      await flushImmediate();
      expect(runAgentForUser).toHaveBeenCalledTimes(1);
    } finally {
      if (prev === undefined) delete process.env.AUTO_TIER_EXECUTION;
      else process.env.AUTO_TIER_EXECUTION = prev;
    }
  });

  it("still ignores SILENT even when AUTO_TIER_EXECUTION is enabled", async () => {
    const prev = process.env.AUTO_TIER_EXECUTION;
    process.env.AUTO_TIER_EXECUTION = "true";
    try {
      scheduleAgentForActionableEmail("user-a", "SILENT");
      await flushImmediate();
      await flushImmediate();
      expect(runAgentForUser).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.AUTO_TIER_EXECUTION;
      else process.env.AUTO_TIER_EXECUTION = prev;
    }
  });

  it("debounces multiple triggers within the window to a single run", async () => {
    scheduleAgentForActionableEmail("user-a", "PUSH");
    scheduleAgentForActionableEmail("user-a", "QUEUE");
    scheduleAgentForActionableEmail("user-a", "PUSH");
    await flushImmediate();
    await flushImmediate();
    expect(runAgentForUser).toHaveBeenCalledTimes(1);
  });

  it("debounces per user — two distinct users both trigger independently", async () => {
    scheduleAgentForActionableEmail("user-a", "PUSH");
    scheduleAgentForActionableEmail("user-b", "PUSH");
    await flushImmediate();
    await flushImmediate();
    expect(runAgentForUser).toHaveBeenCalledTimes(2);
    expect(runAgentForUser).toHaveBeenCalledWith("user-a", "SUGGEST");
    expect(runAgentForUser).toHaveBeenCalledWith("user-b", "SUGGEST");
  });

  it("allows a second trigger after the debounce window has elapsed", async () => {
    const realNow = Date.now;
    let t = 1_000_000_000_000;
    Date.now = () => t;
    try {
      scheduleAgentForActionableEmail("user-a", "PUSH");
      await flushImmediate();
      await flushImmediate();
      expect(runAgentForUser).toHaveBeenCalledTimes(1);

      // Advance just past the 60s debounce window
      t += 61_000;
      scheduleAgentForActionableEmail("user-a", "PUSH");
      await flushImmediate();
      await flushImmediate();
      expect(runAgentForUser).toHaveBeenCalledTimes(2);
    } finally {
      Date.now = realNow;
    }
  });

  it("skips when autonomousAgent is disabled on the user's config", async () => {
    vi.mocked(prisma.automationConfig.findUnique).mockResolvedValue({
      agentMode: "SUGGEST",
      autonomousAgent: false,
    } as never);

    scheduleAgentForActionableEmail("user-a", "PUSH");
    await flushImmediate();
    await flushImmediate();
    expect(runAgentForUser).not.toHaveBeenCalled();
  });

  it("uses the user's configured agentMode (e.g. SHADOW) when invoking the agent", async () => {
    vi.mocked(prisma.automationConfig.findUnique).mockResolvedValue({
      agentMode: "SHADOW",
      autonomousAgent: true,
    } as never);

    scheduleAgentForActionableEmail("user-a", "PUSH");
    await flushImmediate();
    await flushImmediate();
    expect(runAgentForUser).toHaveBeenCalledWith("user-a", "SHADOW");
  });

  it("defaults to SUGGEST when the user has no automation config row", async () => {
    vi.mocked(prisma.automationConfig.findUnique).mockResolvedValue(null as never);

    scheduleAgentForActionableEmail("user-a", "PUSH");
    await flushImmediate();
    await flushImmediate();
    expect(runAgentForUser).toHaveBeenCalledWith("user-a", "SUGGEST");
  });

  it("swallows downstream agent errors so email-sync is never broken by trigger failures", async () => {
    vi.mocked(runAgentForUser).mockRejectedValueOnce(new Error("LLM exploded"));

    expect(() => scheduleAgentForActionableEmail("user-a", "PUSH")).not.toThrow();
    await flushImmediate();
    await flushImmediate();
    expect(runAgentForUser).toHaveBeenCalledTimes(1);
  });
});
