import { describe, expect, it } from "vitest";
import {
  AGENT_EMAIL_RECENT_WINDOW_MS,
  AGENT_EMAIL_UNREAD_WINDOW_MS,
  buildAgentEmailWhere,
} from "../agentcore/agent-email-context-filter.js";

const NOW = new Date("2026-06-04T12:00:00.000Z");

describe("buildAgentEmailWhere", () => {
  it("scopes results to the given user id", () => {
    const where = buildAgentEmailWhere("user-x", NOW);
    expect(where.userId).toBe("user-x");
  });

  it("matches unread emails from the last 24 hours", () => {
    const where = buildAgentEmailWhere("user-x", NOW);
    const unreadClause = where.OR.find((c) => c.isRead === false);
    expect(unreadClause).toBeDefined();
    expect(unreadClause?.receivedAt.gte.getTime()).toBe(
      NOW.getTime() - AGENT_EMAIL_UNREAD_WINDOW_MS,
    );
    expect(AGENT_EMAIL_UNREAD_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("matches just-arrived emails regardless of read state", () => {
    const where = buildAgentEmailWhere("user-x", NOW);
    const recentClause = where.OR.find((c) => c.isRead === undefined);
    expect(recentClause).toBeDefined();
    expect(recentClause?.receivedAt.gte.getTime()).toBe(
      NOW.getTime() - AGENT_EMAIL_RECENT_WINDOW_MS,
    );
    // The recent window is tight — 30 minutes is enough to bridge Gmail-sync
    // → tier classification → agent run, but small enough that Gmail
    // auto-marking a self-send as read doesn't permanently hide the email
    // from the agent.
    expect(AGENT_EMAIL_RECENT_WINDOW_MS).toBe(30 * 60 * 1000);
  });

  it("emits exactly two OR branches (unread-24h | recent-any-read-state)", () => {
    const where = buildAgentEmailWhere("user-x", NOW);
    expect(where.OR).toHaveLength(2);
  });

  it("recent window is strictly shorter than unread window", () => {
    // Sanity: the relaxation must not exceed the dedup window or we lose the
    // 're-process old threads on every cycle' guard.
    expect(AGENT_EMAIL_RECENT_WINDOW_MS).toBeLessThan(AGENT_EMAIL_UNREAD_WINDOW_MS);
  });
});
