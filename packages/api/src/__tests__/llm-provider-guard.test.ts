/**
 * "Is any LLM configured?" must be answered by the real provider chain, not by
 * whether one particular provider's key happens to be set.
 *
 * The old guard was the legacy `openai` export — the OpenRouter client — so a
 * deploy that ran on ANTHROPIC_API_KEY alone silently returned the raw rule
 * template for every smart auto-reply, returned null for every guideline
 * reply, and switched the autonomous agent off at boot. Nothing errored; the
 * features just stopped. These tests pin the guard against a single-provider
 * Anthropic env and the genuinely-unconfigured env.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createCompletion = vi.hoisted(() => vi.fn());
const markSchedulerDisabled = vi.hoisted(() => vi.fn());
const registerScheduler = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => {
  const prisma = {
    emailRule: { findMany: vi.fn(), update: vi.fn() },
    automationConfig: { findUnique: vi.fn(async () => null) },
  };
  return { prisma, db: prisma };
});
vi.mock("../llm/openai.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../llm/openai.js")>()),
  createCompletion,
}));
vi.mock("../scheduler-heartbeat.js", () => ({
  markSchedulerDisabled,
  registerScheduler,
  recordSchedulerTick: vi.fn(),
  resetSchedulerHeartbeats: vi.fn(),
}));
vi.mock("../agentcore/autonomous-agent.js", () => ({ runAgentForUser: vi.fn() }));
vi.mock("../billing/stripe.js", () => ({ planHasFeature: vi.fn(() => true) }));
vi.mock("../judge/attention-mirror.js", () => ({
  bulkResolveAttentionForPendingActions: vi.fn(),
}));
vi.mock("../learning/feedback.js", () => ({
  recipientFromToolArgs: vi.fn(),
  recordFeedback: vi.fn(),
}));

const EMAIL = { from: "a@example.com", subject: "Hi", body: "Can we meet Tuesday?" };
const PROVIDER_ENV = [
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "OPENAI_COMPAT_BASE_URL",
  "LLM_PROVIDER_ORDER",
] as const;

function clearProviderEnv(): void {
  for (const name of PROVIDER_ENV) vi.stubEnv(name, "");
}

beforeEach(() => {
  vi.resetModules();
  createCompletion.mockReset();
  createCompletion.mockResolvedValue({ choices: [{ message: { content: "LLM reply" } }] });
  markSchedulerDisabled.mockReset();
  registerScheduler.mockReset();
  clearProviderEnv();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hasLlmProvider", () => {
  it("is true with only ANTHROPIC_API_KEY set", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    const { hasLlmProvider } = await import("../providers/index.js");

    expect(hasLlmProvider()).toBe(true);
  });

  it("is true with only a local OpenAI-compatible endpoint", async () => {
    vi.stubEnv("OPENAI_COMPAT_BASE_URL", "http://localhost:11434/v1");
    const { hasLlmProvider } = await import("../providers/index.js");

    expect(hasLlmProvider()).toBe(true);
  });

  it("is false when no provider is configured", async () => {
    const { hasLlmProvider } = await import("../providers/index.js");

    expect(hasLlmProvider()).toBe(false);
  });
});

describe("auto-reply drafting with only ANTHROPIC_API_KEY", () => {
  it("generateSmartReply calls the LLM instead of returning the raw template", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    const { generateSmartReply } = await import("../mail/email-reply.js");

    const reply = await generateSmartReply("Template body", EMAIL, "user-1");

    expect(createCompletion).toHaveBeenCalledTimes(1);
    expect(reply).toBe("LLM reply");
  });

  it("generateGuidelineReply calls the LLM instead of returning null", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    const { generateGuidelineReply } = await import("../mail/email-reply.js");

    const reply = await generateGuidelineReply(EMAIL, "user-1", "Be brief.");

    expect(createCompletion).toHaveBeenCalledTimes(1);
    expect(reply).toBe("LLM reply");
  });

  it("still returns the template without calling the LLM when nothing is configured", async () => {
    const { generateSmartReply } = await import("../mail/email-reply.js");

    const reply = await generateSmartReply("Template body", EMAIL, "user-1");

    expect(createCompletion).not.toHaveBeenCalled();
    expect(reply).toBe("Template body");
  });
});

describe("autonomous agent boot with only ANTHROPIC_API_KEY", () => {
  it("starts the agent loop", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.useFakeTimers();
    const { startAutonomousAgent, stopAutonomousAgent } = await import(
      "../agentcore/autonomous-agent-scheduler.js"
    );

    try {
      startAutonomousAgent();

      expect(markSchedulerDisabled).not.toHaveBeenCalled();
      expect(registerScheduler).toHaveBeenCalledWith("autonomous-agent", expect.any(Number));
    } finally {
      stopAutonomousAgent();
      vi.useRealTimers();
    }
  });

  it("stays disabled when no provider is configured", async () => {
    vi.useFakeTimers();
    const { startAutonomousAgent, stopAutonomousAgent } = await import(
      "../agentcore/autonomous-agent-scheduler.js"
    );

    try {
      startAutonomousAgent();

      expect(markSchedulerDisabled).toHaveBeenCalledWith("autonomous-agent");
      expect(registerScheduler).not.toHaveBeenCalled();
    } finally {
      stopAutonomousAgent();
      vi.useRealTimers();
    }
  });
});
