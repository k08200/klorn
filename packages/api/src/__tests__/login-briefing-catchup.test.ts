import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// D0 briefing: a brand-new user whose login lands BEFORE their configured
// briefing time used to get their first briefing only the next day
// (triggerDueLoginBriefing gated everything on isLoginBriefingDue). The fix:
// a user with ZERO briefings ever gets one immediately on login/init-sync;
// everyone else keeps the schedule. The (userId, dayKey) unique inside
// createDailyBriefingDelivery still caps delivery at once per day.
const state = vi.hoisted(() => ({
  config: {
    dailyBriefing: true,
    briefingTime: "23:59", // far in the future today → NOT due at test time
    timezone: "UTC",
  } as Record<string, unknown>,
  briefingNote: null as { id: string } | null,
  deliveryCalls: 0,
}));

vi.mock("../db.js", () => ({
  prisma: {
    automationConfig: {
      upsert: vi.fn(async () => state.config),
    },
    note: {
      findFirst: vi.fn(async () => state.briefingNote),
    },
  },
}));

vi.mock("../pim/briefing.js", () => ({
  createDailyBriefingDelivery: vi.fn(async () => {
    state.deliveryCalls++;
    return {
      briefing: "b",
      note: { id: "note-1", createdAt: new Date() },
      notification: null,
      reused: false,
      llm: { source: "live", reason: "", model: "m" },
    };
  }),
}));

// Keep routes/auth.js importable without hitting googleapis / mail infra.
vi.mock("../mail/gmail.js", () => ({
  getAuthUrl: vi.fn(),
  getLoginAuthUrl: vi.fn(),
  getLinkCalendarAuthUrl: vi.fn(),
  getLinkInboxAuthUrl: vi.fn(),
  getAuthedClient: vi.fn(),
  getOAuth2Client: vi.fn(),
  getGoogleUserInfo: vi.fn(),
  getGoogleConnectionStatus: vi.fn(),
  isGoogleAuthError: vi.fn(() => false),
  markGoogleTokenForReconnect: vi.fn(async () => {}),
  registerGmailWatch: vi.fn(async () => {}),
}));
vi.mock("../mail/email.js", () => ({
  sendVerificationEmail: vi.fn(async () => true),
  sendPasswordResetEmail: vi.fn(async () => true),
}));
vi.mock("../mail/email-sync.js", () => ({
  syncLinkedInboxesForUser: vi.fn(async () => ({ newCount: 0 })),
}));

import { prisma } from "../db.js";
import { runLoginBriefingCatchUp } from "../routes/auth.js";

const USER = "user-1";

beforeEach(() => {
  state.config = { dailyBriefing: true, briefingTime: "23:59", timezone: "UTC" };
  state.briefingNote = null;
  state.deliveryCalls = 0;
  vi.clearAllMocks();
  // Pin "now" to midday UTC so "23:59" is deterministically NOT due and
  // "00:00" deterministically IS due, regardless of when the suite runs.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-23T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runLoginBriefingCatchUp — D0 first-briefing exception", () => {
  it("not due yet + user has NO briefing ever → delivers the first briefing immediately", async () => {
    state.briefingNote = null; // zero briefing notes ever
    await runLoginBriefingCatchUp(USER);
    expect(state.deliveryCalls).toBe(1);
    // The "ever briefed?" probe looks at briefing notes only (dayKey non-null).
    expect(vi.mocked(prisma.note.findFirst)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: USER, dayKey: { not: null } }),
      }),
    );
  });

  it("not due yet + user already had a briefing before → waits for the schedule (no delivery)", async () => {
    state.briefingNote = { id: "note-old" };
    await runLoginBriefingCatchUp(USER);
    expect(state.deliveryCalls).toBe(0);
  });

  it("due → delivers regardless of briefing history (existing catch-up behavior)", async () => {
    state.config = { dailyBriefing: true, briefingTime: "00:00", timezone: "UTC" };
    state.briefingNote = { id: "note-old" };
    await runLoginBriefingCatchUp(USER);
    expect(state.deliveryCalls).toBe(1);
  });

  it("dailyBriefing disabled → never delivers, even for a zero-briefing user", async () => {
    state.config = { dailyBriefing: false, briefingTime: "23:59", timezone: "UTC" };
    state.briefingNote = null;
    await runLoginBriefingCatchUp(USER);
    expect(state.deliveryCalls).toBe(0);
  });
});
