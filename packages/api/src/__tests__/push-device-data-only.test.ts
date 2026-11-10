/**
 * sendDevicePush's data-only gate: a MAIL push goes out data-only only to an
 * Android token registered with `dataMessages: true`, and only while
 * ANDROID_DATA_PUSH_ENABLED is on. Every other row, and every push while the
 * flag is off, is the notification message it always was.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const sendEach = vi.hoisted(() =>
  vi.fn(async (messages: unknown[]) => ({
    successCount: messages.length,
    failureCount: 0,
    responses: messages.map(() => ({ success: true })),
  })),
);
const findMany = vi.hoisted(() =>
  vi.fn(async () => [
    { token: "tok-new", dataMessages: true },
    { token: "tok-old", dataMessages: false },
  ]),
);

vi.mock("firebase-admin/app", () => ({
  cert: vi.fn(() => ({})),
  getApps: vi.fn(() => []),
  initializeApp: vi.fn(() => ({ name: "test" })),
}));
vi.mock("firebase-admin/messaging", () => ({ getMessaging: vi.fn(() => ({ sendEach })) }));
vi.mock("../db.js", () => ({
  prisma: { devicePushToken: { findMany, deleteMany: vi.fn(async () => ({ count: 0 })) } },
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

let sendDevicePush: typeof import("../notify/push-device.js").sendDevicePush;

beforeAll(async () => {
  // Read once at module load, like production.
  process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ project_id: "test" });
  ({ sendDevicePush } = await import("../notify/push-device.js"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  sendEach.mockClear();
});

const MAIL = { title: "Klorn — Alice", body: "Q3 budget", url: "/inbox/firewall", emailId: "e1" };

function sent(): Array<{ token: string; notification?: unknown; data: Record<string, string> }> {
  return sendEach.mock.calls[0]?.[0] as never;
}

describe("sendDevicePush data-only gate", () => {
  it("flag off: every device gets a notification message", async () => {
    vi.stubEnv("ANDROID_DATA_PUSH_ENABLED", "");
    await sendDevicePush("u1", MAIL, "email_urgent");
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: "u1", platform: "android" },
      select: { token: true, dataMessages: true },
    });
    for (const m of sent()) expect(m.notification).toBeDefined();
  });

  it("flag on: only the device that opted in gets data-only", async () => {
    vi.stubEnv("ANDROID_DATA_PUSH_ENABLED", "true");
    await sendDevicePush("u1", MAIL, "email_urgent");
    const [fresh, old] = sent();
    expect(fresh?.token).toBe("tok-new");
    expect(fresh?.notification).toBeUndefined();
    expect(fresh?.data.title).toBe("Klorn — Alice");
    expect(fresh?.data.body).toBe("Q3 budget");
    expect(Number(fresh?.data.sentAt)).toBeGreaterThan(0);
    expect(old?.token).toBe("tok-old");
    expect(old?.notification).toEqual({ title: "Klorn — Alice", body: "Q3 budget" });
  });

  it("flag on: a push that is not about one mail stays a notification message", async () => {
    vi.stubEnv("ANDROID_DATA_PUSH_ENABLED", "true");
    await sendDevicePush("u1", { title: "Briefing", body: "Your morning", url: "/briefing" });
    for (const m of sent()) expect(m.notification).toBeDefined();
  });
});
