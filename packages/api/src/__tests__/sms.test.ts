import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Shared test state ──────────────────────────────────────────────────
interface UserRow {
  role: string;
  email: string | null;
}

const users = new Map<string, UserRow>();
const phones = new Map<string, string | null>();
const quietUsers = new Set<string>();
const createCalls: Array<{ from: string; to: string; body: string }> = [];
let twilioError: Error | null = null;

vi.mock("../db.js", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async (args: unknown) => {
        const a = args as { where: { id: string } };
        return users.get(a.where.id) ?? null;
      }),
    },
  },
}));

vi.mock("../sms-phone.js", () => ({
  getPhoneNumber: vi.fn(async (userId: string) => phones.get(userId) ?? null),
}));

vi.mock("../notification-prefs.js", () => ({
  isUserInQuietHours: vi.fn(async (userId: string) => quietUsers.has(userId)),
}));

vi.mock("twilio", () => {
  const create = vi.fn(async (msg: { from: string; to: string; body: string }) => {
    if (twilioError) throw twilioError;
    createCalls.push({ ...msg });
    return { sid: "SM_test_" + createCalls.length };
  });
  const factory = vi.fn(() => ({ messages: { create } }));
  return { default: factory };
});

const ENV_KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM_NUMBER",
  "ADMIN_EMAILS",
  "SMS_DAILY_CAP_PER_USER",
] as const;

const originalEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  process.env.TWILIO_ACCOUNT_SID = "AC_test";
  process.env.TWILIO_AUTH_TOKEN = "token";
  process.env.TWILIO_FROM_NUMBER = "+15555550000";
  process.env.ADMIN_EMAILS = "admin@klorn.ai";
  process.env.SMS_DAILY_CAP_PER_USER = "10";

  users.clear();
  phones.clear();
  quietUsers.clear();
  createCalls.length = 0;
  twilioError = null;

  vi.resetModules();
  const limiter = await import("../sms-limiter.js");
  limiter._resetAllSmsWindowsForTests();
  const sms = await import("../sms.js");
  sms._resetSmsClientForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe("sendSms — admin gate", () => {
  it("skips non-admin users with reason=not_admin", async () => {
    users.set("u-normal", { role: "USER", email: "normal@example.com" });
    phones.set("u-normal", "+821012345678");
    const { sendSms } = await import("../sms.js");
    const result = await sendSms("u-normal", "hello");
    expect(result).toEqual({ sent: false, reason: "not_admin" });
    expect(createCalls).toHaveLength(0);
  });

  it("allows users in ADMIN_EMAILS even without role=ADMIN", async () => {
    users.set("u-env-admin", { role: "USER", email: "admin@klorn.ai" });
    phones.set("u-env-admin", "+821012345678");
    const { sendSms } = await import("../sms.js");
    const result = await sendSms("u-env-admin", "hello");
    expect(result).toEqual({ sent: true });
    expect(createCalls).toHaveLength(1);
  });

  it("allows users with role=ADMIN regardless of email", async () => {
    users.set("u-role-admin", { role: "ADMIN", email: "founder@elsewhere.com" });
    phones.set("u-role-admin", "+821012345678");
    const { sendSms } = await import("../sms.js");
    const result = await sendSms("u-role-admin", "hello");
    expect(result.sent).toBe(true);
  });

  it("returns not_admin when the user row is missing", async () => {
    const { sendSms } = await import("../sms.js");
    const result = await sendSms("ghost", "hello");
    expect(result).toEqual({ sent: false, reason: "not_admin" });
  });
});

describe("sendSms — phone gate", () => {
  it("returns no_phone when the user has no stored number", async () => {
    users.set("u1", { role: "ADMIN", email: "admin@klorn.ai" });
    const { sendSms } = await import("../sms.js");
    const result = await sendSms("u1", "hello");
    expect(result).toEqual({ sent: false, reason: "no_phone" });
    expect(createCalls).toHaveLength(0);
  });
});

describe("sendSms — daily cap", () => {
  it("blocks once the cap is reached", async () => {
    process.env.SMS_DAILY_CAP_PER_USER = "2";
    users.set("u1", { role: "ADMIN", email: "admin@klorn.ai" });
    phones.set("u1", "+821012345678");
    vi.resetModules();
    const limiter = await import("../sms-limiter.js");
    limiter._resetAllSmsWindowsForTests();
    const sms = await import("../sms.js");
    sms._resetSmsClientForTests();

    expect((await sms.sendSms("u1", "1")).sent).toBe(true);
    expect((await sms.sendSms("u1", "2")).sent).toBe(true);
    const blocked = await sms.sendSms("u1", "3");
    expect(blocked).toEqual({ sent: false, reason: "rate_limited" });
    expect(createCalls).toHaveLength(2);
  });
});

describe("sendSms — quiet hours", () => {
  it("skips with reason=quiet_hours during the user's quiet window", async () => {
    users.set("u1", { role: "ADMIN", email: "admin@klorn.ai" });
    phones.set("u1", "+821012345678");
    quietUsers.add("u1");
    const { sendSms } = await import("../sms.js");
    const result = await sendSms("u1", "Urgent: 2am newsletter");
    expect(result).toEqual({ sent: false, reason: "quiet_hours" });
    expect(createCalls).toHaveLength(0);
  });

  it("a quiet-hours skip does not burn the daily cap", async () => {
    process.env.SMS_DAILY_CAP_PER_USER = "1";
    users.set("u1", { role: "ADMIN", email: "admin@klorn.ai" });
    phones.set("u1", "+821012345678");
    vi.resetModules();
    const limiter = await import("../sms-limiter.js");
    limiter._resetAllSmsWindowsForTests();
    const sms = await import("../sms.js");
    sms._resetSmsClientForTests();

    quietUsers.add("u1");
    expect((await sms.sendSms("u1", "blocked")).reason).toBe("quiet_hours");
    quietUsers.delete("u1");
    // Cap is 1 — if the quiet skip had burned it, this send would be blocked.
    expect((await sms.sendSms("u1", "allowed")).sent).toBe(true);
  });
});

describe("sendSms — twilio behavior", () => {
  it("returns twilio_not_configured when env vars are missing", async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    users.set("u1", { role: "ADMIN", email: "admin@klorn.ai" });
    phones.set("u1", "+821012345678");
    vi.resetModules();
    const limiter = await import("../sms-limiter.js");
    limiter._resetAllSmsWindowsForTests();
    const sms = await import("../sms.js");
    sms._resetSmsClientForTests();

    const result = await sms.sendSms("u1", "hello");
    expect(result).toEqual({ sent: false, reason: "twilio_not_configured" });
    expect(createCalls).toHaveLength(0);
  });

  it("returns twilio_error on Twilio API failure (no throw)", async () => {
    users.set("u1", { role: "ADMIN", email: "admin@klorn.ai" });
    phones.set("u1", "+821012345678");
    twilioError = new Error("invalid To number");
    const { sendSms } = await import("../sms.js");
    const result = await sendSms("u1", "hello");
    expect(result).toEqual({ sent: false, reason: "twilio_error" });
  });

  it("rejects empty bodies before touching admin/phone/twilio", async () => {
    const { sendSms } = await import("../sms.js");
    expect(await sendSms("u1", "")).toEqual({ sent: false, reason: "empty_body" });
    expect(await sendSms("u1", "   ")).toEqual({ sent: false, reason: "empty_body" });
  });

  it("truncates bodies longer than 320 chars to ≤320 with an ellipsis", async () => {
    users.set("u1", { role: "ADMIN", email: "admin@klorn.ai" });
    phones.set("u1", "+821012345678");
    const longBody = "x".repeat(500);
    const { sendSms } = await import("../sms.js");
    const result = await sendSms("u1", longBody);
    expect(result.sent).toBe(true);
    expect(createCalls[0]?.body.length).toBeLessThanOrEqual(320);
    expect(createCalls[0]?.body.endsWith("…")).toBe(true);
  });

  it("passes through bodies at or under the 320 char limit unchanged", async () => {
    users.set("u1", { role: "ADMIN", email: "admin@klorn.ai" });
    phones.set("u1", "+821012345678");
    const body = "Urgent: subject — from somebody";
    const { sendSms } = await import("../sms.js");
    await sendSms("u1", body);
    expect(createCalls[0]?.body).toBe(body);
    expect(createCalls[0]?.to).toBe("+821012345678");
    expect(createCalls[0]?.from).toBe("+15555550000");
  });
});
