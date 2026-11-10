/**
 * Fallback-briefing self-heal: a transient LLM failure at generation time
 * persisted the rule-based fallback as the day's note, and every later read
 * reused it all day ("AI summary unavailable" stuck in the sidebar — founder
 * screenshots 2026-08-19/20). On reuse of a FALLBACK note, one regeneration
 * is attempted (10-min per-user cooldown); success rewrites the note, failure
 * keeps serving the fallback. AI-sourced notes never re-trigger the LLM.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  noteFindUniqueResult: null as { id: string; content: string; createdAt: Date } | null,
  llmContent: "FRESH BRIEFING" as string | null,
  llmThrows: false,
  createCompletionCalls: 0,
  noteUpdateCalls: [] as unknown[],
}));

vi.mock("../db.js", () => ({
  prisma: {
    automationConfig: {
      findUnique: vi.fn(() => Promise.resolve({ timezone: "America/New_York" })),
    },
    note: {
      findUnique: vi.fn(() => Promise.resolve(state.noteFindUniqueResult)),
      create: vi.fn(() => Promise.resolve({ id: "note-new", createdAt: new Date() })),
      update: vi.fn((args: unknown) => {
        state.noteUpdateCalls.push(args);
        return Promise.resolve({ id: "note-1" });
      }),
    },
    notification: {
      create: vi.fn(() => Promise.resolve({ id: "notif-new", createdAt: new Date() })),
    },
    pushDeliveryLog: { create: vi.fn(() => Promise.resolve({ id: "pdl-1" })) },
    device: { findMany: vi.fn(() => Promise.resolve([])) },
  },
}));

vi.mock("../llm/openai.js", () => ({
  MODEL: "test-model",
  createCompletion: vi.fn(() => {
    state.createCompletionCalls++;
    if (state.llmThrows) return Promise.reject(new Error("provider down"));
    return Promise.resolve({ choices: [{ message: { content: state.llmContent } }] });
  }),
}));
vi.mock("../pim/tasks.js", () => ({ listTasks: vi.fn(() => Promise.resolve({ tasks: [] })) }));
vi.mock("../mail/gmail.js", () => ({ listEmails: vi.fn(() => Promise.resolve({ emails: [] })) }));
vi.mock("../pim/notes.js", () => ({ listNotes: vi.fn(() => Promise.resolve({ notes: [] })) }));
vi.mock("../llm/llm-credentials.js", () => ({
  getUserLlmCredentials: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("../websocket.js", () => ({ pushNotification: vi.fn() }));
vi.mock("../notify/web-push.js", () => ({ sendWebPushToUser: vi.fn() }));

import {
  __resetBriefingHealCooldownForTests,
  createDailyBriefingDelivery,
  FALLBACK_BRIEFING_SENTINEL,
} from "../pim/briefing.js";

const FALLBACK_NOTE = () => ({
  id: "note-1",
  content: `${FALLBACK_BRIEFING_SENTINEL}\n\n**Top 3 Today**\n1. x`,
  createdAt: new Date(),
});

beforeEach(() => {
  state.noteFindUniqueResult = null;
  state.llmContent = "FRESH BRIEFING";
  state.llmThrows = false;
  state.createCompletionCalls = 0;
  state.noteUpdateCalls = [];
  __resetBriefingHealCooldownForTests();
});

describe("fallback briefing self-heal on reuse", () => {
  it("regenerates a cached FALLBACK note and rewrites it when the LLM recovers", async () => {
    state.noteFindUniqueResult = FALLBACK_NOTE();
    const result = await createDailyBriefingDelivery("user-1");
    expect(result.briefing).toBe("FRESH BRIEFING");
    expect(result.llm.source).toBe("ai");
    expect(state.noteUpdateCalls).toHaveLength(1);
    expect((state.noteUpdateCalls[0] as { data: { content: string } }).data.content).toBe(
      "FRESH BRIEFING",
    );
  });

  it("keeps serving the fallback when the retry also fails, without throwing", async () => {
    state.noteFindUniqueResult = FALLBACK_NOTE();
    state.llmThrows = true;
    const result = await createDailyBriefingDelivery("user-1");
    expect(result.briefing).toContain(FALLBACK_BRIEFING_SENTINEL);
    expect(result.llm.source).toBe("cache");
    expect(state.noteUpdateCalls).toHaveLength(0);
  });

  it("cools down: a second reuse inside the window does not call the LLM again", async () => {
    state.noteFindUniqueResult = FALLBACK_NOTE();
    state.llmThrows = true;
    await createDailyBriefingDelivery("user-1");
    const callsAfterFirst = state.createCompletionCalls;
    await createDailyBriefingDelivery("user-1");
    expect(state.createCompletionCalls).toBe(callsAfterFirst);
  });

  it("never re-triggers the LLM for an AI-sourced cached note", async () => {
    state.noteFindUniqueResult = { id: "note-2", content: "Real briefing", createdAt: new Date() };
    const result = await createDailyBriefingDelivery("user-1");
    expect(result.briefing).toBe("Real briefing");
    expect(result.llm.source).toBe("cache");
    expect(state.createCompletionCalls).toBe(0);
  });
});
