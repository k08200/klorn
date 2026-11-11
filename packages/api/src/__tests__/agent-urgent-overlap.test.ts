/**
 * Which mail an agent notify_user is about, and whether that mail already rang
 * the user as an urgent-mail push (agent-urgent-overlap.ts).
 *
 * Production, 2026-11-11: one PUSH mail rang "Urgent email" (interrupt) and
 * 13 s later the agent's notify_user rang "[Klorn] Unverified quote request
 * with a deadline" (ambient) for the same mail. The agent only deduped against
 * its own notifications, never against the urgent-mail bell row.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const notificationFindMany = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => {
  const prisma = { notification: { findMany: notificationFindMany } };
  return { prisma, db: prisma };
});

import { NOTIFY_TOOL } from "../agent/prompt.js";
import {
  type AgentContextEmail,
  notifyTargetEmails,
  urgentRungEmailIds,
} from "../agentcore/agent-urgent-overlap.js";
import { URGENT_EMAIL_TITLES } from "../notify/notification-strings.js";

const t0 = new Date("2026-11-11T02:00:00Z");
const quote: AgentContextEmail = { id: "email-quote", gmailId: "g-quote", createdAt: t0 };
const lunch: AgentContextEmail = { id: "email-lunch", gmailId: "g-lunch", createdAt: t0 };
const CONTEXT = [quote, lunch];

describe("notifyTargetEmails", () => {
  it("names the one context mail its emailRef points at, whatever the category", () => {
    expect(notifyTargetEmails({ emailRef: 1, category: "email" }, CONTEXT)).toEqual([quote]);
    expect(notifyTargetEmails({ emailRef: 2, category: "reminder" }, CONTEXT)).toEqual([lunch]);
  });

  it("reads a ref the model wrote as text", () => {
    expect(notifyTargetEmails({ emailRef: "2", category: "email" }, CONTEXT)).toEqual([lunch]);
    expect(notifyTargetEmails({ emailRef: "Email #1", category: "email" }, CONTEXT)).toEqual([
      quote,
    ]);
    expect(notifyTargetEmails({ emailRef: "#2", category: "insight" }, CONTEXT)).toEqual([lunch]);
  });

  it("ignores text too long to be a ref", () => {
    const padded = `${" ".repeat(20_000)}1`;
    expect(notifyTargetEmails({ emailRef: padded, category: "calendar" }, CONTEXT)).toEqual([]);
  });

  it("an email notification without a usable ref may be about any context mail", () => {
    expect(notifyTargetEmails({ category: "email" }, CONTEXT)).toEqual(CONTEXT);
    for (const bad of [0, 3, -1, 1.5, "x", "", null, {}]) {
      expect(notifyTargetEmails({ emailRef: bad, category: "email" }, CONTEXT)).toEqual(CONTEXT);
    }
  });

  it("a non-email notification without a usable ref is about no mail", () => {
    expect(notifyTargetEmails({ category: "calendar" }, CONTEXT)).toEqual([]);
    expect(notifyTargetEmails({ emailRef: 9, category: "task" }, CONTEXT)).toEqual([]);
    expect(notifyTargetEmails({}, CONTEXT)).toEqual([]);
  });

  it("no context mail → no target, even for an email notification", () => {
    expect(notifyTargetEmails({ category: "email" }, [])).toEqual([]);
    expect(notifyTargetEmails({ emailRef: 1, category: "email" }, [])).toEqual([]);
  });
});

describe("notify_user tool schema", () => {
  it("asks the model for emailRef on every call, so the run can name the mail", () => {
    const { properties, required } = NOTIFY_TOOL.function.parameters as {
      properties: Record<string, { type?: string }>;
      required: string[];
    };
    expect(properties.emailRef?.type).toBe("integer");
    expect(required).toContain("emailRef");
  });
});

describe("urgentRungEmailIds", () => {
  beforeEach(() => {
    notificationFindMany.mockReset();
    notificationFindMany.mockResolvedValue([]);
  });

  it("reads urgent-mail bell rows of every language, hidden claims too, for the last 7 days", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-11T03:00:00Z"));
    try {
      await urgentRungEmailIds("u1", CONTEXT);
    } finally {
      vi.useRealTimers();
    }

    expect(notificationFindMany).toHaveBeenCalledTimes(1);
    const { where } = notificationFindMany.mock.calls[0][0];
    expect(where.userId).toBe("u1");
    expect(where.type).toEqual({ in: ["email", "claim"] });
    expect(where.title).toEqual({ in: [...URGENT_EMAIL_TITLES] });
    expect(where.createdAt.gte.toISOString()).toBe("2026-11-04T03:00:00.000Z");
  });

  it("a firewall bell row names its mail by sourceEmailId", async () => {
    notificationFindMany.mockResolvedValue([
      { sourceEmailId: "email-quote", message: "Kim: 견적서 [g-quote]", createdAt: t0 },
    ]);
    expect(await urgentRungEmailIds("u1", CONTEXT)).toEqual(new Set(["email-quote"]));
  });

  it("an urgent-sweep batch row names its mails by the trailing [id,…] marker", async () => {
    notificationFindMany.mockResolvedValue([
      { sourceEmailId: null, message: "2 urgent emails [g-other,g-lunch]", createdAt: t0 },
    ]);
    expect(await urgentRungEmailIds("u1", CONTEXT)).toEqual(new Set(["email-lunch"]));
  });

  it("an IMAP marker written before the row existed names an older message (B2b)", async () => {
    const imap: AgentContextEmail = {
      id: "email-imap",
      gmailId: "naver-imap:me@naver.com:5",
      createdAt: new Date("2026-11-11T02:00:00Z"),
    };
    notificationFindMany.mockResolvedValue([
      {
        sourceEmailId: null,
        message: "Old [naver-imap:me@naver.com:5]",
        createdAt: new Date("2026-11-10T02:00:00Z"),
      },
    ]);
    expect(await urgentRungEmailIds("u1", [imap])).toEqual(new Set());
  });

  it("no rows, or no mail to check → nothing rang (and no query without mail)", async () => {
    expect(await urgentRungEmailIds("u1", CONTEXT)).toEqual(new Set());
    notificationFindMany.mockClear();
    expect(await urgentRungEmailIds("u1", [])).toEqual(new Set());
    expect(notificationFindMany).not.toHaveBeenCalled();
  });
});
