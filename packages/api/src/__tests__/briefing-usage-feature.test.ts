/**
 * The briefing's model call is charged to the "pim/briefing" feature in the
 * usage ledger (LlmUsageLog.feature). The ledger reads the feature from the
 * calling module's path when the call passes none (llm/llm-caller.ts), so
 * moving the call site to another file would silently re-label every briefing
 * call and split the cost series. This pins the label wherever the call lives.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { callerFeatureFromStack } from "../llm/llm-caller.js";

const state = vi.hoisted(() => ({ features: [] as Array<string | null> }));

/** The stack as the ledger would read it, without this test file's own mock frame. */
function ledgerFeature(explicit: string | undefined): string | null {
  if (explicit) return explicit;
  const stack = new Error().stack ?? "";
  const frames = stack.split("\n").filter((frame) => !frame.includes("/__tests__/"));
  return callerFeatureFromStack(frames.join("\n"));
}

vi.mock("../db.js", () => {
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) =>
          vi.fn(async () => {
            if (name === "calendarEvent" && method === "findMany") {
              const start = new Date(Date.now() + 3 * 3_600_000);
              return [
                {
                  id: "ev-1",
                  title: "Planning",
                  description: null,
                  location: null,
                  startTime: start,
                  endTime: new Date(start.getTime() + 3_600_000),
                  allDay: false,
                  provider: "GOOGLE",
                  externalId: "g-1",
                  sourceAccountId: null,
                },
              ];
            }
            if (name === "automationConfig" && method === "findUnique") {
              return { notificationLanguage: "en", timezone: "UTC" };
            }
            return method === "findMany" ? [] : method === "count" ? 0 : null;
          }),
      },
    );
  const prisma = new Proxy({}, { get: (_t, name: string) => model(name) });
  return { prisma, db: prisma };
});
vi.mock("../llm/openai.js", () => ({
  MODEL: "test-model",
  createCompletion: vi.fn(async (_req: unknown, options: { feature?: string } = {}) => {
    state.features.push(ledgerFeature(options.feature));
    return { choices: [{ message: { content: "BRIEFING" } }] };
  }),
}));
vi.mock("../pim/tasks.js", () => ({ listTasks: vi.fn(async () => ({ tasks: [] })) }));
vi.mock("../mail/gmail.js", () => ({ listEmails: vi.fn(async () => ({ emails: [] })) }));
vi.mock("../pim/notes.js", () => ({ listNotes: vi.fn(async () => ({ notes: [] })) }));
vi.mock("../llm/llm-credentials.js", () => ({
  getUserLlmCredentials: vi.fn(async () => undefined),
}));
vi.mock("../websocket.js", () => ({ pushNotification: vi.fn() }));
vi.mock("../notify/web-push.js", () => ({ sendWebPushToUser: vi.fn() }));

import generateBriefing from "../pim/briefing.js";

beforeEach(() => {
  state.features = [];
});

describe("the briefing's usage-ledger feature", () => {
  it('is "pim/briefing"', async () => {
    await generateBriefing("user-1");
    expect(state.features).toEqual(["pim/briefing"]);
  });
});
