/**
 * C2: an invite present in the primary and a linked calendar is two
 * CalendarEvent rows. The inbox summary lists today's events and mirrors each
 * into the attention queue, so it must see that invite once.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
  upsertForEvent: vi.fn(async () => {}),
}));

vi.mock("../db.js", () => {
  const table = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) =>
          vi.fn(async () => {
            if (name === "calendarEvent" && method === "findMany") return m.events;
            return method === "findMany" ? [] : null;
          }),
      },
    );
  const prisma = new Proxy({}, { get: (_t, name: string) => table(name) });
  return { prisma, db: prisma };
});
vi.mock("../judge/attention-mirror.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../judge/attention-mirror.js")>()),
  upsertAttentionForCalendarEvent: m.upsertForEvent,
  upsertAttentionForPendingAction: vi.fn(async () => {}),
  upsertAttentionForTask: vi.fn(async () => {}),
  upsertAttentionForNotification: vi.fn(async () => {}),
  upsertAttentionForCommitment: vi.fn(async () => {}),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { buildInboxSummary } from "../pim/inbox-summary.js";

const NOW = new Date("2026-10-01T03:00:00.000Z").getTime();

function row(id: string, sourceAccountId: string | null) {
  return {
    id,
    userId: "u1",
    title: "Design review",
    location: null,
    startTime: new Date(NOW + 60 * 60_000),
    endTime: new Date(NOW + 2 * 60 * 60_000),
    allDay: false,
    provider: "GOOGLE",
    externalId: "g-invite",
    sourceAccountId,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.events = [];
});

describe("buildInboxSummary — linked calendar copies", () => {
  it("lists the invite once in today's events and mirrors it into the queue once", async () => {
    m.events = [row("linked-copy", "acct-1"), row("primary-copy", null)];

    const { today } = await buildInboxSummary("u1", NOW);

    expect(today.events.map((e) => e.id)).toEqual(["primary-copy"]);
    expect(m.upsertForEvent).toHaveBeenCalledTimes(1);
    expect(m.upsertForEvent.mock.calls[0]?.[0]).toMatchObject({ id: "primary-copy" });
  });

  it("keeps an event that exists only in a linked calendar", async () => {
    m.events = [row("linked-only", "acct-1")];

    const { today } = await buildInboxSummary("u1", NOW);

    expect(today.events.map((e) => e.id)).toEqual(["linked-only"]);
    expect(m.upsertForEvent).toHaveBeenCalledTimes(1);
  });
});
