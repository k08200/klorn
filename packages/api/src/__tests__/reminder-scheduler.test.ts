import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendPushNotification } from "../push.js";
import { deliverDueReminderById, scheduleReminderDeliveryCheck } from "../reminder-scheduler.js";
import { captureError } from "../sentry.js";
import { pushNotification } from "../websocket.js";

type ReminderRow = {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  remindAt: Date;
  status: "PENDING" | "SENT";
};

type NotificationRow = {
  id: string;
  userId: string;
  type: string;
  title: string;
  message: string;
  createdAt: Date;
};

type PushPayload = {
  title: string;
  body: string;
  url?: string;
  notificationId?: string;
};

const state = vi.hoisted(() => ({
  reminders: new Map<string, ReminderRow>(),
  notifications: [] as NotificationRow[],
}));

vi.mock("../push.js", () => ({ sendPushNotification: vi.fn(async () => undefined) }));
vi.mock("../websocket.js", () => ({ pushNotification: vi.fn() }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../db.js", () => {
  const prisma = {
    reminder: {
      findFirst: vi.fn(
        ({ where }: { where: { id: string; status: string; remindAt: { lte: Date } } }) => {
          const reminder = state.reminders.get(where.id);
          if (!reminder) return null;
          if (reminder.status !== where.status) return null;
          if (reminder.remindAt > where.remindAt.lte) return null;
          return reminder;
        },
      ),
      updateMany: vi.fn(
        ({
          where,
          data,
        }: {
          where: { id: string; status: string; remindAt: { lte: Date } };
          data: { status: "SENT" };
        }) => {
          const reminder = state.reminders.get(where.id);
          if (!reminder) return { count: 0 };
          if (reminder.status !== where.status) return { count: 0 };
          if (reminder.remindAt > where.remindAt.lte) return { count: 0 };
          reminder.status = data.status;
          return { count: 1 };
        },
      ),
    },
    notification: {
      create: vi.fn(({ data }: { data: Omit<NotificationRow, "id" | "createdAt"> }) => {
        const notification: NotificationRow = {
          id: `notification-${state.notifications.length + 1}`,
          createdAt: new Date(),
          ...data,
        };
        state.notifications.push(notification);
        return notification;
      }),
    },
  };
  return { prisma };
});

function seedReminder(overrides: Partial<ReminderRow> = {}) {
  const reminder: ReminderRow = {
    id: "reminder-1",
    userId: "user-1",
    title: "테스트",
    description: null,
    remindAt: new Date(Date.now() - 1_000),
    status: "PENDING",
    ...overrides,
  };
  state.reminders.set(reminder.id, reminder);
  return reminder;
}

describe("reminder scheduler delivery", () => {
  beforeEach(() => {
    state.reminders.clear();
    state.notifications.length = 0;
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("delivers due reminders once and marks them sent", async () => {
    const reminder = seedReminder();

    await expect(deliverDueReminderById(reminder.id)).resolves.toBe(true);
    await expect(deliverDueReminderById(reminder.id)).resolves.toBe(false);

    expect(reminder.status).toBe("SENT");
    expect(state.notifications).toHaveLength(1);
    expect(pushNotification).toHaveBeenCalledTimes(1);
    expect(sendPushNotification).toHaveBeenCalledTimes(1);
    expect((vi.mocked(sendPushNotification).mock.calls[0]?.[1] as PushPayload).notificationId).toBe(
      "notification-1",
    );
  });

  it("surfaces a push delivery failure instead of swallowing it (F6)", async () => {
    vi.mocked(sendPushNotification).mockRejectedValueOnce(new Error("push boom"));
    const reminder = seedReminder();

    // Delivery itself still succeeds — push is best-effort/fire-and-forget.
    await expect(deliverDueReminderById(reminder.id)).resolves.toBe(true);

    // ...but the failure must leave a signal, not vanish.
    await vi.waitFor(() => expect(captureError).toHaveBeenCalled());
    const ctx = vi.mocked(captureError).mock.calls[0]?.[1] as { tags?: { scope?: string } };
    expect(ctx?.tags?.scope).toBe("reminder.push");
  });

  it("schedules a short direct delivery check", async () => {
    vi.useFakeTimers();
    const reminder = seedReminder({ remindAt: new Date(Date.now() + 1_000) });

    expect(scheduleReminderDeliveryCheck(reminder.id, reminder.remindAt)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_500);

    expect(reminder.status).toBe("SENT");
    expect(state.notifications).toHaveLength(1);
  });
});
