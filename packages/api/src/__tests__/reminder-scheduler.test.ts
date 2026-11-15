import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendPushNotification } from "../notify/push.js";
import {
  deliverDueReminderById,
  scheduleReminderDeliveryCheck,
} from "../pim/reminder-scheduler.js";
import { captureError } from "../sentry.js";
import { pushNotification } from "../websocket.js";
import { callText } from "./helpers/canary.js";
import { DB_CANARY, validationErrorQuotingText } from "./helpers/prisma-canary.js";

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
  link?: string | null;
  sourceEmailId?: string | null;
  createdAt: Date;
};

type PushPayload = {
  title: string;
  body: string;
  url?: string;
  notificationId?: string;
  emailId?: string;
  userSet?: boolean;
};

const state = vi.hoisted(() => ({
  reminders: new Map<string, ReminderRow>(),
  notifications: [] as NotificationRow[],
}));

vi.mock("../notify/push.js", () => ({ sendPushNotification: vi.fn(async () => undefined) }));
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

  it("rings a reminder the user set against the interrupt bucket, still labelled system", async () => {
    // A reminder is one the user asked for at a time: briefings and agent
    // proposals in the ambient bucket must not be able to crowd it out.
    const reminder = seedReminder();

    await deliverDueReminderById(reminder.id);

    expect(sendPushNotification).toHaveBeenCalledWith(
      reminder.userId,
      expect.objectContaining({ title: reminder.title }),
      "system",
      { bucket: "interrupt" },
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

  it("a mail reminder opens its mail: bell row link, push url, native deep link", async () => {
    const reminder = seedReminder({
      title: "Follow up: Contract",
      description: "From: Alice <a@x.io>\nOpen: /email/email-1",
    });

    await expect(deliverDueReminderById(reminder.id)).resolves.toBe(true);

    expect(state.notifications[0]).toMatchObject({
      type: "reminder",
      title: "Follow up: Contract",
      link: "/email/email-1",
      sourceEmailId: "email-1",
    });
    const [userId, payload, category] = vi.mocked(sendPushNotification).mock.calls[0] ?? [];
    expect(userId).toBe("user-1");
    expect(payload).toMatchObject({
      title: "Follow up: Contract",
      url: "/email/email-1",
      emailId: "email-1",
      notificationId: "notification-1",
      userSet: true,
    });
    // The user's own reminder: "system" — no category opt-out, ambient rate bucket,
    // quiet hours still apply (push.ts).
    expect(category).toBe("system");
  });

  it("a reminder that names no mail keeps its old target and no link", async () => {
    const reminder = seedReminder({ description: "Call the bank" });
    await deliverDueReminderById(reminder.id);
    expect(state.notifications[0]?.link ?? null).toBeNull();
    expect(state.notifications[0]?.sourceEmailId ?? null).toBeNull();
    const payload = vi.mocked(sendPushNotification).mock.calls[0]?.[1] as PushPayload;
    expect(payload.url).toBe("/chat");
    expect(payload.emailId).toBeUndefined();
  });
});

describe("a database error quoting the reminder never reaches Sentry or the console", () => {
  // A mail reminder's title is the mail's subject, and a Prisma error renders
  // the rejected call's arguments, title included.
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    state.reminders.clear();
    state.notifications.length = 0;
    vi.clearAllMocks();
    vi.useRealTimers();
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    error.mockRestore();
    vi.useRealTimers();
  });

  const expectNoCanary = () => {
    expect(callText(vi.mocked(captureError))).not.toContain(DB_CANARY);
    expect(callText(error)).not.toContain(DB_CANARY);
  };

  it("when the bell row cannot be written", async () => {
    const { prisma } = await import("../db.js");
    vi.mocked(prisma.notification.create).mockRejectedValueOnce(validationErrorQuotingText());
    // The claim runs the in-memory store; the revert to PENDING is awaited as a promise.
    const updateMany = vi.mocked(prisma.reminder.updateMany);
    const claim = updateMany.getMockImplementation();
    updateMany
      .mockImplementationOnce((args) => claim?.(args) as never)
      .mockImplementationOnce(async () => ({ count: 1 }) as never);
    const reminder = seedReminder({ title: `Re: ${DB_CANARY}` });

    await expect(deliverDueReminderById(reminder.id)).resolves.toBe(false);

    expect(vi.mocked(captureError).mock.calls[0]?.[1]).toMatchObject({
      tags: { scope: "reminder.deliver" },
      extra: { reminderId: reminder.id, errorName: "PrismaClientValidationError" },
    });
    expectNoCanary();
  });

  it("when the push fails", async () => {
    vi.mocked(sendPushNotification).mockRejectedValueOnce(validationErrorQuotingText());
    const reminder = seedReminder();

    await deliverDueReminderById(reminder.id);

    await vi.waitFor(() => expect(captureError).toHaveBeenCalled());
    expect(vi.mocked(captureError).mock.calls[0]?.[1]).toMatchObject({
      tags: { scope: "reminder.push" },
    });
    expectNoCanary();
  });

  it("when the direct delivery check fails", async () => {
    vi.useFakeTimers();
    const { prisma } = await import("../db.js");
    vi.mocked(prisma.reminder.findFirst).mockRejectedValueOnce(validationErrorQuotingText());
    const reminder = seedReminder({ remindAt: new Date(Date.now() + 1_000) });

    scheduleReminderDeliveryCheck(reminder.id, reminder.remindAt);
    await vi.advanceTimersByTimeAsync(1_500);

    expect(vi.mocked(captureError).mock.calls[0]?.[1]).toMatchObject({
      tags: { scope: "reminder.direct-delivery" },
    });
    expectNoCanary();
  });
});

describe("reminder scheduler bootstrap", () => {
  it("the server starts the scheduler unless background work is switched off", () => {
    const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const block = index.match(
      /if \(!BG_DISABLED\) \{\s*import\("\.\/pim\/reminder-scheduler\.js"\)\s*\.then\(\(\{ startReminderScheduler \}\) => \{\s*startReminderScheduler\(\);/,
    );
    expect(block).not.toBeNull();
  });
});
