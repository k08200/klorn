/**
 * Reminder / Follow-up system for Eve
 * "3일 후에 다시 확인해줘", "내일 오전 9시에 알려줘"
 */

import { prisma } from "../db.js";

export async function listReminders(userId: string, includeCompleted = false) {
  const where: Record<string, unknown> = { userId };
  if (!includeCompleted) {
    where.status = "PENDING";
  }

  const reminders = await prisma.reminder.findMany({
    where,
    orderBy: { remindAt: "asc" },
  });

  return {
    reminders: reminders.map(
      (r: {
        id: string;
        title: string;
        description: string | null;
        remindAt: Date;
        status: string;
      }) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        remindAt: r.remindAt.toISOString(),
        status: r.status,
      }),
    ),
  };
}

export async function createReminder(
  userId: string,
  title: string,
  remindAt: string,
  description?: string,
) {
  const reminder = await prisma.reminder.create({
    data: {
      userId,
      title,
      description: description || null,
      remindAt: new Date(remindAt),
    },
  });

  return {
    success: true,
    reminder: { id: reminder.id, title: reminder.title, remindAt: reminder.remindAt.toISOString() },
  };
}

export async function dismissReminder(reminderId: string) {
  await prisma.reminder.update({
    where: { id: reminderId },
    data: { status: "DISMISSED" },
  });
  return { success: true };
}

export async function deleteReminder(reminderId: string) {
  await prisma.reminder.delete({ where: { id: reminderId } });
  return { success: true };
}

/** Check for due reminders — called by background cron */
export async function checkDueReminders(): Promise<
  { id: string; userId: string; title: string; description: string | null }[]
> {
  const now = new Date();
  const due = await prisma.reminder.findMany({
    where: {
      status: "PENDING",
      remindAt: { lte: now },
    },
  });

  // Mark as sent
  if (due.length > 0) {
    await prisma.reminder.updateMany({
      where: { id: { in: due.map((r: { id: string }) => r.id) } },
      data: { status: "SENT" },
    });
  }

  return due.map(
    (r: { id: string; userId: string; title: string; description: string | null }) => ({
      id: r.id,
      userId: r.userId,
      title: r.title,
      description: r.description,
    }),
  );
}

export const REMINDER_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "list_reminders",
      description: "List the user's pending reminders and follow-ups",
      parameters: {
        type: "object",
        properties: {
          include_completed: {
            type: "boolean",
            description: "Include completed/dismissed reminders (default false)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "create_reminder",
      description:
        "Create a reminder or follow-up. Use when the user says things like '3일 후에 다시 확인해줘', '내일 9시에 알려줘', 'follow up next week'",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "What to remind about" },
          remind_at: {
            type: "string",
            description: "When to remind, in ISO 8601 format (e.g. 2026-03-25T09:00:00+09:00)",
          },
          description: { type: "string", description: "Additional details (optional)" },
        },
        required: ["title", "remind_at"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "dismiss_reminder",
      description: "Dismiss a reminder",
      parameters: {
        type: "object",
        properties: {
          reminder_id: { type: "string", description: "The reminder ID to dismiss" },
        },
        required: ["reminder_id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "delete_reminder",
      description: "Delete a reminder",
      parameters: {
        type: "object",
        properties: {
          reminder_id: { type: "string", description: "The reminder ID to delete" },
        },
        required: ["reminder_id"],
      },
    },
  },
];
