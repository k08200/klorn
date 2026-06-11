import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Shared test state ──────────────────────────────────────────────────
interface EscalationRow {
  id: string;
  userId: string;
  notificationId: string;
  gatherToken: string;
  title: string;
  status: string;
  twilioCallSid: string | null;
  acknowledgedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface PushLogRow {
  id: string;
  userId: string;
  notificationId: string | null;
  category: string;
  title: string;
  status: string;
  receivedAt: Date | null;
  clickedAt: Date | null;
  createdAt: Date;
}

interface NotificationRow {
  id: string;
  title: string;
  isRead: boolean;
}

const escalations: EscalationRow[] = [];
const pushLogs: PushLogRow[] = [];
const notifications = new Map<string, NotificationRow>();
const automationConfigs = new Map<string, Record<string, unknown>>();
const phones = new Map<string, string | null>();
const callCreates: Array<Record<string, unknown>> = [];
let twilioCallError: Error | null = null;
let escalationSeq = 0;

function seedEscalation(overrides: Partial<EscalationRow> & { notificationId: string }) {
  escalationSeq += 1;
  escalations.push({
    id: `esc-${escalationSeq}`,
    userId: "u1",
    gatherToken: `tok-${escalationSeq}`,
    title: "seeded",
    status: "PLACED",
    twilioCallSid: null,
    acknowledgedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
}

vi.mock("../db.js", () => ({
  prisma: {
    automationConfig: {
      findUnique: vi.fn(async (args: unknown) => {
        const a = args as { where: { userId: string } };
        return automationConfigs.get(a.where.userId) ?? null;
      }),
    },
    phoneEscalation: {
      findUnique: vi.fn(async (args: unknown) => {
        const a = args as { where: { notificationId?: string; id?: string } };
        if (a.where.notificationId) {
          return escalations.find((e) => e.notificationId === a.where.notificationId) ?? null;
        }
        return escalations.find((e) => e.id === a.where.id) ?? null;
      }),
      findFirst: vi.fn(async (args: unknown) => {
        const a = args as { where: { userId: string; createdAt?: { gte?: Date } } };
        const gte = a.where.createdAt?.gte;
        return (
          escalations.find((e) => e.userId === a.where.userId && (!gte || e.createdAt >= gte)) ??
          null
        );
      }),
      count: vi.fn(async (args: unknown) => {
        const a = args as { where: { userId: string; createdAt: { gte: Date } } };
        return escalations.filter(
          (e) => e.userId === a.where.userId && e.createdAt >= a.where.createdAt.gte,
        ).length;
      }),
      create: vi.fn(async (args: unknown) => {
        const a = args as {
          data: { userId: string; notificationId: string; gatherToken: string; title: string };
        };
        if (escalations.some((e) => e.notificationId === a.data.notificationId)) {
          throw new Error("Unique constraint failed on the fields: (`notificationId`)");
        }
        escalationSeq += 1;
        const row: EscalationRow = {
          id: `esc-${escalationSeq}`,
          status: "PLACED",
          twilioCallSid: null,
          acknowledgedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...a.data,
        };
        escalations.push(row);
        return row;
      }),
      update: vi.fn(async (args: unknown) => {
        const a = args as { where: { id: string }; data: Partial<EscalationRow> };
        const row = escalations.find((e) => e.id === a.where.id);
        if (!row) throw new Error("Record not found");
        Object.assign(row, a.data);
        return row;
      }),
    },
    pushDeliveryLog: {
      findMany: vi.fn(async (args: unknown) => {
        const a = args as {
          where: {
            userId: string;
            status?: string;
            receivedAt?: null;
            clickedAt?: null;
            notificationId?: { not?: null; in?: string[] };
            category?: { in: string[] };
            createdAt?: { lt?: Date; gte?: Date };
            OR?: Array<Record<string, unknown>>;
          };
        };
        // Receipt lookup: { notificationId: { in }, OR: [received, clicked] }
        if (a.where.OR) {
          const ids = a.where.notificationId?.in ?? [];
          return pushLogs.filter(
            (log) =>
              log.userId === a.where.userId &&
              log.notificationId !== null &&
              ids.includes(log.notificationId) &&
              (log.receivedAt !== null || log.clickedAt !== null),
          );
        }
        // Candidate sweep
        return pushLogs.filter((log) => {
          if (log.userId !== a.where.userId) return false;
          if (a.where.status && log.status !== a.where.status) return false;
          if (a.where.receivedAt === null && log.receivedAt !== null) return false;
          if (a.where.clickedAt === null && log.clickedAt !== null) return false;
          if (a.where.notificationId?.not === null && log.notificationId === null) return false;
          if (a.where.category && !a.where.category.in.includes(log.category)) return false;
          if (a.where.createdAt?.lt && !(log.createdAt < a.where.createdAt.lt)) return false;
          if (a.where.createdAt?.gte && !(log.createdAt >= a.where.createdAt.gte)) return false;
          return true;
        });
      }),
    },
    notification: {
      findMany: vi.fn(async (args: unknown) => {
        const a = args as { where: { id: { in: string[] }; isRead: boolean } };
        return a.where.id.in
          .map((id) => notifications.get(id))
          .filter((n): n is NotificationRow => !!n && n.isRead === a.where.isRead);
      }),
    },
  },
}));

vi.mock("../sms-phone.js", () => ({
  getPhoneNumber: vi.fn(async (userId: string) => phones.get(userId) ?? null),
}));

vi.mock("twilio", () => {
  const create = vi.fn(async (args: Record<string, unknown>) => {
    if (twilioCallError) throw twilioCallError;
    callCreates.push({ ...args });
    return { sid: `CA_test_${callCreates.length}` };
  });
  const factory = vi.fn(() => ({ calls: { create } }));
  return { default: factory };
});

const ENV_KEYS = [
  "PHONE_ESCALATION_ENABLED",
  "PHONE_ESCALATION_DAILY_CAP",
  "PHONE_ESCALATION_TIMEOUT_MINUTES",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM_NUMBER",
  "PUBLIC_URL",
  "RENDER_EXTERNAL_URL",
] as const;

const originalEnv: Record<string, string | undefined> = {};

/** Re-import the module after env changes (mirrors sms.test.ts conventions). */
async function loadModule() {
  vi.resetModules();
  const mod = await import("../phone-escalation.js");
  mod._resetPhoneClientForTests();
  return mod;
}

const MINUTES = 60 * 1000;

function optIn(userId: string, extra: Record<string, unknown> = {}) {
  automationConfigs.set(userId, {
    userId,
    phoneEscalationEnabled: true,
    timezone: "UTC",
    quietHoursStart: null,
    quietHoursEnd: null,
    ...extra,
  });
}

beforeEach(() => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  process.env.PHONE_ESCALATION_ENABLED = "true";
  process.env.TWILIO_ACCOUNT_SID = "AC_test";
  process.env.TWILIO_AUTH_TOKEN = "token";
  process.env.TWILIO_FROM_NUMBER = "+15555550000";
  process.env.PUBLIC_URL = "https://api.example.com";
  delete process.env.PHONE_ESCALATION_DAILY_CAP;
  delete process.env.PHONE_ESCALATION_TIMEOUT_MINUTES;
  delete process.env.RENDER_EXTERNAL_URL;

  escalations.length = 0;
  pushLogs.length = 0;
  notifications.clear();
  automationConfigs.clear();
  phones.clear();
  callCreates.length = 0;
  twilioCallError = null;
  escalationSeq = 0;

  optIn("u1");
  phones.set("u1", "+821012345678");
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe("placeEscalationCall — feature gates", () => {
  it("no-ops when PHONE_ESCALATION_ENABLED is not true", async () => {
    delete process.env.PHONE_ESCALATION_ENABLED;
    const { placeEscalationCall } = await loadModule();
    const result = await placeEscalationCall("u1", { notificationId: "n1", title: "T" });
    expect(result).toEqual({ placed: false, reason: "feature_disabled" });
    expect(callCreates).toHaveLength(0);
    expect(escalations).toHaveLength(0);
  });

  it("skips when Twilio env vars are missing", async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    const { placeEscalationCall } = await loadModule();
    const result = await placeEscalationCall("u1", { notificationId: "n1", title: "T" });
    expect(result).toEqual({ placed: false, reason: "twilio_not_configured" });
    expect(callCreates).toHaveLength(0);
  });

  it("skips when no public URL is configured", async () => {
    delete process.env.PUBLIC_URL;
    const { placeEscalationCall } = await loadModule();
    const result = await placeEscalationCall("u1", { notificationId: "n1", title: "T" });
    expect(result).toEqual({ placed: false, reason: "no_public_url" });
    expect(callCreates).toHaveLength(0);
  });

  it("skips users who have not opted in via AutomationConfig", async () => {
    automationConfigs.set("u1", { userId: "u1", phoneEscalationEnabled: false });
    const { placeEscalationCall } = await loadModule();
    const result = await placeEscalationCall("u1", { notificationId: "n1", title: "T" });
    expect(result).toEqual({ placed: false, reason: "not_opted_in" });
  });

  it("skips users with no AutomationConfig row at all", async () => {
    automationConfigs.delete("u1");
    const { placeEscalationCall } = await loadModule();
    const result = await placeEscalationCall("u1", { notificationId: "n1", title: "T" });
    expect(result).toEqual({ placed: false, reason: "not_opted_in" });
  });

  it("skips users without a stored phone number", async () => {
    phones.delete("u1");
    const { placeEscalationCall } = await loadModule();
    const result = await placeEscalationCall("u1", { notificationId: "n1", title: "T" });
    expect(result).toEqual({ placed: false, reason: "no_phone" });
  });
});

describe("placeEscalationCall — quiet hours always win", () => {
  it("suppresses calls inside the quiet window", async () => {
    optIn("u1", { quietHoursStart: "22:00", quietHoursEnd: "08:00", timezone: "UTC" });
    const { placeEscalationCall } = await loadModule();
    const insideWindow = new Date("2026-06-12T23:30:00Z");
    const result = await placeEscalationCall(
      "u1",
      { notificationId: "n1", title: "T" },
      insideWindow,
    );
    expect(result).toEqual({ placed: false, reason: "quiet_hours" });
    expect(callCreates).toHaveLength(0);
    expect(escalations).toHaveLength(0);
  });

  it("places the call outside the quiet window", async () => {
    optIn("u1", { quietHoursStart: "22:00", quietHoursEnd: "08:00", timezone: "UTC" });
    const { placeEscalationCall } = await loadModule();
    const outsideWindow = new Date("2026-06-12T12:00:00Z");
    const result = await placeEscalationCall(
      "u1",
      { notificationId: "n1", title: "T" },
      outsideWindow,
    );
    expect(result).toEqual({ placed: true });
    expect(callCreates).toHaveLength(1);
  });
});

describe("placeEscalationCall — hard caps", () => {
  it("never calls twice for the same notification", async () => {
    seedEscalation({
      notificationId: "n1",
      createdAt: new Date(Date.now() - 120 * MINUTES),
    });
    const { placeEscalationCall } = await loadModule();
    const result = await placeEscalationCall("u1", { notificationId: "n1", title: "T" });
    expect(result).toEqual({ placed: false, reason: "already_escalated" });
    expect(callCreates).toHaveLength(0);
  });

  it("enforces the default daily cap of 3 calls per user", async () => {
    for (let i = 0; i < 3; i++) {
      seedEscalation({
        notificationId: `prior-${i}`,
        createdAt: new Date(Date.now() - 20 * MINUTES),
      });
    }
    const { placeEscalationCall } = await loadModule();
    const result = await placeEscalationCall("u1", { notificationId: "n-new", title: "T" });
    expect(result).toEqual({ placed: false, reason: "daily_cap_reached" });
    expect(callCreates).toHaveLength(0);
  });

  it("honors PHONE_ESCALATION_DAILY_CAP overrides", async () => {
    process.env.PHONE_ESCALATION_DAILY_CAP = "5";
    for (let i = 0; i < 3; i++) {
      seedEscalation({
        notificationId: `prior-${i}`,
        createdAt: new Date(Date.now() - 20 * MINUTES),
      });
    }
    const { placeEscalationCall } = await loadModule();
    const result = await placeEscalationCall("u1", { notificationId: "n-new", title: "T" });
    expect(result).toEqual({ placed: true });
  });

  it("enforces the 10-minute per-user cooldown", async () => {
    seedEscalation({
      notificationId: "recent",
      createdAt: new Date(Date.now() - 5 * MINUTES),
    });
    const { placeEscalationCall } = await loadModule();
    const result = await placeEscalationCall("u1", { notificationId: "n-new", title: "T" });
    expect(result).toEqual({ placed: false, reason: "cooldown_active" });
    expect(callCreates).toHaveLength(0);
  });

  it("allows a call once the cooldown has elapsed", async () => {
    seedEscalation({
      notificationId: "older",
      createdAt: new Date(Date.now() - 11 * MINUTES),
    });
    const { placeEscalationCall } = await loadModule();
    const result = await placeEscalationCall("u1", { notificationId: "n-new", title: "T" });
    expect(result).toEqual({ placed: true });
  });
});

describe("placeEscalationCall — TwiML safety", () => {
  it("escapes XML and strips URLs from hostile email titles", async () => {
    const hostile = `Ignore previous <Hangup/><Dial>+15558675309</Dial> & visit https://evil.example/p?a=1&b=2 now`;
    const { placeEscalationCall } = await loadModule();
    const result = await placeEscalationCall("u1", { notificationId: "n1", title: hostile });
    expect(result).toEqual({ placed: true });
    const twiml = String(callCreates[0]?.twiml);
    expect(twiml).not.toContain("<Hangup");
    expect(twiml).not.toContain("<Dial");
    expect(twiml).not.toContain("evil.example");
    expect(twiml).not.toContain("https://evil");
    // No raw ampersands outside entities
    expect(twiml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;|#)/);
  });

  it("truncates absurdly long titles before speaking them", async () => {
    const { placeEscalationCall } = await loadModule();
    await placeEscalationCall("u1", { notificationId: "n1", title: "x".repeat(2000) });
    const twiml = String(callCreates[0]?.twiml);
    expect(twiml.length).toBeLessThan(1000);
  });

  it("falls back to a generic phrase when sanitization empties the title", async () => {
    const { placeEscalationCall } = await loadModule();
    const result = await placeEscalationCall("u1", {
      notificationId: "n1",
      title: "<<<>>>///",
    });
    expect(result).toEqual({ placed: true });
    const twiml = String(callCreates[0]?.twiml);
    expect(twiml).toContain("an item that needs your attention");
  });
});

describe("placeEscalationCall — happy path + failure", () => {
  it("places one call with gather action pointing at PUBLIC_URL", async () => {
    const { placeEscalationCall } = await loadModule();
    const result = await placeEscalationCall("u1", {
      notificationId: "n1",
      title: "Server is down",
    });
    expect(result).toEqual({ placed: true });
    expect(callCreates).toHaveLength(1);
    expect(callCreates[0]?.to).toBe("+821012345678");
    expect(callCreates[0]?.from).toBe("+15555550000");
    const twiml = String(callCreates[0]?.twiml);
    expect(twiml).toContain("Klorn here. You have an urgent item: Server is down.");
    expect(twiml).toContain("Press 1 to hear it again, press 2 to acknowledge.");
    expect(twiml).toContain("https://api.example.com/api/phone/gather?token=");
    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.status).toBe("PLACED");
    expect(escalations[0]?.twilioCallSid).toBe("CA_test_1");
  });

  it("marks the row FAILED and never throws when Twilio errors", async () => {
    twilioCallError = new Error("twilio is down");
    const { placeEscalationCall } = await loadModule();
    const result = await placeEscalationCall("u1", { notificationId: "n1", title: "T" });
    expect(result).toEqual({ placed: false, reason: "twilio_error" });
    expect(escalations[0]?.status).toBe("FAILED");
  });
});

describe("escalateUnackedPush — candidate selection", () => {
  function seedPushLog(overrides: Partial<PushLogRow> & { id: string }) {
    pushLogs.push({
      userId: "u1",
      notificationId: null,
      category: "email_urgent",
      title: "Urgent mail",
      status: "ACCEPTED",
      receivedAt: null,
      clickedAt: null,
      createdAt: new Date(Date.now() - 10 * MINUTES),
      ...overrides,
    });
  }

  it("no-ops when the feature flag is off", async () => {
    delete process.env.PHONE_ESCALATION_ENABLED;
    seedPushLog({ id: "p1", notificationId: "n1" });
    notifications.set("n1", { id: "n1", title: "Urgent mail", isRead: false });
    const { escalateUnackedPush } = await loadModule();
    const result = await escalateUnackedPush("u1");
    expect(result).toEqual({ candidates: 0, placed: 0 });
    expect(callCreates).toHaveLength(0);
  });

  it("escalates an ACCEPTED push with no receipt after the timeout", async () => {
    seedPushLog({ id: "p1", notificationId: "n1" });
    notifications.set("n1", { id: "n1", title: "Urgent mail from boss", isRead: false });
    const { escalateUnackedPush } = await loadModule();
    const result = await escalateUnackedPush("u1");
    expect(result).toEqual({ candidates: 1, placed: 1 });
    expect(callCreates).toHaveLength(1);
    expect(String(callCreates[0]?.twiml)).toContain("Urgent mail from boss");
  });

  it("ignores pushes younger than the escalation timeout", async () => {
    seedPushLog({ id: "p1", notificationId: "n1", createdAt: new Date(Date.now() - 2 * MINUTES) });
    notifications.set("n1", { id: "n1", title: "Too fresh", isRead: false });
    const { escalateUnackedPush } = await loadModule();
    const result = await escalateUnackedPush("u1");
    expect(result).toEqual({ candidates: 0, placed: 0 });
  });

  it("ignores pushes that were received or clicked", async () => {
    seedPushLog({ id: "p1", notificationId: "n1", receivedAt: new Date() });
    seedPushLog({ id: "p2", notificationId: "n2", clickedAt: new Date() });
    notifications.set("n1", { id: "n1", title: "Seen", isRead: false });
    notifications.set("n2", { id: "n2", title: "Clicked", isRead: false });
    const { escalateUnackedPush } = await loadModule();
    const result = await escalateUnackedPush("u1");
    expect(result).toEqual({ candidates: 0, placed: 0 });
  });

  it("skips a notification acknowledged on ANOTHER device's delivery row", async () => {
    seedPushLog({ id: "p1", notificationId: "n1" });
    seedPushLog({ id: "p2", notificationId: "n1", receivedAt: new Date() });
    notifications.set("n1", { id: "n1", title: "Seen elsewhere", isRead: false });
    const { escalateUnackedPush } = await loadModule();
    const result = await escalateUnackedPush("u1");
    expect(result.placed).toBe(0);
    expect(callCreates).toHaveLength(0);
  });

  it("ignores non-PUSH-tier categories", async () => {
    seedPushLog({ id: "p1", notificationId: "n1", category: "daily_briefing" });
    notifications.set("n1", { id: "n1", title: "Briefing", isRead: false });
    const { escalateUnackedPush } = await loadModule();
    const result = await escalateUnackedPush("u1");
    expect(result).toEqual({ candidates: 0, placed: 0 });
  });

  it("ignores notifications already read in the bell UI", async () => {
    seedPushLog({ id: "p1", notificationId: "n1" });
    notifications.set("n1", { id: "n1", title: "Read in app", isRead: true });
    const { escalateUnackedPush } = await loadModule();
    const result = await escalateUnackedPush("u1");
    expect(result).toEqual({ candidates: 0, placed: 0 });
  });

  it("skips notifications that already have a PhoneEscalation row", async () => {
    seedPushLog({ id: "p1", notificationId: "n1" });
    notifications.set("n1", { id: "n1", title: "Already dialed", isRead: false });
    seedEscalation({
      notificationId: "n1",
      createdAt: new Date(Date.now() - 120 * MINUTES),
    });
    const { escalateUnackedPush } = await loadModule();
    const result = await escalateUnackedPush("u1");
    expect(result.placed).toBe(0);
    expect(callCreates).toHaveLength(0);
  });

  it("places at most ONE call per sweep even with multiple candidates", async () => {
    seedPushLog({ id: "p1", notificationId: "n1", createdAt: new Date(Date.now() - 30 * MINUTES) });
    seedPushLog({ id: "p2", notificationId: "n2", createdAt: new Date(Date.now() - 20 * MINUTES) });
    notifications.set("n1", { id: "n1", title: "First", isRead: false });
    notifications.set("n2", { id: "n2", title: "Second", isRead: false });
    const { escalateUnackedPush } = await loadModule();
    const result = await escalateUnackedPush("u1");
    expect(result.placed).toBe(1);
    expect(callCreates).toHaveLength(1);
  });

  it("never places calls during quiet hours", async () => {
    optIn("u1", { quietHoursStart: "00:00", quietHoursEnd: "23:59", timezone: "UTC" });
    seedPushLog({ id: "p1", notificationId: "n1" });
    notifications.set("n1", { id: "n1", title: "Night owl", isRead: false });
    const { escalateUnackedPush } = await loadModule();
    const result = await escalateUnackedPush("u1");
    expect(result.placed).toBe(0);
    expect(callCreates).toHaveLength(0);
  });
});

describe("sanitizeTitleForSpeech / escapeXml units", () => {
  it("strips URL-like tokens entirely", async () => {
    const { sanitizeTitleForSpeech } = await loadModule();
    expect(sanitizeTitleForSpeech("check www.evil.com and http://a.b/c now")).toBe("check and now");
  });

  it("escapes all five XML entities", async () => {
    const { escapeXml } = await loadModule();
    expect(escapeXml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&apos;");
  });
});
