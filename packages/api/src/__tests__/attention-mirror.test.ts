import { beforeEach, describe, expect, it, vi } from "vitest";

const upsertSpy = vi.fn(async () => ({}));
const updateManySpy = vi.fn(async () => ({ count: 0 }));
const deleteManySpy = vi.fn(async () => ({ count: 0 }));

vi.mock("../db.js", () => {
  const prisma = {
    attentionItem: {
      upsert: upsertSpy,
      updateMany: updateManySpy,
      deleteMany: deleteManySpy,
    },
  };
  return { prisma, db: prisma };
});

const {
  upsertAttentionForPendingAction,
  upsertAttentionForTask,
  upsertAttentionForCalendarEvent,
  upsertAttentionForNotification,
  upsertAttentionForCommitment,
  upsertAttentionForEmailJudgement,
  bulkResolveAttentionForPendingActions,
  deleteAttentionForPendingActions,
  deleteAttentionForCalendarEvents,
  deleteAttentionForCommitments,
} = await import("../attention-mirror.js");

beforeEach(() => {
  upsertSpy.mockClear();
  updateManySpy.mockClear();
  deleteManySpy.mockClear();
});

describe("upsertAttentionForPendingAction", () => {
  it("creates an OPEN AttentionItem for a freshly PENDING action", async () => {
    await upsertAttentionForPendingAction({
      id: "pa-1",
      userId: "user-1",
      toolName: "send_email",
      status: "PENDING",
      reasoning: "Reply needed for Sarah",
    });

    expect(upsertSpy).toHaveBeenCalledOnce();
    const call = upsertSpy.mock.calls[0]?.[0] as {
      where: { source_sourceId: { source: string; sourceId: string } };
      create: { status: string; resolvedAt: Date | null; title: string; autonomyLevel: number };
      update: { status: string; resolvedAt: Date | null; autonomyLevel: number };
    };
    expect(call.where.source_sourceId).toEqual({ source: "PENDING_ACTION", sourceId: "pa-1" });
    expect(call.create.status).toBe("OPEN");
    expect(call.create.resolvedAt).toBeNull();
    expect(call.create.title).toBe("Reply needed for Sarah");
    expect(call.create.autonomyLevel).toBe(2);
    expect(call.update.autonomyLevel).toBe(2);
  });

  it("maps tool risk onto autonomy levels", async () => {
    await upsertAttentionForPendingAction({
      id: "pa-low",
      userId: "user-1",
      toolName: "classify_emails",
      status: "PENDING",
      reasoning: null,
    });
    await upsertAttentionForPendingAction({
      id: "pa-high",
      userId: "user-1",
      toolName: "delete_email",
      status: "PENDING",
      reasoning: null,
    });

    const low = upsertSpy.mock.calls[0]?.[0] as { create: { autonomyLevel: number } };
    const high = upsertSpy.mock.calls[1]?.[0] as { create: { autonomyLevel: number } };
    expect(low.create.autonomyLevel).toBe(3);
    expect(high.create.autonomyLevel).toBe(1);
  });

  it("marks the AttentionItem RESOLVED when the PA reaches EXECUTED", async () => {
    await upsertAttentionForPendingAction({
      id: "pa-2",
      userId: "user-1",
      toolName: "send_email",
      status: "EXECUTED",
      reasoning: null,
    });

    const call = upsertSpy.mock.calls[0]?.[0] as {
      update: { status: string; resolvedAt: Date | null };
    };
    expect(call.update.status).toBe("RESOLVED");
    expect(call.update.resolvedAt).toBeInstanceOf(Date);
  });

  it("marks the AttentionItem DISMISSED when the PA is REJECTED", async () => {
    await upsertAttentionForPendingAction({
      id: "pa-3",
      userId: "user-1",
      toolName: "send_email",
      status: "REJECTED",
      reasoning: "User declined",
    });

    const call = upsertSpy.mock.calls[0]?.[0] as { update: { status: string } };
    expect(call.update.status).toBe("DISMISSED");
  });

  it("falls back to a humanised tool name when reasoning is missing", async () => {
    await upsertAttentionForPendingAction({
      id: "pa-4",
      userId: "user-1",
      toolName: "send_email",
      status: "PENDING",
      reasoning: null,
    });

    const call = upsertSpy.mock.calls[0]?.[0] as { create: { title: string } };
    expect(call.create.title).toBe("send email");
  });

  it("truncates very long reasoning into a usable title", async () => {
    const longReason = "x".repeat(500);
    await upsertAttentionForPendingAction({
      id: "pa-5",
      userId: "user-1",
      toolName: "send_email",
      status: "PENDING",
      reasoning: longReason,
    });

    const call = upsertSpy.mock.calls[0]?.[0] as { create: { title: string } };
    expect(call.create.title.length).toBeLessThanOrEqual(120);
    expect(call.create.title.endsWith("…")).toBe(true);
  });

  it("never throws even when prisma rejects", async () => {
    upsertSpy.mockRejectedValueOnce(new Error("db down"));
    await expect(
      upsertAttentionForPendingAction({
        id: "pa-6",
        userId: "user-1",
        toolName: "send_email",
        status: "PENDING",
        reasoning: null,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("bulkResolveAttentionForPendingActions", () => {
  it("noops on an empty id list", async () => {
    await bulkResolveAttentionForPendingActions([], "REJECTED");
    expect(updateManySpy).not.toHaveBeenCalled();
  });

  it("maps the final PA status onto the AttentionItem status enum", async () => {
    await bulkResolveAttentionForPendingActions(["a", "b"], "EXECUTED");
    const call = updateManySpy.mock.calls[0]?.[0] as {
      where: { sourceId: { in: string[] } };
      data: { status: string };
    };
    expect(call.where.sourceId.in).toEqual(["a", "b"]);
    expect(call.data.status).toBe("RESOLVED");
  });
});

describe("upsertAttentionForTask", () => {
  const NOW = new Date("2026-04-28T10:00:00Z").getTime();
  const TODAY_START = (() => {
    const d = new Date(NOW);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  })();

  it("skips tasks without a dueDate", async () => {
    await upsertAttentionForTask(
      {
        id: "t-1",
        userId: "u",
        title: "no due",
        status: "TODO",
        priority: "MEDIUM",
        dueDate: null,
      },
      NOW,
    );
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("skips tasks dueDate in the future (tomorrow or later)", async () => {
    await upsertAttentionForTask(
      {
        id: "t-2",
        userId: "u",
        title: "future",
        status: "TODO",
        priority: "MEDIUM",
        dueDate: new Date(TODAY_START + 2 * 24 * 60 * 60 * 1000),
      },
      NOW,
    );
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("surfaces today-due tasks at base priority", async () => {
    await upsertAttentionForTask(
      {
        id: "t-3",
        userId: "u",
        title: "today",
        status: "TODO",
        priority: "MEDIUM",
        dueDate: new Date(NOW + 60 * 60 * 1000),
      },
      NOW,
    );
    const call = upsertSpy.mock.calls[0]?.[0] as {
      create: { priority: number; status: string; autonomyLevel: number };
    };
    expect(call.create.status).toBe("OPEN");
    expect(call.create.priority).toBe(50);
    expect(call.create.autonomyLevel).toBe(0);
  });

  it("bumps priority for overdue tasks", async () => {
    await upsertAttentionForTask(
      {
        id: "t-4",
        userId: "u",
        title: "old",
        status: "TODO",
        priority: "MEDIUM",
        dueDate: new Date(TODAY_START - 24 * 60 * 60 * 1000),
      },
      NOW,
    );
    const call = upsertSpy.mock.calls[0]?.[0] as { create: { priority: number } };
    // base 50 + overdue 20 = 70
    expect(call.create.priority).toBe(70);
  });

  it("further bumps priority for HIGH/URGENT tasks", async () => {
    await upsertAttentionForTask(
      {
        id: "t-5",
        userId: "u",
        title: "urgent overdue",
        status: "TODO",
        priority: "URGENT",
        dueDate: new Date(TODAY_START - 24 * 60 * 60 * 1000),
      },
      NOW,
    );
    const call = upsertSpy.mock.calls[0]?.[0] as { create: { priority: number } };
    // base 50 + overdue 20 + URGENT 20 = 90
    expect(call.create.priority).toBe(90);
  });

  it("marks the AttentionItem RESOLVED when the task is DONE", async () => {
    await upsertAttentionForTask(
      {
        id: "t-6",
        userId: "u",
        title: "done",
        status: "DONE",
        priority: "MEDIUM",
        dueDate: new Date(TODAY_START - 24 * 60 * 60 * 1000),
      },
      NOW,
    );
    const call = upsertSpy.mock.calls[0]?.[0] as { create: { status: string } };
    expect(call.create.status).toBe("RESOLVED");
  });
});

describe("upsertAttentionForCalendarEvent", () => {
  const NOW = new Date("2026-04-28T10:00:00Z").getTime();
  const TODAY_START = (() => {
    const d = new Date(NOW);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  })();

  it("skips events scheduled before today", async () => {
    await upsertAttentionForCalendarEvent(
      {
        id: "e-past-day",
        userId: "u",
        title: "yesterday",
        startTime: new Date(TODAY_START - 24 * 60 * 60 * 1000),
      },
      NOW,
    );
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("skips events scheduled after today", async () => {
    await upsertAttentionForCalendarEvent(
      {
        id: "e-tomorrow",
        userId: "u",
        title: "tomorrow",
        startTime: new Date(TODAY_START + 25 * 60 * 60 * 1000),
      },
      NOW,
    );
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("surfaces today events in the future as OPEN", async () => {
    await upsertAttentionForCalendarEvent(
      {
        id: "e-soon",
        userId: "u",
        title: "afternoon",
        startTime: new Date(NOW + 90 * 60 * 1000),
      },
      NOW,
    );
    const call = upsertSpy.mock.calls[0]?.[0] as {
      create: { status: string; priority: number; autonomyLevel: number };
    };
    expect(call.create.status).toBe("OPEN");
    expect(call.create.priority).toBe(50);
    expect(call.create.autonomyLevel).toBe(0);
  });

  it("bumps priority for events starting within an hour", async () => {
    await upsertAttentionForCalendarEvent(
      {
        id: "e-imminent",
        userId: "u",
        title: "starting soon",
        startTime: new Date(NOW + 30 * 60 * 1000),
      },
      NOW,
    );
    const call = upsertSpy.mock.calls[0]?.[0] as { create: { priority: number } };
    expect(call.create.priority).toBe(70);
  });

  it("marks today events that have already started as RESOLVED", async () => {
    await upsertAttentionForCalendarEvent(
      {
        id: "e-already-running",
        userId: "u",
        title: "earlier today",
        startTime: new Date(NOW - 2 * 60 * 60 * 1000),
      },
      NOW,
    );
    const call = upsertSpy.mock.calls[0]?.[0] as { create: { status: string } };
    expect(call.create.status).toBe("RESOLVED");
  });
});

describe("upsertAttentionForNotification", () => {
  it("skips non agent_proposal types", async () => {
    await upsertAttentionForNotification({
      id: "n-1",
      userId: "u",
      type: "reminder",
      title: "title",
      message: "msg",
      isRead: false,
      pendingActionId: null,
    });
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("skips agent_proposal notifications already linked to a PendingAction", async () => {
    await upsertAttentionForNotification({
      id: "n-2",
      userId: "u",
      type: "agent_proposal",
      title: "title",
      message: "msg",
      isRead: false,
      pendingActionId: "pa-99",
    });
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("surfaces naked unread agent_proposal as OPEN", async () => {
    await upsertAttentionForNotification({
      id: "n-3",
      userId: "u",
      type: "agent_proposal",
      title: "[Eve] heads-up",
      message: "something to look at",
      isRead: false,
      pendingActionId: null,
    });
    const call = upsertSpy.mock.calls[0]?.[0] as {
      create: { status: string; type: string; title: string; autonomyLevel: number };
    };
    expect(call.create.status).toBe("OPEN");
    expect(call.create.type).toBe("FOLLOWUP");
    expect(call.create.title).toBe("[Eve] heads-up");
    expect(call.create.autonomyLevel).toBe(1);
  });

  it("flips a read agent_proposal to DISMISSED", async () => {
    await upsertAttentionForNotification({
      id: "n-4",
      userId: "u",
      type: "agent_proposal",
      title: "[Eve] heads-up",
      message: "msg",
      isRead: true,
      pendingActionId: null,
    });
    const call = upsertSpy.mock.calls[0]?.[0] as { create: { status: string } };
    expect(call.create.status).toBe("DISMISSED");
  });
});

describe("upsertAttentionForCommitment", () => {
  const NOW = new Date("2026-04-28T10:00:00Z").getTime();

  it("classifies a future-due commitment as COMMITMENT_DUE", async () => {
    await upsertAttentionForCommitment(
      {
        id: "c-1",
        userId: "u",
        title: "send the deck",
        description: null,
        status: "OPEN",
        dueAt: new Date(NOW + 4 * 60 * 60 * 1000),
        confidence: 0.9,
      },
      NOW,
    );
    const call = upsertSpy.mock.calls[0]?.[0] as {
      create: { type: string; status: string; priority: number; autonomyLevel: number };
    };
    expect(call.create.type).toBe("COMMITMENT_DUE");
    expect(call.create.status).toBe("OPEN");
    // Within 24h → priority bump
    expect(call.create.priority).toBe(70);
    expect(call.create.autonomyLevel).toBe(0);
  });

  it("classifies an already-past commitment as COMMITMENT_OVERDUE", async () => {
    await upsertAttentionForCommitment(
      {
        id: "c-2",
        userId: "u",
        title: "late deck",
        description: null,
        status: "OPEN",
        dueAt: new Date(NOW - 24 * 60 * 60 * 1000),
        confidence: 0.9,
      },
      NOW,
    );
    const call = upsertSpy.mock.calls[0]?.[0] as {
      create: { type: string; priority: number };
    };
    expect(call.create.type).toBe("COMMITMENT_OVERDUE");
    expect(call.create.priority).toBe(80);
  });

  it("classifies a commitment without dueAt as COMMITMENT_UNCONFIRMED", async () => {
    await upsertAttentionForCommitment(
      {
        id: "c-3",
        userId: "u",
        title: "follow up",
        description: null,
        status: "OPEN",
        dueAt: null,
        confidence: 0.5,
      },
      NOW,
    );
    const call = upsertSpy.mock.calls[0]?.[0] as {
      create: { type: string; priority: number; confidence: number };
    };
    expect(call.create.type).toBe("COMMITMENT_UNCONFIRMED");
    expect(call.create.priority).toBe(40);
    expect(call.create.confidence).toBe(0.5);
  });

  it("marks a DONE commitment as RESOLVED", async () => {
    await upsertAttentionForCommitment(
      {
        id: "c-4",
        userId: "u",
        title: "shipped",
        description: null,
        status: "DONE",
        dueAt: new Date(NOW + 60 * 60 * 1000),
        confidence: 0.9,
      },
      NOW,
    );
    const call = upsertSpy.mock.calls[0]?.[0] as { create: { status: string } };
    expect(call.create.status).toBe("RESOLVED");
  });
});

describe("deleteAttentionForCommitments", () => {
  it("deletes by source=COMMITMENT", async () => {
    await deleteAttentionForCommitments(["c-1", "c-2"]);
    const call = deleteManySpy.mock.calls[0]?.[0] as {
      where: { source: string; sourceId: { in: string[] } };
    };
    expect(call.where.source).toBe("COMMITMENT");
    expect(call.where.sourceId.in).toEqual(["c-1", "c-2"]);
  });
});

describe("deleteAttentionForCalendarEvents", () => {
  it("noops on empty list", async () => {
    await deleteAttentionForCalendarEvents([]);
    expect(deleteManySpy).not.toHaveBeenCalled();
  });

  it("deletes by source=CALENDAR_EVENT", async () => {
    await deleteAttentionForCalendarEvents(["e1", "e2"]);
    const call = deleteManySpy.mock.calls[0]?.[0] as {
      where: { source: string; sourceId: { in: string[] } };
    };
    expect(call.where.source).toBe("CALENDAR_EVENT");
    expect(call.where.sourceId.in).toEqual(["e1", "e2"]);
  });
});

describe("deleteAttentionForPendingActions", () => {
  it("noops on an empty id list", async () => {
    await deleteAttentionForPendingActions([]);
    expect(deleteManySpy).not.toHaveBeenCalled();
  });

  it("deletes by (source, sourceId) for the given pending action ids", async () => {
    await deleteAttentionForPendingActions(["a", "b", "c"]);
    const call = deleteManySpy.mock.calls[0]?.[0] as {
      where: { source: string; sourceId: { in: string[] } };
    };
    expect(call.where.source).toBe("PENDING_ACTION");
    expect(call.where.sourceId.in).toEqual(["a", "b", "c"]);
  });
});

describe("upsertAttentionForEmailJudgement — status preservation", () => {
  const email = {
    id: "email-1",
    userId: "user-1",
    from: "boss@acme.com",
    subject: "Re: the deal",
    snippet: "can you confirm",
    labels: ["INBOX"],
    receivedAt: new Date("2026-06-16T00:00:00Z"),
  };
  const judgement = {
    tier: "QUEUE" as const,
    reason: "reply needed",
    features: { confidence: 0.8, senderTrust: 0.6, reversibility: 0.9, urgency: 0.4 },
  };

  it("opens a brand-new email item (create branch)", async () => {
    await upsertAttentionForEmailJudgement(email, judgement);
    const call = upsertSpy.mock.calls[0]?.[0] as { create: { status: string } };
    expect(call.create.status).toBe("OPEN");
  });

  it("does NOT force status on re-judge, so a DISMISSED/RESOLVED item is not resurrected", async () => {
    // The Naver poll re-judges the same email every cycle; forcing status:OPEN
    // here resurrected items the user had already dismissed. The update branch
    // must refresh tier/priority but leave the user's terminal status alone.
    await upsertAttentionForEmailJudgement(email, judgement);
    const call = upsertSpy.mock.calls[0]?.[0] as {
      update: { status?: string; tier: string; priority: string };
    };
    expect(call.update.status).toBeUndefined();
    // still refreshes the classification fields
    expect(call.update.tier).toBe("QUEUE");
  });
});
