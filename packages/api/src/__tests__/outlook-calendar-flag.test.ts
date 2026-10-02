/**
 * C4: OUTLOOK_CALENDAR_ENABLED. OFF by default, read at request time, and it
 * also needs the Outlook inbox flag, exactly as the Outlook mail path does. While
 * either is off the dispatcher answers the same explicit unsupported result it
 * answered before C4, so no Graph call, no token read and no row can follow.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("googleapis", () => ({ google: { calendar: vi.fn(() => ({})) } }));
vi.mock("../mail/gmail.js", () => ({
  getAuthedClient: vi.fn(),
  buildLinkedCalendarClient: vi.fn(),
  markLinkedCalendarForReconnect: vi.fn(async () => {}),
}));
vi.mock("../db.js", () => {
  const prisma = { linkedCalendarAccount: { findMany: vi.fn(), updateMany: vi.fn() } };
  return { prisma, db: prisma };
});
vi.mock("../crypto-tokens.js", () => ({
  decryptToken: (t: string) => t.replace(/^enc:/, ""),
  decryptOptional: (t: string | null | undefined) => (t ? t.replace(/^enc:/, "") : null),
  encryptToken: (t: string) => `enc:${t}`,
  encryptOptional: (t: string | null | undefined) => (t ? `enc:${t}` : null),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { outlookCalendarEnabled } from "../config.js";
import { calendarActionsForProvider } from "../pim/calendar-providers/dispatch.js";
import { outlookCalendarActions } from "../pim/calendar-providers/outlook.js";
import { isCalendarUnsupported } from "../pim/calendar-providers/types.js";

const KEYS = ["OUTLOOK_CALENDAR_ENABLED", "OUTLOOK_INBOX_ENABLED"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function setFlags(calendar: string | undefined, inbox: string | undefined) {
  if (calendar === undefined) delete process.env.OUTLOOK_CALENDAR_ENABLED;
  else process.env.OUTLOOK_CALENDAR_ENABLED = calendar;
  if (inbox === undefined) delete process.env.OUTLOOK_INBOX_ENABLED;
  else process.env.OUTLOOK_INBOX_ENABLED = inbox;
}

describe("outlookCalendarEnabled (OUTLOOK_CALENDAR_ENABLED + OUTLOOK_INBOX_ENABLED)", () => {
  it("is OFF when both are unset or empty", () => {
    expect(outlookCalendarEnabled()).toBe(false);
    setFlags("", "");
    expect(outlookCalendarEnabled()).toBe(false);
    setFlags("   ", "   ");
    expect(outlookCalendarEnabled()).toBe(false);
  });

  it("is OFF with only the calendar flag on: the inbox flag is required too", () => {
    setFlags("true", undefined);
    expect(outlookCalendarEnabled()).toBe(false);
    setFlags("true", "false");
    expect(outlookCalendarEnabled()).toBe(false);
  });

  it("is OFF with only the inbox flag on: the calendar flag is its own decision", () => {
    setFlags(undefined, "true");
    expect(outlookCalendarEnabled()).toBe(false);
    setFlags("false", "true");
    expect(outlookCalendarEnabled()).toBe(false);
  });

  it.each([
    "true",
    "TRUE",
    " True ",
    "1",
    "yes",
    "on",
  ])("is ON for %j with both set (lenient parse)", (v) => {
    setFlags(v, "true");
    expect(outlookCalendarEnabled()).toBe(true);
  });

  it.each(["false", "0", "no", "off", "2", "enabled", "truee"])("reads %j as off", (v) => {
    setFlags(v, "true");
    expect(outlookCalendarEnabled()).toBe(false);
  });

  it("is read on every call, so a flip needs no restart", () => {
    setFlags("true", "true");
    expect(outlookCalendarEnabled()).toBe(true);
    setFlags("false", "true");
    expect(outlookCalendarEnabled()).toBe(false);
  });
});

describe("calendarActionsForProvider('OUTLOOK')", () => {
  const linked = {
    id: "acct-out",
    userId: "u1",
    provider: "OUTLOOK",
    email: "me@contoso.com",
    accessToken: "enc:at",
    refreshToken: "enc:rt",
    expiresAt: new Date(Date.now() + 3_600_000),
    needsReconnect: false,
  };

  async function connect() {
    return calendarActionsForProvider("OUTLOOK").connect({
      userId: "u1",
      linkedAccountId: "acct-out",
      linked: linked as never,
    });
  }

  it.each([
    ["both off", undefined, undefined],
    ["calendar on, inbox off", "true", undefined],
    ["inbox on, calendar off", undefined, "true"],
  ])("answers the explicit unsupported result when %s", async (_label, calendar, inbox) => {
    setFlags(calendar, inbox);

    const actions = calendarActionsForProvider("OUTLOOK");
    const result = await connect();

    expect(actions).not.toBe(outlookCalendarActions);
    expect(result).not.toBeNull();
    expect(isCalendarUnsupported(result)).toBe(true);
  });

  it("serves the Graph implementation once both flags are on, and reverts when one is turned off", async () => {
    setFlags("true", "true");
    expect(calendarActionsForProvider("OUTLOOK")).toBe(outlookCalendarActions);
    expect(outlookCalendarActions.provider).toBe("OUTLOOK");
    const session = await connect();
    expect(session).not.toBeNull();
    expect(isCalendarUnsupported(session)).toBe(false);

    setFlags("true", "false");
    expect(isCalendarUnsupported(await connect())).toBe(true);
  });

  it("leaves every other provider as it was, whatever the flags say", () => {
    setFlags("true", "true");
    for (const provider of ["ICLOUD", "NAVER", "DEVICE", "LOCAL"] as const) {
      expect(calendarActionsForProvider(provider)).not.toBe(outlookCalendarActions);
    }
  });
});
