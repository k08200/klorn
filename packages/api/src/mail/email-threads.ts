/**
 * Email thread grouping (M3 decomposition, extracted from email-sync.ts).
 * Groups persisted EmailMessage rows by Gmail threadId for the thread view.
 * DB-only leaf; must NOT import email-sync.ts (would cycle).
 */

import { prisma } from "../db.js";

// ─── Thread Grouping ──────────────────────────────────────────────────────

export interface EmailThread {
  threadId: string;
  subject: string;
  participants: string[];
  messageCount: number;
  lastMessage: {
    id: string;
    from: string;
    snippet: string;
    receivedAt: Date;
    isRead: boolean;
  };
  hasUnread: boolean;
  latestPriority: "URGENT" | "NORMAL" | "LOW";
}

/**
 * Get email threads for a user, grouped by Gmail threadId.
 */
export async function getEmailThreads(
  userId: string,
  options: {
    skip?: number;
    take?: number;
    unreadOnly?: boolean;
    priority?: string;
    category?: string;
    search?: string;
  } = {},
): Promise<{ threads: EmailThread[]; total: number }> {
  const where: Record<string, unknown> = { userId };

  if (options.unreadOnly) where.isRead = false;
  if (options.priority) where.priority = options.priority;
  if (options.category) where.category = options.category;
  if (options.search) {
    where.OR = [
      { subject: { contains: options.search, mode: "insensitive" } },
      { from: { contains: options.search, mode: "insensitive" } },
      { snippet: { contains: options.search, mode: "insensitive" } },
      { body: { contains: options.search, mode: "insensitive" } },
    ];
  }

  // Get all matching emails
  const emails = await prisma.emailMessage.findMany({
    where: where as Parameters<typeof prisma.emailMessage.findMany>[0] extends {
      where?: infer W;
    }
      ? W
      : never,
    orderBy: { receivedAt: "desc" },
  });

  // Group by threadId
  const threadMap = new Map<string, typeof emails>();
  for (const email of emails) {
    const tid = email.threadId || email.gmailId;
    const existing = threadMap.get(tid) || [];
    existing.push(email);
    threadMap.set(tid, existing);
  }

  // Build thread summaries
  const threads: EmailThread[] = [];
  for (const [threadId, msgs] of threadMap) {
    const sorted = msgs.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
    const latest = sorted[0];
    const participants = [...new Set(sorted.map((m) => m.from))];

    threads.push({
      threadId,
      subject: latest.subject,
      participants,
      messageCount: sorted.length,
      lastMessage: {
        id: latest.id,
        from: latest.from,
        snippet: latest.snippet || "",
        receivedAt: latest.receivedAt,
        isRead: latest.isRead,
      },
      hasUnread: sorted.some((m) => !m.isRead),
      latestPriority: latest.priority as "URGENT" | "NORMAL" | "LOW",
    });
  }

  // Sort threads by latest message date
  threads.sort((a, b) => b.lastMessage.receivedAt.getTime() - a.lastMessage.receivedAt.getTime());

  const total = threads.length;
  const skip = options.skip || 0;
  const take = options.take || 20;

  return {
    threads: threads.slice(skip, skip + take),
    total,
  };
}
