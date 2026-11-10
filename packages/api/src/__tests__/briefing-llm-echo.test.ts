/**
 * The briefing prompt wraps external text in <untrusted_content>. A model can
 * echo those tags back. They must never reach what the user reads: the saved
 * Note (shown on the briefing page) and the notification and push body.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  llmContent: "" as string,
  noteCreates: [] as Array<{ data: { content: string } }>,
  notifications: [] as Array<{ data: { message: string } }>,
  pushes: [] as Array<{ body: string }>,
  ws: [] as Array<{ message: string }>,
}));

vi.mock("../db.js", () => {
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) =>
          vi.fn(async (args?: { data?: { content?: string; message?: string } }) => {
            if (name === "note" && method === "create") {
              state.noteCreates.push(args as { data: { content: string } });
              return { id: "n1", createdAt: new Date() };
            }
            if (name === "notification" && method === "create") {
              state.notifications.push(args as { data: { message: string } });
              return { id: "no1", createdAt: new Date() };
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
  createCompletion: vi.fn(async () => ({ choices: [{ message: { content: state.llmContent } }] })),
}));
vi.mock("../pim/tasks.js", () => ({ listTasks: vi.fn(async () => ({ tasks: [] })) }));
vi.mock("../mail/gmail.js", () => ({ listEmails: vi.fn(async () => ({ emails: [] })) }));
vi.mock("../pim/notes.js", () => ({ listNotes: vi.fn(async () => ({ notes: [] })) }));
vi.mock("../llm/llm-credentials.js", () => ({
  getUserLlmCredentials: vi.fn(async () => undefined),
}));
vi.mock("../websocket.js", () => ({
  pushNotification: vi.fn((_u: string, n: { message: string }) => state.ws.push(n)),
}));
vi.mock("../notify/push.js", () => ({
  sendPushNotification: vi.fn(async (_u: string, p: { body: string }) => {
    state.pushes.push(p);
  }),
}));

import { createDailyBriefingDelivery, ensureDailyBriefingNotification } from "../pim/briefing.js";

const WRAPPED =
  'Standup shapes today: <untrusted_content source="calendar:summary">Standup</untrusted_content> ' +
  'then the 3 PM call. Also <untrusted_content source="email:subject">Invoice</untrusted_content>.';
const CLEAN = "Standup shapes today: Standup then the 3 PM call. Also Invoice.";

beforeEach(() => {
  state.llmContent = WRAPPED;
  state.noteCreates = [];
  state.notifications = [];
  state.pushes = [];
  state.ws = [];
});

describe("a model that echoes the untrusted wrapper", () => {
  it("is saved, shown and pushed as clean text", async () => {
    const delivery = await createDailyBriefingDelivery("u1");

    expect(delivery.briefing).toBe(CLEAN);
    expect(state.noteCreates[0]?.data.content).toBe(CLEAN);
    expect(state.notifications[0]?.data.message).toBe(CLEAN);
    expect(state.pushes[0]?.body).toBe(CLEAN);
    expect(state.ws[0]?.message).toBe(CLEAN);
  });

  it("a stored note that already has tags is cleaned before it is announced", async () => {
    await ensureDailyBriefingNotification("u1", WRAPPED, "2026-10-01");

    expect(state.notifications[0]?.data.message).toBe(CLEAN);
    expect(state.pushes[0]?.body).toBe(CLEAN);
  });

  it("leaves text without tags untouched", async () => {
    state.llmContent = "Plain briefing.";
    const delivery = await createDailyBriefingDelivery("u1");
    expect(delivery.briefing).toBe("Plain briefing.");
  });
});
