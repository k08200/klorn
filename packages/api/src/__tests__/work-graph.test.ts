import { beforeEach, describe, expect, it, vi } from "vitest";

type EmailRow = {
  id: string;
  userId: string;
  threadId: string | null;
  from: string;
  to: string;
  subject: string;
  isRead: boolean;
  priority: string;
  receivedAt: Date;
};

type ConversationRow = {
  id: string;
  userId: string;
  title: string | null;
  updatedAt: Date;
  createdAt: Date;
};

type PendingActionRow = {
  id: string;
  userId: string;
  conversationId: string;
  status: string;
  toolName: string;
  createdAt: Date;
};

type CommitmentRow = {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  status: string;
  owner: string;
  counterpartyName: string | null;
  dueAt: Date | null;
  dueText: string | null;
  sourceType: string;
  sourceId: string | null;
  threadId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const stores = vi.hoisted(() => ({
  emails: [] as EmailRow[],
  conversations: [] as ConversationRow[],
  pendingActions: [] as PendingActionRow[],
  commitments: [] as CommitmentRow[],
}));

function byUser<T extends { userId: string }>(rows: T[], userId?: string): T[] {
  return userId ? rows.filter((r) => r.userId === userId) : rows;
}

vi.mock("../db.js", () => ({
  prisma: {
    emailMessage: {
      findMany: vi.fn(
        async ({ where }: { where: { userId?: string; receivedAt?: { gte?: Date } } }) => {
          const rows = byUser(stores.emails, where.userId);
          const floor = where.receivedAt?.gte;
          return floor ? rows.filter((row) => row.receivedAt >= floor) : rows;
        },
      ),
    },
    conversation: {
      findMany: vi.fn(async ({ where }: { where: { userId?: string } }) =>
        byUser(stores.conversations, where.userId),
      ),
    },
    pendingAction: {
      findMany: vi.fn(async ({ where }: { where: { userId?: string; status?: string } }) =>
        byUser(stores.pendingActions, where.userId).filter(
          (a) => !where.status || a.status === where.status,
        ),
      ),
    },
    commitment: {
      findMany: vi.fn(async ({ where }: { where: { userId?: string; status?: string } }) =>
        byUser(stores.commitments, where.userId).filter(
          (c) => !where.status || c.status === where.status,
        ),
      ),
    },
  },
}));

import { buildWorkGraphSummary } from "../work-graph.js";

const NOW = new Date("2026-04-28T12:00:00.000Z").getTime();

function resetStores() {
  stores.emails.length = 0;
  stores.conversations.length = 0;
  stores.pendingActions.length = 0;
  stores.commitments.length = 0;
}

describe("buildWorkGraphSummary", () => {
  beforeEach(resetStores);

  it("groups email thread signals with matching commitments", async () => {
    stores.emails.push({
      id: "email-1",
      userId: "user-1",
      threadId: "thread-1",
      from: "Minsu <minsu@example.com>",
      to: "me@example.com",
      subject: "Re: PartnerCo proposal",
      isRead: false,
      priority: "URGENT",
      receivedAt: new Date("2026-04-28T10:00:00.000Z"),
    });
    stores.commitments.push({
      id: "commitment-1",
      userId: "user-1",
      title: "제안서 보내기",
      description: "PartnerCo proposal",
      status: "OPEN",
      owner: "USER",
      counterpartyName: "Minsu",
      dueAt: new Date("2026-04-27T09:00:00.000Z"),
      dueText: "어제",
      sourceType: "EMAIL",
      sourceId: "email-1",
      threadId: "thread-1",
      createdAt: new Date("2026-04-28T09:00:00.000Z"),
      updatedAt: new Date("2026-04-28T09:00:00.000Z"),
    });

    const summary = await buildWorkGraphSummary("user-1", { now: NOW });

    expect(summary.contexts[0]).toMatchObject({
      id: "email:thread-1",
      kind: "email_thread",
      title: "PartnerCo proposal",
      href: "/email/email-1",
      risk: "high",
      signals: {
        emails: 1,
        unreadEmails: 1,
        urgentEmails: 1,
        commitments: 1,
        overdueCommitments: 1,
      },
    });
    expect(summary.contexts[0].people).toContainEqual({
      name: "Minsu",
      email: "minsu@example.com",
    });
    expect(summary.contexts[0].reasons).toContain("Overdue commitment");
  });

  it("groups pending actions into their chat conversation context", async () => {
    stores.conversations.push({
      id: "chat-1",
      userId: "user-1",
      title: "Launch prep",
      createdAt: new Date("2026-04-28T08:00:00.000Z"),
      updatedAt: new Date("2026-04-28T10:00:00.000Z"),
    });
    stores.pendingActions.push({
      id: "pa-1",
      userId: "user-1",
      conversationId: "chat-1",
      status: "PENDING",
      toolName: "send_email",
      createdAt: new Date("2026-04-28T11:00:00.000Z"),
    });

    const summary = await buildWorkGraphSummary("user-1", { now: NOW });

    expect(summary.contexts[0]).toMatchObject({
      id: "chat:chat-1",
      kind: "chat_conversation",
      title: "Launch prep",
      href: "/chat/chat-1",
      risk: "high",
      signals: { pendingActions: 1 },
    });
  });

  it("keeps loose commitments visible even without a source thread", async () => {
    stores.commitments.push({
      id: "commitment-loose",
      userId: "user-1",
      title: "계약서 검토",
      description: null,
      status: "OPEN",
      owner: "USER",
      counterpartyName: null,
      dueAt: null,
      dueText: null,
      sourceType: "NOTE",
      sourceId: null,
      threadId: null,
      createdAt: new Date("2026-04-28T09:00:00.000Z"),
      updatedAt: new Date("2026-04-28T09:00:00.000Z"),
    });

    const summary = await buildWorkGraphSummary("user-1", { now: NOW });

    expect(summary.contexts[0]).toMatchObject({
      id: "commitment:commitment-loose",
      kind: "loose_commitment",
      title: "계약서 검토",
      risk: "medium",
      signals: { commitments: 1 },
    });
  });

  it("limits contexts while ignoring invalid limits", async () => {
    stores.emails.push(
      {
        id: "email-1",
        userId: "user-1",
        threadId: "thread-1",
        from: "a@example.com",
        to: "me@example.com",
        subject: "First",
        isRead: false,
        priority: "NORMAL",
        receivedAt: new Date("2026-04-28T10:00:00.000Z"),
      },
      {
        id: "email-2",
        userId: "user-1",
        threadId: "thread-2",
        from: "b@example.com",
        to: "me@example.com",
        subject: "Second",
        isRead: false,
        priority: "NORMAL",
        receivedAt: new Date("2026-04-28T09:00:00.000Z"),
      },
    );

    const limited = await buildWorkGraphSummary("user-1", { limit: 1, now: NOW });
    const invalid = await buildWorkGraphSummary("user-1", { limit: -1, now: NOW });

    expect(limited.contexts).toHaveLength(1);
    expect(invalid.contexts).toHaveLength(2);
  });

  it("excludes emails older than the 14-day active window so stale signals stop surfacing", async () => {
    const recent = new Date(NOW - 2 * 24 * 60 * 60 * 1000);
    const stale = new Date(NOW - 30 * 24 * 60 * 60 * 1000);
    stores.emails.push(
      {
        id: "email-recent",
        userId: "user-1",
        threadId: "thread-recent",
        from: "Sarah <sarah@example.com>",
        to: "me@example.com",
        subject: "Follow-up this week",
        isRead: false,
        priority: "URGENT",
        receivedAt: recent,
      },
      {
        id: "email-stale",
        userId: "user-1",
        threadId: "thread-stale",
        from: "Vercel <noreply@vercel.com>",
        to: "me@example.com",
        subject: "Failed preview deployment",
        isRead: false,
        priority: "URGENT",
        receivedAt: stale,
      },
    );

    const summary = await buildWorkGraphSummary("user-1", { now: NOW });
    const ids = summary.contexts.map((c) => c.id);
    expect(ids).toContain("email:thread-recent");
    expect(ids).not.toContain("email:thread-stale");
  });
});
