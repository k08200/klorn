/**
 * Where-clause builder for the autonomous agent's email context window.
 *
 * Two branches OR'd together:
 *
 *   1. Unread emails from the last 24h — the long-standing dedup window
 *      that keeps the agent from re-processing old threads every cycle.
 *
 *   2. Any email (read or unread) from the last 30 minutes — needed because
 *      Gmail auto-marks self-sends and many notification emails as read at
 *      delivery, which would otherwise permanently hide a just-arrived
 *      meeting request from the agent's context. The window is tight to
 *      avoid re-processing emails the user already triaged.
 *
 * Extracted from agent-context.ts so the windowing rule is testable in
 * isolation (no DB or Prisma needed) and changes here can't silently shift
 * the agent's awareness of recent mail.
 */

export const AGENT_EMAIL_UNREAD_WINDOW_MS = 24 * 60 * 60 * 1000;
export const AGENT_EMAIL_RECENT_WINDOW_MS = 30 * 60 * 1000;

interface DateBound {
  gte: Date;
}

interface UnreadBranch {
  isRead: false;
  receivedAt: DateBound;
}

interface RecentBranch {
  receivedAt: DateBound;
}

export interface AgentEmailWhere {
  userId: string;
  OR: [UnreadBranch, RecentBranch];
}

export function buildAgentEmailWhere(userId: string, now: Date): AgentEmailWhere {
  return {
    userId,
    OR: [
      {
        isRead: false,
        receivedAt: { gte: new Date(now.getTime() - AGENT_EMAIL_UNREAD_WINDOW_MS) },
      },
      {
        receivedAt: { gte: new Date(now.getTime() - AGENT_EMAIL_RECENT_WINDOW_MS) },
      },
    ],
  };
}
