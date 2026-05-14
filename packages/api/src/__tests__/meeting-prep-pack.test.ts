import { beforeEach, describe, expect, it, vi } from "vitest";

type EventRow = {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  startTime: Date;
  endTime: Date;
  location: string | null;
  meetingLink: string | null;
};

const stores = vi.hoisted(() => ({
  event: null as EventRow | null,
  emails: [] as Array<Record<string, unknown>>,
  tasks: [] as Array<Record<string, unknown>>,
  commitments: [] as Array<Record<string, unknown>>,
}));

vi.mock("../db.js", () => ({
  prisma: {
    calendarEvent: {
      findUnique: vi.fn(async () => stores.event),
    },
    emailMessage: {
      findMany: vi.fn(async () => stores.emails),
    },
    task: {
      findMany: vi.fn(async () => stores.tasks),
    },
    commitment: {
      findMany: vi.fn(async () => stores.commitments),
    },
  },
}));

import { buildMeetingPrepPack } from "../meeting-prep-pack.js";

const NOW = new Date("2026-04-28T10:00:00.000Z").getTime();

beforeEach(() => {
  stores.event = {
    id: "event-1",
    userId: "user-1",
    title: "PartnerCo kickoff",
    description: null,
    startTime: new Date("2026-04-28T13:00:00.000Z"),
    endTime: new Date("2026-04-28T14:00:00.000Z"),
    location: null,
    meetingLink: null,
  };
  stores.emails = [];
  stores.tasks = [];
  stores.commitments = [];
});

describe("buildMeetingPrepPack", () => {
  it("returns null when the event is missing or owned by another user", async () => {
    stores.event = null;
    await expect(buildMeetingPrepPack("user-1", "missing", { now: NOW })).resolves.toBeNull();

    stores.event = {
      id: "event-2",
      userId: "other-user",
      title: "Other",
      description: null,
      startTime: new Date("2026-04-28T13:00:00.000Z"),
      endTime: new Date("2026-04-28T14:00:00.000Z"),
      location: null,
      meetingLink: null,
    };
    await expect(buildMeetingPrepPack("user-1", "event-2", { now: NOW })).resolves.toBeNull();
  });

  it("builds related context and readiness checklist", async () => {
    stores.emails.push({
      id: "email-1",
      from: "minsu@partnerco.com",
      subject: "PartnerCo kickoff agenda",
      snippet: "Let's cover metrics",
      body: null,
      summary: null,
      receivedAt: new Date("2026-04-28T09:00:00.000Z"),
      isRead: false,
    });
    stores.tasks.push({
      id: "task-1",
      title: "PartnerCo deck update",
      description: null,
      status: "TODO",
      priority: "HIGH",
      dueDate: new Date("2026-04-28T12:00:00.000Z"),
    });
    stores.commitments.push({
      id: "commitment-1",
      title: "Send PartnerCo pricing",
      description: null,
      status: "OPEN",
      owner: "USER",
      counterpartyName: "PartnerCo",
      dueAt: new Date("2026-04-27T12:00:00.000Z"),
      dueText: "yesterday",
      confidence: 0.9,
    });

    const pack = await buildMeetingPrepPack("user-1", "event-1", { now: NOW });

    expect(pack).toMatchObject({
      readiness: "needs_review",
      event: { id: "event-1", title: "PartnerCo kickoff" },
    });
    expect(pack?.relatedEmails).toHaveLength(1);
    expect(pack?.openTasks).toHaveLength(1);
    expect(pack?.openCommitments).toHaveLength(1);
    expect(pack?.checklist).toEqual(
      expect.arrayContaining([
        "Confirm the agenda or meeting purpose.",
        "Add a meeting link or location.",
        "Review 1 task due before this meeting.",
        "Resolve 1 overdue commitment.",
      ]),
    );
  });
});
