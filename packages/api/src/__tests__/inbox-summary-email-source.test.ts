/**
 * Regression: the top-3 queue read bucketed source ids into a fixed object
 * with no EMAIL (or GITHUB) key, so one OPEN, non-SILENT email AttentionItem
 * — which every judged email produces — threw a TypeError and turned
 * GET /api/inbox/summary (and /operating-plan, which builds on it) into a 500.
 *
 * The top 3 renders only the five source kinds the contract knows. Email and
 * GitHub items have their own surfaces, so the queue read must leave them out
 * at the query (or they would also crowd the overfetch) and must never crash on
 * a source it does not render.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type QueueWhere = { source?: { in?: string[] } };
type QueueArgs = { where?: QueueWhere; take?: number };

const m = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
  queue: [] as Array<Record<string, unknown>>,
  queueWheres: [] as Array<QueueWhere | undefined>,
}));

vi.mock("../db.js", () => {
  const table = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) =>
          vi.fn(async (args?: QueueArgs & { where?: { id?: { in: string[] } } }) => {
            if (name === "calendarEvent" && method === "findMany") {
              const ids = args?.where?.id?.in;
              return m.events.filter((e) => !ids || ids.includes(e.id as string));
            }
            if (name === "attentionItem" && method === "findMany") {
              // Behave like the database: honour a source filter and the take cap.
              m.queueWheres.push(args?.where);
              const allowed = args?.where?.source?.in;
              const rows = m.queue.filter((r) => !allowed || allowed.includes(r.source as string));
              return rows.slice(0, args?.take ?? rows.length);
            }
            return method === "findMany" ? [] : null;
          }),
      },
    );
  const prisma = new Proxy({}, { get: (_t, name: string) => table(name) });
  return { prisma, db: prisma };
});
vi.mock("../judge/attention-mirror.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../judge/attention-mirror.js")>()),
  upsertAttentionForCalendarEvent: vi.fn(async () => {}),
  upsertAttentionForPendingAction: vi.fn(async () => {}),
  upsertAttentionForTask: vi.fn(async () => {}),
  upsertAttentionForNotification: vi.fn(async () => {}),
  upsertAttentionForCommitment: vi.fn(async () => {}),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { buildInboxSummary } from "../pim/inbox-summary.js";

const NOW = new Date("2026-10-01T03:00:00.000Z").getTime();

function event(id: string) {
  return {
    id,
    userId: "u1",
    title: "Design review",
    location: null,
    startTime: new Date(NOW + 60 * 60_000),
    endTime: new Date(NOW + 2 * 60 * 60_000),
    allDay: false,
    provider: "GOOGLE",
    externalId: `g-${id}`,
    sourceAccountId: null,
    sourceKey: "primary",
  };
}

function queued(id: string, source: string, sourceId: string, priority: number) {
  return {
    id,
    source,
    sourceId,
    type: source === "CALENDAR_EVENT" ? "MEETING_PREP" : "REPLY_NEEDED",
    priority,
    confidence: 0.8,
    suggestedAction: null,
    costOfIgnoring: null,
    evidence: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.events = [];
  m.queue = [];
  m.queueWheres = [];
});

describe("buildInboxSummary — sources the top 3 does not render", () => {
  it("does not throw when the queue holds an OPEN email item", async () => {
    m.events = [event("ev-1")];
    m.queue = [
      queued("att-email", "EMAIL", "email-1", 90),
      queued("att-event", "CALENDAR_EVENT", "ev-1", 50),
    ];

    const { top3 } = await buildInboxSummary("u1", NOW);

    expect(top3.map((item) => item.id)).toEqual(["ev-1"]);
  });

  it("does not throw on GitHub items or a source value it has never seen", async () => {
    m.events = [event("ev-1")];
    m.queue = [
      queued("att-gh", "GITHUB", "thread-1", 95),
      queued("att-future", "SOME_FUTURE_SOURCE", "x-1", 92),
      queued("att-event", "CALENDAR_EVENT", "ev-1", 50),
    ];

    const { top3 } = await buildInboxSummary("u1", NOW);

    expect(top3.map((item) => item.id)).toEqual(["ev-1"]);
  });

  it("filters to renderable sources in the query so emails cannot crowd out the overfetch", async () => {
    m.events = [event("ev-1")];
    m.queue = [
      ...Array.from({ length: 30 }, (_, i) => queued(`att-email-${i}`, "EMAIL", `email-${i}`, 99)),
      queued("att-event", "CALENDAR_EVENT", "ev-1", 10),
    ];

    const { top3 } = await buildInboxSummary("u1", NOW);

    expect(top3.map((item) => item.id)).toEqual(["ev-1"]);
    const sources = m.queueWheres[0]?.source?.in ?? [];
    expect(sources).not.toContain("EMAIL");
    expect(sources).not.toContain("GITHUB");
    expect([...sources].sort()).toEqual(
      ["CALENDAR_EVENT", "COMMITMENT", "NOTIFICATION", "PENDING_ACTION", "TASK"].sort(),
    );
  });
});
