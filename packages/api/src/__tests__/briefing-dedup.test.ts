import { beforeEach, describe, expect, it, vi } from "vitest";

// The daily-briefing dedup is atomic via a DB unique + create-catch-P2002.
// These tests drive the winner/loser race paths so the push is provably
// WINNER-ONLY — the fix for the duplicate briefing web-push.
const state = vi.hoisted(() => ({
  // Controllable prisma behavior per test.
  noteFindUniqueResult: null as { id: string; content: string; createdAt: Date } | null,
  noteCreateP2002: false,
  notificationCreateP2002: false,
  pushCalls: 0,
  webPushCalls: 0,
}));

class MockPrismaError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

vi.mock("../db.js", () => ({
  prisma: {
    automationConfig: {
      findUnique: vi.fn(() => Promise.resolve({ timezone: "America/New_York" })),
    },
    note: {
      findUnique: vi.fn(() => Promise.resolve(state.noteFindUniqueResult)),
      create: vi.fn(() => {
        if (state.noteCreateP2002) return Promise.reject(new MockPrismaError("P2002"));
        return Promise.resolve({ id: "note-new", createdAt: new Date() });
      }),
    },
    notification: {
      create: vi.fn(() => {
        if (state.notificationCreateP2002) return Promise.reject(new MockPrismaError("P2002"));
        return Promise.resolve({ id: "notif-new", createdAt: new Date() });
      }),
    },
  },
}));

// generateBriefing is the expensive LLM path. Stub its transitive deps so it
// returns deterministic text without any network call, and so we can assert it
// is NOT invoked on the reuse paths.
const generateSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../openai.js", () => ({
  MODEL: "test-model",
  createCompletion: vi.fn(() => {
    generateSpy.calls++;
    return Promise.resolve({ choices: [{ message: { content: "GENERATED BRIEFING" } }] });
  }),
}));
vi.mock("../tasks.js", () => ({ listTasks: vi.fn(() => Promise.resolve({ tasks: [] })) }));
vi.mock("../gmail.js", () => ({ listEmails: vi.fn(() => Promise.resolve({ emails: [] })) }));
vi.mock("../notes.js", () => ({ listNotes: vi.fn(() => Promise.resolve({ notes: [] })) }));
vi.mock("../llm-credentials.js", () => ({
  getUserLlmCredentials: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("../notify/push.js", () => ({
  sendPushNotification: vi.fn(() => {
    state.webPushCalls++;
    return Promise.resolve();
  }),
}));
vi.mock("../websocket.js", () => ({
  pushNotification: vi.fn(() => {
    state.pushCalls++;
  }),
}));

import { createDailyBriefingDelivery, ensureDailyBriefingNotification } from "../briefing.js";
import { sendPushNotification } from "../notify/push.js";

const USER = "user-1";
const DAY_KEY = "2026-07-01";

beforeEach(() => {
  state.noteFindUniqueResult = null;
  state.noteCreateP2002 = false;
  state.notificationCreateP2002 = false;
  state.pushCalls = 0;
  state.webPushCalls = 0;
  generateSpy.calls = 0;
  vi.clearAllMocks();
});

describe("ensureDailyBriefingNotification — winner-only atomic push", () => {
  it("winner: creates the notification AND sends exactly one push", async () => {
    const result = await ensureDailyBriefingNotification(USER, "brief text", DAY_KEY);
    expect(result).toEqual({ id: "notif-new", createdAt: expect.any(Date) });
    expect(vi.mocked(sendPushNotification)).toHaveBeenCalledTimes(1);
    expect(state.pushCalls).toBe(1); // websocket push too
  });

  it("loser (P2002): returns null and does NOT push — no duplicate briefing web-push", async () => {
    state.notificationCreateP2002 = true;
    const result = await ensureDailyBriefingNotification(USER, "brief text", DAY_KEY);
    expect(result).toBeNull();
    expect(vi.mocked(sendPushNotification)).not.toHaveBeenCalled();
    expect(state.pushCalls).toBe(0);
  });

  it("uses a dayKey-scoped dedupeKey so distinct days do not collide", async () => {
    const { prisma } = await import("../db.js");
    await ensureDailyBriefingNotification(USER, "brief text", DAY_KEY);
    expect(vi.mocked(prisma.notification.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ dedupeKey: `briefing:${DAY_KEY}`, type: "briefing" }),
      }),
    );
  });
});

describe("createDailyBriefingDelivery — atomic note dedup", () => {
  it("existing note for the day → reused:true, generateBriefing NOT called", async () => {
    state.noteFindUniqueResult = {
      id: "note-existing",
      content: "yesterday's stored brief",
      createdAt: new Date(),
    };
    // The notification already exists too → create hits P2002 → no re-push.
    state.notificationCreateP2002 = true;

    const result = await createDailyBriefingDelivery(USER);

    expect(result.reused).toBe(true);
    expect(result.briefing).toBe("yesterday's stored brief");
    expect(result.note.id).toBe("note-existing");
    expect(result.notification).toBeNull();
    expect(generateSpy.calls).toBe(0); // no LLM call on the reuse path
    expect(vi.mocked(sendPushNotification)).not.toHaveBeenCalled();
  });

  it("P2002 on note.create (concurrent winner) → fetches winner note, reused:true", async () => {
    // findUnique misses first, we generate + create, but a concurrent caller
    // won the (userId, dayKey) race → create throws P2002. Recovery reads the
    // winner's note.
    state.noteFindUniqueResult = null; // first findUnique miss
    state.noteCreateP2002 = true;
    state.notificationCreateP2002 = true; // winner already pushed → we don't

    const { prisma } = await import("../db.js");
    // After the P2002, the recovery findUnique must return the winner's row.
    vi.mocked(prisma.note.findUnique)
      .mockResolvedValueOnce(null) // initial miss
      .mockResolvedValueOnce({
        id: "note-winner",
        content: "winner brief",
        createdAt: new Date(),
      } as never);

    const result = await createDailyBriefingDelivery(USER);

    expect(result.reused).toBe(true);
    expect(result.note.id).toBe("note-winner");
    expect(result.briefing).toBe("winner brief");
    expect(result.notification).toBeNull();
    expect(vi.mocked(sendPushNotification)).not.toHaveBeenCalled();
  });

  it("clean path: no existing note → generates, creates, winner pushes once, reused:false", async () => {
    state.noteFindUniqueResult = null;
    const result = await createDailyBriefingDelivery(USER);

    expect(result.reused).toBe(false);
    expect(result.briefing).toBe("GENERATED BRIEFING");
    expect(result.note.id).toBe("note-new");
    expect(result.notification).not.toBeNull();
    expect(vi.mocked(sendPushNotification)).toHaveBeenCalledTimes(1);
  });
});
