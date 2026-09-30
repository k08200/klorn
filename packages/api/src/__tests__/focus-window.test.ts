/**
 * Focus window — the gate holds non-urgent categories during a calendar
 * block, urgent/meeting/system always pass, and the block-end digest fires
 * once per event (P2002 dedupe) only when something actually arrived.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  config: { focusWindowEnabled: true } as Record<string, unknown> | null,
  ongoingBlock: null as { id: string } | null,
  endedEvents: [] as Array<{
    id: string;
    userId: string;
    startTime: Date;
    endTime: Date;
    provider?: string;
    externalId?: string | null;
    sourceAccountId?: string | null;
  }>,
  arrivedCount: 0,
  notifications: [] as unknown[],
  notifDupe: false,
  pushes: [] as unknown[],
}));

class P2002 extends Error {
  code = "P2002";
}

vi.mock("../db.js", () => {
  const prisma = {
    automationConfig: { findUnique: vi.fn(async () => state.config) },
    calendarEvent: {
      findFirst: vi.fn(async () => state.ongoingBlock),
      findMany: vi.fn(async () => state.endedEvents),
    },
    attentionItem: { count: vi.fn(async () => state.arrivedCount) },
    notification: {
      create: vi.fn(async (args: unknown) => {
        if (state.notifDupe) throw new P2002("dup");
        state.notifications.push(args);
        return { id: "n1" };
      }),
    },
  };
  return { prisma, db: prisma };
});
vi.mock("../notify/push.js", () => ({
  sendPushNotification: vi.fn(async (...args: unknown[]) => {
    state.pushes.push(args);
    return {};
  }),
}));

import { evaluateNotificationGate } from "../notify/notification-prefs.js";
import { sendFocusWindowDigests } from "../pim/focus-digest.js";

beforeEach(() => {
  state.config = { focusWindowEnabled: true };
  state.ongoingBlock = null;
  state.endedEvents = [];
  state.arrivedCount = 0;
  state.notifications = [];
  state.notifDupe = false;
  state.pushes = [];
});

describe("focus-window notification gate", () => {
  it("holds non-urgent categories while a block is running", async () => {
    state.ongoingBlock = { id: "ev1" };
    const r = await evaluateNotificationGate("u1", "task_due");
    expect(r).toEqual({ allowed: false, reason: "focus_window" });
  });

  it("urgent mail and meetings always pass, focus or not", async () => {
    state.ongoingBlock = { id: "ev1" };
    expect(await evaluateNotificationGate("u1", "email_urgent")).toEqual({ allowed: true });
    expect(await evaluateNotificationGate("u1", "meeting")).toEqual({ allowed: true });
  });

  it("does nothing when the toggle is off or no block is running", async () => {
    state.config = { focusWindowEnabled: false };
    state.ongoingBlock = { id: "ev1" };
    expect(await evaluateNotificationGate("u1", "task_due")).toEqual({ allowed: true });

    state.config = { focusWindowEnabled: true };
    state.ongoingBlock = null;
    expect(await evaluateNotificationGate("u1", "task_due")).toEqual({ allowed: true });
  });
});

describe("sendFocusWindowDigests", () => {
  const EVENT = {
    id: "ev1",
    userId: "u1",
    startTime: new Date("2026-08-21T01:00:00Z"),
    endTime: new Date("2026-08-21T02:00:00Z"),
  };

  it("sends one digest when a block ended and items arrived", async () => {
    state.endedEvents = [EVENT];
    state.arrivedCount = 5;
    const sent = await sendFocusWindowDigests(new Date("2026-08-21T02:01:00Z"));
    expect(sent).toBe(1);
    expect(state.pushes).toHaveLength(1);
    const notif = state.notifications[0] as { data: { dedupeKey: string } };
    expect(notif.data.dedupeKey).toBe("focus:ev1");
  });

  it("stays silent for empty blocks, back-to-back blocks, and duplicates", async () => {
    state.endedEvents = [EVENT];
    state.arrivedCount = 0;
    expect(await sendFocusWindowDigests(new Date("2026-08-21T02:01:00Z"))).toBe(0);

    state.arrivedCount = 3;
    state.ongoingBlock = { id: "ev2" }; // next block already running
    expect(await sendFocusWindowDigests(new Date("2026-08-21T02:01:00Z"))).toBe(0);

    state.ongoingBlock = null;
    state.notifDupe = true; // dedupeKey already exists
    expect(await sendFocusWindowDigests(new Date("2026-08-21T02:01:00Z"))).toBe(0);
    expect(state.pushes).toHaveLength(0);
  });
});

describe("sendFocusWindowDigests — linked calendar copies (C2)", () => {
  const copy = (id: string, sourceAccountId: string | null) => ({
    id,
    userId: "u1",
    startTime: new Date("2026-08-21T01:00:00Z"),
    endTime: new Date("2026-08-21T02:00:00Z"),
    provider: "GOOGLE",
    externalId: "g-focus",
    sourceAccountId,
  });

  it("sends ONE digest for a focus block that sits in the primary and a linked calendar", async () => {
    state.endedEvents = [copy("linked-copy", "acct-1"), copy("primary-copy", null)];
    state.arrivedCount = 4;

    const sent = await sendFocusWindowDigests(new Date("2026-08-21T02:01:00Z"));

    expect(sent).toBe(1);
    expect(state.pushes).toHaveLength(1);
    const keys = state.notifications.map(
      (n) => (n as { data: { dedupeKey: string } }).data.dedupeKey,
    );
    expect(keys).toEqual(["focus:primary-copy"]);
  });
});
