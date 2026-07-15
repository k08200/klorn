/**
 * Build the user context block the autonomous agent ships to the LLM.
 *
 * Extracted from autonomous-agent.ts (2026-05-19): this used to be a
 * single ~475-line function inside the main agent file. Splitting it
 * out lets the agent file focus on the reasoning loop and lets us
 * iterate on the context shape (cross-domain hints, ordering, per-user
 * timezone formatting) without rebasing through tool routing logic.
 *
 * The output is a Markdown-flavored string. The agent passes it as the
 * `user` message in the LLM call; AGENT_SYSTEM_PROMPT (in agent/prompt.ts)
 * is the `system` message.
 *
 * Sections produced (in order):
 *   - Suppressed Recent Proposal Topics (if any)
 *   - Open Tasks
 *   - Upcoming Calendar (next 7 days)
 *   - Pending Reminders (if any)
 *   - Recent Notes (if any)
 *   - Recent Emails (no-reply filtered out)
 *   - Unread Notifications count
 *   - Key Contacts (if any)
 *   - What User Recently Asked Klorn (if any)
 *   - Your Previous Decisions (if any)
 *   - Cross-Domain Insights (deadline cluster / free time / meeting-contact /
 *     meeting-task / email-contact links)
 *   - Current Time (user's local zone + UTC) — LAST on purpose: it changes every call,
 *     and provider prompt caching matches on prefix, so putting it first
 *     would bust the cache for the entire context every tick.
 */

import { AGENT_MAX_CONTEXT_ITEMS } from "../config.js";
import { db, prisma } from "../db.js";
import { isNoReplyAddress } from "../mail/gmail.js";
import { captureError } from "../sentry.js";
import { offsetStringFor } from "../time-zone.js";
import { wrapUntrusted } from "../untrusted.js";
import { getUserTimeZone } from "../user-timezone.js";
import { buildAgentEmailWhere } from "./agent-email-context-filter.js";
import {
  filterSuppressedContextItems,
  formatRecentProposalSuppressions,
  getRecentProposalSuppressions,
} from "./agent-proposal-dedup.js";

const MAX_CONTEXT_ITEMS = AGENT_MAX_CONTEXT_ITEMS;

/**
 * Stringify EmailMessage.actionItems for prompt embedding.
 *
 * The column is now JSONB (a `string[]` payload), but historic rows
 * predating migration 20260519040000 may still arrive as a JSON-encoded
 * string. Accept both shapes and produce a stable bullet-joined text
 * for the LLM context block.
 */
function formatActionItems(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string").join("; ");
  }
  if (typeof value === "string") {
    if (!value) return "";
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === "string").join("; ");
      }
    } catch {
      /* legacy plaintext */
    }
    return value;
  }
  return "";
}

/**
 * Surface a degraded context branch. Each query in gatherUserContext is
 * independently fail-soft, but historically swallowed its error with a bare
 * `.catch(() => [])` — so a branch failing systematically (e.g. a bad column
 * after a migration) left the agent reasoning on silently-incomplete context
 * forever, with zero operator signal. Log every degradation the way the
 * judge-context siblings do: console first (visible without a Sentry DSN on
 * self-host / dev), then captureError. Message-only to keep any PII a raw
 * Prisma error might embed out of the console line.
 */
function logContextBranchFailure(branch: string, err: unknown, userId: string): void {
  console.warn(
    `[agent-context] ${branch} fetch failed (degrading to empty):`,
    err instanceof Error ? err.message : String(err),
  );
  captureError(err, { tags: { scope: `agent-context.${branch}` }, extra: { userId } });
}

/** Gather full user context for LLM reasoning. */
export async function gatherUserContext(userId: string): Promise<string> {
  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const in7d = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const userZone = await getUserTimeZone(userId);

  // Format current time in the user's own zone using Intl (avoids
  // double-offset bugs versus manual arithmetic).
  const localFormatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: userZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const localStr = `${localFormatter.format(now).replace(" ", "T")}${offsetStringFor(now, userZone)}`;

  const [
    tasks,
    calendar,
    reminders,
    notes,
    unreadNotifs,
    emails,
    contacts,
    recentAgentLogs,
    recentChatMessages,
    recentProposalSuppressions,
  ] = await Promise.all([
    // Each query below is independently fail-soft (matches the emails/
    // agentLogs/chatMessages/proposalSuppressions branches further down):
    // before this, a transient failure in any ONE of these six unprotected
    // queries rejected the whole Promise.all and threw away every OTHER
    // already-successful branch too — not just its own slice of context.
    prisma.task
      .findMany({
        where: { userId, status: { not: "DONE" } },
        orderBy: { dueDate: "asc" },
        take: MAX_CONTEXT_ITEMS * 2,
      })
      .catch((err) => {
        logContextBranchFailure("tasks", err, userId);
        return [];
      }),
    prisma.calendarEvent
      .findMany({
        where: { userId, startTime: { gte: now, lte: in7d } },
        orderBy: { startTime: "asc" },
        take: MAX_CONTEXT_ITEMS * 2,
      })
      .catch((err) => {
        logContextBranchFailure("calendar", err, userId);
        return [];
      }),
    prisma.reminder
      .findMany({
        where: { userId, status: "PENDING" },
        orderBy: { remindAt: "asc" },
        take: MAX_CONTEXT_ITEMS * 2,
      })
      .catch((err) => {
        logContextBranchFailure("reminders", err, userId);
        return [];
      }),
    prisma.note
      .findMany({
        where: { userId },
        orderBy: { updatedAt: "desc" },
        take: 5,
      })
      .catch((err) => {
        logContextBranchFailure("notes", err, userId);
        return [];
      }),
    prisma.notification
      .count({
        where: { userId, isRead: false },
      })
      .catch((err) => {
        logContextBranchFailure("unreadNotifs", err, userId);
        return 0;
      }),
    // Email context: unread from last 24h (long dedup window) OR any email
    // from last 30min regardless of read state. The recent-any-read branch
    // is critical for the approval flow — Gmail auto-marks self-sends and
    // notification mail as read, which would otherwise permanently hide a
    // just-arrived meeting request from the agent.
    prisma.emailMessage
      .findMany({
        where: buildAgentEmailWhere(userId, now),
        orderBy: { receivedAt: "desc" },
        take: 10,
        select: {
          id: true,
          gmailId: true,
          from: true,
          subject: true,
          snippet: true,
          body: true,
          summary: true,
          category: true,
          priority: true,
          actionItems: true,
          isRead: true,
          receivedAt: true,
        },
      })
      .catch((err) => {
        logContextBranchFailure("emails", err, userId);
        return [] as Array<{
          id: string;
          gmailId: string;
          from: string;
          subject: string;
          snippet: string;
          body: string | null;
          summary: string | null;
          category: string | null;
          priority: string;
          // JSONB after migration 20260519040000; legacy callers can
          // still pass the JSON-string form because formatActionItems
          // accepts both.
          actionItems: unknown;
          isRead: boolean;
          receivedAt: Date;
        }>;
      }),
    // Key contacts for cross-domain reasoning (link email sender to contact).
    prisma.contact
      .findMany({
        where: { userId },
        orderBy: { updatedAt: "desc" },
        take: 10,
        select: {
          name: true,
          email: true,
          company: true,
          role: true,
          tags: true,
        },
      })
      .catch((err) => {
        logContextBranchFailure("contacts", err, userId);
        return [];
      }),
    // Recent agent decisions — continuity across cycles (prevents amnesia).
    db.agentLog
      .findMany({
        where: {
          userId,
          createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
        },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { action: true, summary: true, createdAt: true },
      })
      .catch((err) => {
        logContextBranchFailure("recentAgentLogs", err, userId);
        return [];
      }),
    // Recent user chat messages — what the user is currently working on.
    prisma.message
      .findMany({
        where: {
          conversation: { userId },
          role: "USER",
          createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
        },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { content: true, createdAt: true },
      })
      .catch((err) => {
        logContextBranchFailure("recentChatMessages", err, userId);
        return [];
      }),
    getRecentProposalSuppressions(userId).catch((err) => {
      logContextBranchFailure("proposalSuppressions", err, userId);
      return [];
    }),
  ]);

  const suppressedTasks = filterSuppressedContextItems(
    tasks,
    (t: { title: string; description: string | null; dueDate: Date | null }) =>
      `${t.title} ${t.description || ""} ${t.dueDate?.toISOString() || ""}`,
    recentProposalSuppressions,
  );
  const visibleTasks = suppressedTasks.visible.slice(0, MAX_CONTEXT_ITEMS);
  const suppressedCalendar = filterSuppressedContextItems(
    calendar,
    (e: {
      title: string;
      description: string | null;
      startTime: Date;
      endTime: Date;
      location: string | null;
    }) =>
      `${e.title} ${e.description || ""} ${e.location || ""} ${e.startTime.toISOString()} ${e.endTime.toISOString()}`,
    recentProposalSuppressions,
  );
  const visibleCalendar = suppressedCalendar.visible.slice(0, MAX_CONTEXT_ITEMS);
  const suppressedReminders = filterSuppressedContextItems(
    reminders,
    (r: { title: string; description: string | null; remindAt: Date }) =>
      `${r.title} ${r.description || ""} ${r.remindAt.toISOString()}`,
    recentProposalSuppressions,
  );
  const visibleReminders = suppressedReminders.visible.slice(0, MAX_CONTEXT_ITEMS);
  const suppressedEmails = filterSuppressedContextItems(
    emails || [],
    (e: {
      from: string;
      subject: string;
      snippet: string | null;
      body: string | null;
      summary: string | null;
      actionItems: unknown;
    }) =>
      `${e.from} ${e.subject} ${e.summary || ""} ${formatActionItems(e.actionItems)} ${e.snippet || ""} ${e.body || ""}`,
    recentProposalSuppressions,
  );
  const visibleEmails = suppressedEmails.visible.slice(0, 5);
  const hiddenContextItems =
    suppressedTasks.hidden +
    suppressedCalendar.hidden +
    suppressedReminders.hidden +
    suppressedEmails.hidden;

  const sections: string[] = [];

  // NOTE: the volatile "Current Time" section is pushed LAST (see the end
  // of this function). Provider-side prompt caching (OpenAI automatic,
  // Gemini implicit) matches on prefix — a second-precision timestamp as
  // the first section busts the cache for every byte after it on every
  // 5-minute tick.

  const suppressionSummary = formatRecentProposalSuppressions(recentProposalSuppressions);
  if (suppressionSummary) {
    sections.push(
      hiddenContextItems > 0
        ? `${suppressionSummary}\n\nHidden matching context items before reasoning: ${hiddenContextItems}`
        : suppressionSummary,
    );
  }

  if (visibleTasks.length > 0) {
    const taskLines = visibleTasks.map(
      (t: { dueDate: Date | null; priority: string | null; title: string; status: string }) => {
        const due = t.dueDate ? t.dueDate.toISOString().split("T")[0] : "no due date";
        const overdue = t.dueDate && t.dueDate < now ? " ⚠️ OVERDUE" : "";
        const dueSoon = t.dueDate && t.dueDate < in24h && !overdue ? " ⏰ DUE SOON" : "";
        return `- [${t.priority || "MEDIUM"}] ${t.title} (due: ${due}${overdue}${dueSoon}) — status: ${t.status}`;
      },
    );
    sections.push(`## Open Tasks (${visibleTasks.length})\n${taskLines.join("\n")}`);
  } else {
    sections.push("## Open Tasks\nNone");
  }

  if (visibleCalendar.length > 0) {
    const calLines = visibleCalendar.map(
      (e: { title: string; startTime: Date; meetingLink: string | null }) => {
        const start = e.startTime.toLocaleString("en-US", {
          timeZone: userZone,
        });
        const minutesUntil = Math.round((e.startTime.getTime() - now.getTime()) / 60_000);
        const soon = minutesUntil <= 30 && minutesUntil > 0 ? " 🔴 STARTING SOON" : "";
        const meeting = e.meetingLink ? ` [meeting: ${e.meetingLink}]` : "";
        return `- ${e.title} @ ${start}${soon}${meeting}`;
      },
    );
    sections.push(`## Upcoming Calendar (next 7 days)\n${calLines.join("\n")}`);
  } else {
    sections.push("## Upcoming Calendar\nNone");
  }

  if (visibleReminders.length > 0) {
    const remLines = visibleReminders.map((r: { title: string; remindAt: Date }) => {
      const at = r.remindAt.toLocaleString("en-US", { timeZone: userZone });
      const overdue = r.remindAt < now ? " ⚠️ PAST DUE" : "";
      return `- ${r.title} @ ${at}${overdue}`;
    });
    sections.push(`## Pending Reminders\n${remLines.join("\n")}`);
  }

  if (notes.length > 0) {
    const noteLines = notes.map(
      (n: { title: string; updatedAt: Date }) =>
        `- ${n.title} (updated: ${n.updatedAt.toISOString().split("T")[0]})`,
    );
    sections.push(`## Recent Notes\n${noteLines.join("\n")}`);
  }

  // Drop emails that should never trigger a reply proposal: no-reply,
  // notifications, security alerts, bounces. The LLM will otherwise
  // hallucinate a `to` (often the sender's domain) and spam the user with
  // approval prompts for auto-replies that cannot be delivered.
  // `isNoReplyAddress` uses string parsing rather than regex because the
  // From header is attacker-controllable (CodeQL js/polynomial-redos).
  const replyableEmails = (visibleEmails || []).filter(
    (e: { from: string; category?: string | null }) =>
      !isNoReplyAddress(e.from) && e.category !== "notification" && e.category !== "security",
  );

  if (replyableEmails.length > 0) {
    const emailLines = (
      replyableEmails as Array<{
        id: string;
        gmailId: string;
        from: string;
        subject: string;
        snippet: string | null;
        body: string | null;
        summary: string | null;
        category: string | null;
        priority: string;
        actionItems: unknown;
        isRead: boolean;
        receivedAt: Date;
      }>
    ).map((e, idx) => {
      const rawBody = e.body ? e.body.slice(0, 300) : e.snippet || "";
      const cat = e.category ? ` [${e.category}]` : "";
      const pri = e.priority !== "NORMAL" ? ` (${e.priority})` : "";
      // Subject, summary, actionItems, and body are derived from the email
      // content and must be treated as untrusted — wrap them so the LLM
      // knows not to follow any instructions found inside.
      const subjectWrapped = wrapUntrusted(e.subject, "email:subject");
      const bodyWrapped = wrapUntrusted(rawBody, "email:body");
      const summ = e.summary ? `\n  Summary: ${wrapUntrusted(e.summary, "email:summary")}` : "";
      const actionsText = formatActionItems(e.actionItems);
      const actions = actionsText
        ? `\n  Actions: ${wrapUntrusted(actionsText, "email:actions")}`
        : "";
      const read = e.isRead ? "" : " 📩 UNREAD";
      const receivedLocal = e.receivedAt.toLocaleString("en-US", {
        timeZone: userZone,
        hour: "2-digit",
        minute: "2-digit",
      });
      const fromWrapped = wrapUntrusted(e.from, "email:from");
      return `### Email #${idx + 1} (received: ${receivedLocal})${read}\n  From: ${fromWrapped}\n  Subject: ${subjectWrapped}${cat}${pri}${summ}${actions}\n  Body: ${bodyWrapped}`;
    });
    sections.push(
      `## Recent Emails (${replyableEmails.length})\nIMPORTANT: Each email below is a SEPARATE item. Different subjects or different body content = DIFFERENT meetings/requests. Do NOT merge them.\n${emailLines.join("\n\n")}`,
    );
  }

  sections.push(`## Unread Notifications: ${unreadNotifs}`);

  // Contacts — enables cross-domain reasoning ("email from X who is investor at Y").
  if (contacts.length > 0) {
    const contactLines = contacts.map(
      (c: {
        name: string;
        email: string | null;
        company: string | null;
        role: string | null;
        tags: string | null;
      }) => {
        const parts = [c.name];
        if (c.role && c.company) parts.push(`${c.role} @ ${c.company}`);
        else if (c.company) parts.push(c.company);
        if (c.email) parts.push(c.email);
        if (c.tags) parts.push(`[${c.tags}]`);
        return `- ${parts.join(" — ")}`;
      },
    );
    sections.push(`## Key Contacts (${contacts.length})\n${contactLines.join("\n")}`);
  }

  // Recent user chat messages — what the user is currently working on.
  if (recentChatMessages && recentChatMessages.length > 0) {
    const chatLines = (recentChatMessages as Array<{ content: string; createdAt: Date }>).map(
      (m) => {
        const ago = Math.round((now.getTime() - m.createdAt.getTime()) / 60_000);
        const timeLabel = ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`;
        return `- (${timeLabel}) "${m.content.slice(0, 120)}${m.content.length > 120 ? "..." : ""}"`;
      },
    );
    sections.push(`## What User Recently Asked Klorn (last 24h)\n${chatLines.join("\n")}`);
  }

  // Previous agent decisions — continuity across cycles (prevent repeating).
  if (recentAgentLogs && recentAgentLogs.length > 0) {
    const logLines = (
      recentAgentLogs as Array<{
        action: string;
        summary: string;
        createdAt: Date;
      }>
    ).map((l) => {
      const ago = Math.round((now.getTime() - l.createdAt.getTime()) / 60_000);
      const timeLabel = ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`;
      return `- [${l.action}] (${timeLabel}) ${l.summary.slice(0, 100)}`;
    });
    sections.push(
      `## Your Previous Decisions (last 24h)\nDo NOT repeat the same suggestions. Evolve your reasoning based on time passing.\n${logLines.join("\n")}`,
    );
  }

  // Cross-domain insights — pre-compute connections the LLM should notice.
  const crossDomainHints: string[] = [];

  // Deadline clustering — flag when multiple deadlines converge.
  const typedTasks = visibleTasks as Array<{
    title: string;
    status: string;
    priority: string | null;
    dueDate: Date | null;
  }>;
  const urgentTasks = typedTasks.filter((t) => t.dueDate && t.dueDate < in24h && t.dueDate > now);
  const overdueTasks = typedTasks.filter((t) => t.dueDate && t.dueDate < now);
  if (urgentTasks.length + overdueTasks.length >= 2) {
    crossDomainHints.push(
      `🔥 Deadline cluster: ${overdueTasks.length} overdue + ${urgentTasks.length} due within 24h → workload risk. Consider prioritizing or rescheduling.`,
    );
  }

  // Free time block detection — find available slots today for task work.
  const typedCalendar = visibleCalendar as Array<{
    title: string;
    startTime: Date;
    endTime?: Date;
    meetingLink: string | null;
  }>;
  const localNow = new Date(now.toLocaleString("en-US", { timeZone: userZone }));
  const todayEnd = new Date(localNow);
  todayEnd.setHours(23, 59, 59, 999);
  const todayEvents = typedCalendar.filter((e) => e.startTime < todayEnd);
  if (typedTasks.length > 0 && todayEvents.length <= 2) {
    crossDomainHints.push(
      `📅 Light calendar today (${todayEvents.length} events) — good opportunity to tackle pending tasks.`,
    );
  }

  // Link upcoming meetings to contacts and incomplete tasks.
  if (visibleCalendar.length > 0 && (contacts.length > 0 || visibleTasks.length > 0)) {
    for (const event of typedCalendar) {
      const minutesUntil = Math.round((event.startTime.getTime() - now.getTime()) / 60_000);
      if (minutesUntil > 0 && minutesUntil <= 24 * 60) {
        const relatedContacts = (
          contacts as Array<{ name: string; company: string | null }>
        ).filter(
          (c) => event.title.includes(c.name) || (c.company && event.title.includes(c.company)),
        );
        const relatedTasks = typedTasks.filter((t) => {
          const words = event.title.split(/\s+/).filter((w: string) => w.length > 2);
          return words.some((w: string) => t.title.includes(w));
        });

        if (relatedContacts.length > 0 || relatedTasks.length > 0) {
          const timeLabel =
            minutesUntil < 60 ? `${minutesUntil}min` : `${Math.round(minutesUntil / 60)}h`;
          let hint = `⚡ Meeting "${event.title}" in ${timeLabel}`;
          if (relatedContacts.length > 0) {
            hint += ` — attendee(s): ${relatedContacts.map((c) => `${c.name}${c.company ? ` (${c.company})` : ""}`).join(", ")}`;
          }
          if (relatedTasks.length > 0) {
            const incompleteTasks = relatedTasks.filter((t) => t.status !== "DONE");
            if (incompleteTasks.length > 0) {
              hint += ` — ⚠️ related incomplete tasks: ${incompleteTasks.map((t) => `"${t.title}" (${t.status})`).join(", ")} → preparation may be needed before meeting`;
            }
          }
          crossDomainHints.push(hint);
        }

        // Unanswered emails from meeting-related contacts.
        if (visibleEmails && visibleEmails.length > 0 && relatedContacts.length > 0) {
          for (const contact of relatedContacts as Array<{
            name: string;
            email: string | null;
            company: string | null;
          }>) {
            if (!contact.email) continue;
            const emailFromContact = (
              visibleEmails as Array<{ from: string; subject: string }>
            ).find((e) => e.from.toLowerCase().includes(contact.email!.toLowerCase()));
            if (emailFromContact) {
              crossDomainHints.push(
                `📨 Unanswered? Email from ${contact.name} ("${emailFromContact.subject}") + meeting with them in ${minutesUntil < 60 ? `${minutesUntil}min` : `${Math.round(minutesUntil / 60)}h`} → reply before meeting?`,
              );
            }
          }
        }
      }
    }
  }

  // Link emails to contacts (general, not meeting-specific).
  if (visibleEmails && visibleEmails.length > 0 && contacts.length > 0) {
    for (const email of visibleEmails as Array<{ from: string; subject: string }>) {
      const matchedContact = (
        contacts as Array<{
          name: string;
          email: string | null;
          company: string | null;
          tags: string | null;
        }>
      ).find((c) => c.email && email.from.toLowerCase().includes(c.email.toLowerCase()));
      if (matchedContact) {
        const importance =
          matchedContact.tags?.toLowerCase().includes("investor") ||
          matchedContact.tags?.toLowerCase().includes("client")
            ? " ⭐ HIGH PRIORITY"
            : "";
        crossDomainHints.push(
          `📧 Email from ${matchedContact.name}${matchedContact.company ? ` (${matchedContact.company})` : ""}${importance}: "${email.subject}"`,
        );
      }
    }
  }

  if (crossDomainHints.length > 0) {
    sections.push(
      `## 🔗 Cross-Domain Insights (use OBSERVE → CONNECT → PROPOSE on these)\n${crossDomainHints.join("\n")}`,
    );
  }

  // Volatile timestamp LAST — every section above stays a cacheable prefix
  // across the agent's 5-minute ticks (see NOTE at the top of this list).
  sections.push(`## Current Time\nLocal (${userZone}): ${localStr}\nUTC: ${now.toISOString()}`);

  return sections.join("\n\n");
}
