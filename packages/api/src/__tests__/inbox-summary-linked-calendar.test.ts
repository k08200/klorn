/**
 * C2: an invite present in the primary and a linked calendar is two
 * CalendarEvent rows. The inbox summary lists today's events, mirrors each into
 * the attention queue and fills the top 3 from that queue, so it must see the
 * invite once in all three places, and must not see linked rows at all while
 * LINKED_CALENDAR_SYNC_ENABLED is off (the kill switch).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Where = { id?: { in: string[] }; sourceAccountId?: null };

const m = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
  queue: [] as Array<Record<string, unknown>>,
  eventWheres: [] as unknown[],
  upsertForEvent: vi.fn(async () => {}),
}));

vi.mock("../db.js", () => {
  const table = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) =>
          vi.fn(async (args?: { where?: Where }) => {
            if (name === "calendarEvent" && method === "findMany") {
              m.eventWheres.push(args?.where);
              // Behave like the database: honour the id list and the kill-switch scope.
              return m.events.filter(
                (e) =>
                  (!args?.where?.id || args.where.id.in.includes(e.id as string)) &&
                  (args?.where?.sourceAccountId !== null || e.sourceAccountId === null),
              );
            }
            if (name === "attentionItem" && method === "findMany") return m.queue;
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

function row(id: string, sourceAccountId: string | null, externalId = "g-invite") {
  return {
    id,
    userId: "u1",
    title: "Design review",
    location: null,
    startTime: new Date(NOW + 60 * 60_000),
    endTime: new Date(NOW + 2 * 60 * 60_000),
    allDay: false,
    provider: "GOOGLE",
    externalId,
    sourceAccountId,
    sourceKey: sourceAccountId ?? "primary",
  };
}

function queued(id: string, sourceId: string, priority: number) {
  return {
    id,
    source: "CALENDAR_EVENT",
    sourceId,
    type: "MEETING_PREP",
    priority,
    confidence: null,
    suggestedAction: "prepare meeting",
    costOfIgnoring: "x",
    evidence: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.events = [];
  m.queue = [];
  m.eventWheres = [];
  process.env.LINKED_CALENDAR_SYNC_ENABLED = "true";
});
afterEach(() => {
  delete process.env.LINKED_CALENDAR_SYNC_ENABLED;
});

describe("buildInboxSummary — linked calendar copies (flag on)", () => {
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

  it("one meeting cannot take two top-3 slots when both copies have an attention item", async () => {
    m.events = [
      row("linked-copy", "acct-1"),
      row("primary-copy", null),
      row("other", null, "g-other"),
    ];
    // The losing copy's item even outranks the primary copy's.
    m.queue = [
      queued("att-linked", "linked-copy", 70),
      queued("att-primary", "primary-copy", 50),
      queued("att-other", "other", 40),
    ];

    const { top3 } = await buildInboxSummary("u1", NOW);

    expect(top3.map((item) => item.id)).toEqual(["primary-copy", "other"]);
  });
});

describe("buildInboxSummary — kill switch (flag off)", () => {
  beforeEach(() => {
    delete process.env.LINKED_CALENDAR_SYNC_ENABLED;
  });

  it("reads primary and LOCAL rows only, for today's list and for the queue's event join", async () => {
    m.events = [row("primary-copy", null)];
    m.queue = [queued("att-primary", "primary-copy", 50)];

    await buildInboxSummary("u1", NOW);

    expect(m.eventWheres).toHaveLength(2);
    for (const where of m.eventWheres as Array<Record<string, unknown>>) {
      expect(where.sourceAccountId).toBeNull();
    }
  });

  it("drops a lingering linked row from today's list, the mirror and the top 3", async () => {
    m.events = [row("linked-only", "acct-1"), row("primary-only", null, "g-primary")];
    m.queue = [queued("att-linked", "linked-only", 90), queued("att-primary", "primary-only", 50)];

    const { today, top3 } = await buildInboxSummary("u1", NOW);

    expect(today.events.map((e) => e.id)).toEqual(["primary-only"]);
    expect(top3.map((item) => item.id)).toEqual(["primary-only"]);
    expect(m.upsertForEvent).toHaveBeenCalledTimes(1);
  });
});
