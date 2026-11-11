/**
 * An agent notify_user is LLM-decided. Its category still maps to the label,
 * preferences and quiet hours a human would expect (email → email_urgent,
 * calendar → meeting), but its push always rings against the ambient rate
 * bucket: the interrupt bucket is for the firewall's PUSH/MEETING mail, the
 * urgent keyword sweep, meeting alerts and reminders the user set
 * (push-bucket.ts, push-interrupt-callers-guard.test.ts).
 *
 * Drives the real runAgentForUser loop with the model's reply faked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createCompletion: vi.fn(),
  sendPushNotification: vi.fn(async () => ({ status: "sent" })),
}));

vi.mock("../db.js", () => {
  // Every model answers like an empty database; create echoes a row back.
  const model = () =>
    new Proxy(
      {},
      {
        get: (_target, method: string) =>
          vi.fn(async (args?: { data?: Record<string, unknown> }) => {
            if (method === "findMany" || method === "groupBy") return [];
            if (method === "count") return 0;
            if (method === "create" || method === "upsert" || method === "update") {
              return { id: "row-1", createdAt: new Date(), ...(args?.data ?? {}) };
            }
            if (method === "updateMany" || method === "deleteMany" || method === "createMany") {
              return { count: 0 };
            }
            return null;
          }),
      },
    );
  const models = new Map<string, unknown>();
  const client = new Proxy(
    {},
    {
      get: (_target, name: string) => {
        if (name.startsWith("$")) return vi.fn(async () => []);
        if (!models.has(name)) models.set(name, model());
        return models.get(name);
      },
    },
  );
  return { prisma: client, db: client };
});
vi.mock("../llm/openai.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../llm/openai.js")>()),
  createCompletion: mocks.createCompletion,
}));
vi.mock("../llm/llm-credentials.js", () => ({
  getUserLlmCredentials: vi.fn(async () => ({ userModel: null })),
}));
vi.mock("../agentcore/agent-context.js", () => ({
  gatherAgentContext: vi.fn(async () => ({
    text: "## Open Tasks (1)\n- [HIGH] Send the deck to Minsu",
    emails: [],
  })),
}));
vi.mock("../billing/token-usage.js", () => ({ trackTokenUsage: vi.fn(async () => undefined) }));
vi.mock("../websocket.js", () => ({ pushNotification: vi.fn() }));
vi.mock("../notify/push.js", () => ({ sendPushNotification: mocks.sendPushNotification }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { runAgentForUser } from "../agentcore/autonomous-agent.js";

function notifyUserReply(category: string) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "notify_user",
                arguments: JSON.stringify({
                  title: "Minsu is waiting on the deck",
                  message: "Minsu asked for the investor deck before 3pm today.",
                  priority: "high",
                  category,
                }),
              },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

const DONE = { choices: [{ message: { role: "assistant", content: "Done." } }], usage: {} };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("agent notify_user push bucket", () => {
  it.each([
    ["email", "email_urgent"],
    ["calendar", "meeting"],
    ["task", "task_due"],
  ])("category %s keeps its %s label but rings ambient", async (agentCategory, notifCategory) => {
    mocks.createCompletion
      .mockResolvedValueOnce(notifyUserReply(agentCategory))
      .mockResolvedValueOnce(DONE);

    await runAgentForUser(`user-${agentCategory}`, "SUGGEST");

    expect(mocks.sendPushNotification).toHaveBeenCalledTimes(1);
    const [, payload, category, options] = mocks.sendPushNotification.mock.calls[0] as unknown as [
      string,
      { title: string },
      string,
      unknown,
    ];
    expect(payload.title).toContain("Minsu is waiting on the deck");
    expect(category).toBe(notifCategory);
    expect(options).toEqual({ bucket: "ambient" });
  });
});
