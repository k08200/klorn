import { beforeEach, describe, expect, it, vi } from "vitest";

// sendPushNotification through the REAL rate limiter (push-rate-limit.ts) and
// the real per-call bucket choice (push-bucket.ts). Only the PushRingEvent
// table is faked: an in-memory store that honours the userId / bucket /
// createdAt filters the limiter sends. Everything after the limiter is mocked, and VAPID is unset in
// tests, so a push the limiter lets through ends at "missing_vapid_keys" and a
// push it blocks ends at "rate_limited".

interface Ring {
  userId: string;
  bucket: string;
  createdAt: Date;
}
interface RingWhere {
  userId: string;
  bucket?: string;
  createdAt: { gte?: Date; lt?: Date };
}

const rings: Ring[] = [];
const ringStore = { countError: null as Error | null };

function matches(ring: Ring, where: RingWhere): boolean {
  if (ring.userId !== where.userId) return false;
  if (where.bucket !== undefined && ring.bucket !== where.bucket) return false;
  if (where.createdAt.gte && ring.createdAt < where.createdAt.gte) return false;
  if (where.createdAt.lt && ring.createdAt >= where.createdAt.lt) return false;
  return true;
}

vi.mock("../db.js", () => ({
  prisma: {
    pushRingEvent: {
      count: vi.fn(async ({ where }: { where: RingWhere }) => {
        if (ringStore.countError) throw ringStore.countError;
        return rings.filter((r) => matches(r, where)).length;
      }),
      create: vi.fn(async ({ data }: { data: { userId: string; bucket?: string } }) => {
        // Mirrors the column default for rows written without a bucket.
        rings.push({
          userId: data.userId,
          bucket: data.bucket ?? "ambient",
          createdAt: new Date(),
        });
        return { id: `ring-${rings.length}` };
      }),
      deleteMany: vi.fn(async ({ where }: { where: RingWhere }) => {
        const before = rings.length;
        const kept = rings.filter((r) => !matches(r, where));
        rings.splice(0, rings.length, ...kept);
        return { count: before - kept.length };
      }),
    },
    pushSubscription: { findMany: vi.fn(async () => []), delete: vi.fn(async () => ({})) },
    pushDeliveryLog: { findFirst: vi.fn(async () => null) },
  },
}));
vi.mock("../notify/push-delivery.js", () => ({
  createPushDeliveryAttempt: vi.fn(async () => "delivery-id"),
  createSkippedPushDelivery: vi.fn(async () => {}),
  markPushAccepted: vi.fn(async () => {}),
  markPushFailed: vi.fn(async () => {}),
}));
vi.mock("../notify/notification-policy.js", () => ({
  notificationSuppressionReason: vi.fn(() => null),
}));
vi.mock("../notify/notification-prefs.js", () => ({
  evaluateNotificationGate: vi.fn(async () => ({ allowed: true as const })),
}));
vi.mock("../notify/push-device.js", () => ({ sendDevicePush: vi.fn(async () => ({})) }));
vi.mock("../notify/push-apns.js", () => ({ sendApnsPush: vi.fn(async () => ({})) }));
vi.mock("../notify/telegram-notify.js", () => ({
  sendTelegramForPush: vi.fn(async () => "sent"),
}));
vi.mock("web-push", () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() },
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(),
}));

import type { NotifCategory } from "../notify/notification-prefs.js";
import { type PushSendOptions, sendPushNotification } from "../notify/push.js";
import { createSkippedPushDelivery } from "../notify/push-delivery.js";
import { sendTelegramForPush } from "../notify/telegram-notify.js";

const USER = "user-1";

const INTERRUPT: PushSendOptions = { bucket: "interrupt" };

function push(category: NotifCategory, options?: PushSendOptions) {
  return sendPushNotification(USER, { title: "T", body: "B", url: "/briefing" }, category, options);
}

async function pushTimes(category: NotifCategory, n: number, options?: PushSendOptions) {
  const results = [];
  for (let i = 0; i < n; i++) results.push(await push(category, options));
  return results;
}

/** skipReasons recorded for rate-limited pushes, in order. */
function rateLimitSkipReasons(): string[] {
  return vi
    .mocked(createSkippedPushDelivery)
    .mock.calls.map(([input]) => input.skipReason)
    .filter((reason) => reason.startsWith("rate_limited"));
}

beforeEach(() => {
  vi.clearAllMocks();
  rings.length = 0;
  ringStore.countError = null;
});

describe("sendPushNotification — interrupt and ambient rate buckets", () => {
  it("10 ambient pushes do not block an urgent mail push", async () => {
    const briefings = await pushTimes("daily_briefing", 10);
    expect(briefings.filter((r) => r.reason === "rate_limited")).toHaveLength(7);

    const urgent = await push("email_urgent", INTERRUPT);

    expect(urgent.reason).toBe("missing_vapid_keys"); // passed the limiter
    expect(sendTelegramForPush).toHaveBeenLastCalledWith(
      USER,
      expect.objectContaining({ title: "T" }),
      "email_urgent",
    );
  });

  it("a meeting alert rides the interrupt bucket too", async () => {
    await pushTimes("agent_proposal", 5);
    await pushTimes("system", 5);

    const meeting = await push("meeting", INTERRUPT);

    expect(meeting.reason).toBe("missing_vapid_keys");
  });

  it("the interrupt bucket still has a cap: the 7th urgent push in 10 minutes is dropped", async () => {
    const urgent = await pushTimes("email_urgent", 7, INTERRUPT);

    expect(urgent.slice(0, 6).map((r) => r.reason)).toEqual(Array(6).fill("missing_vapid_keys"));
    expect(urgent[6]?.reason).toBe("rate_limited");
  });

  it("meetings and urgent mail share the interrupt cap", async () => {
    await pushTimes("email_urgent", 3, INTERRUPT);
    await pushTimes("meeting", 3, INTERRUPT);

    const seventh = await push("meeting", INTERRUPT);

    expect(seventh.reason).toBe("rate_limited");
  });

  it("interrupt traffic never uses up the ambient bucket", async () => {
    await pushTimes("email_urgent", 6, INTERRUPT);

    const briefing = await push("daily_briefing");

    expect(briefing.reason).toBe("missing_vapid_keys");
  });

  it("records which bucket made the rate-limit decision", async () => {
    await pushTimes("daily_briefing", 4);
    await pushTimes("meeting", 7, INTERRUPT);

    expect(rateLimitSkipReasons()).toEqual([
      "rate_limited_ambient:10min cap 3/3",
      "rate_limited_interrupt:10min cap 6/6",
    ]);
  });

  it("the 60-minute interrupt cap holds when the 10-minute window is clear", async () => {
    const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000);
    for (let i = 0; i < 20; i++) {
      rings.push({ userId: USER, bucket: "interrupt", createdAt: twentyMinAgo });
    }

    const urgent = await push("email_urgent", INTERRUPT);

    expect(urgent.reason).toBe("rate_limited");
    expect(rateLimitSkipReasons()).toEqual(["rate_limited_interrupt:60min cap 20/20"]);
  });

  it("another user's rings never count against this user", async () => {
    for (let i = 0; i < 50; i++) {
      rings.push({ userId: "user-2", bucket: "interrupt", createdAt: new Date() });
      rings.push({ userId: "user-2", bucket: "ambient", createdAt: new Date() });
    }

    expect((await push("email_urgent", INTERRUPT)).reason).toBe("missing_vapid_keys");
    expect((await push("daily_briefing")).reason).toBe("missing_vapid_keys");
  });

  it("fails open: a limiter DB error lets the push through", async () => {
    ringStore.countError = new Error("connection refused");

    const urgent = await push("email_urgent", INTERRUPT);
    const briefing = await push("daily_briefing");

    expect(urgent.reason).toBe("missing_vapid_keys");
    expect(briefing.reason).toBe("missing_vapid_keys");
    expect(rateLimitSkipReasons()).toEqual([]);
  });
});

// The bucket is the caller's, not the category's (#1636 review). The category
// still drives preferences, quiet hours and the label; only the ring changes.
describe("sendPushNotification — the caller picks the bucket", () => {
  it("an agent email_urgent push rings ambient and is refused at the ambient cap", async () => {
    await pushTimes("daily_briefing", 3);

    const agentUrgent = await push("email_urgent", { bucket: "ambient" });

    expect(agentUrgent.reason).toBe("rate_limited");
    expect(rateLimitSkipReasons()).toEqual(["rate_limited_ambient:10min cap 3/3"]);
    expect(createSkippedPushDelivery).toHaveBeenLastCalledWith(
      expect.objectContaining({ category: "email_urgent" }),
    );
  });

  it("agent email_urgent and meeting pushes never use up the interrupt bucket", async () => {
    // Six agent pushes in the two interrupt-looking categories: three ring,
    // three hit the ambient cap. The interrupt bucket is untouched.
    await pushTimes("email_urgent", 3, { bucket: "ambient" });
    await pushTimes("meeting", 3, { bucket: "ambient" });

    const firewallPush = await push("email_urgent", INTERRUPT);

    expect(firewallPush.reason).toBe("missing_vapid_keys");
    expect(rings.filter((r) => r.bucket === "interrupt")).toHaveLength(1);
  });

  it("a push that does not ask for a bucket rings ambient, whatever its category", async () => {
    await push("email_urgent");
    await push("meeting");

    expect(rings.map((r) => r.bucket)).toEqual(["ambient", "ambient"]);
  });

  it("a reminder (category system) asks for interrupt and rings past a full ambient bucket", async () => {
    await pushTimes("daily_briefing", 3);
    await pushTimes("agent_proposal", 3);

    const reminder = await push("system", INTERRUPT);

    expect(reminder.reason).toBe("missing_vapid_keys");
    expect(sendTelegramForPush).toHaveBeenLastCalledWith(
      USER,
      expect.objectContaining({ title: "T" }),
      "system",
    );
    expect(rings.at(-1)?.bucket).toBe("interrupt");
  });
});
