/**
 * C2 kill switch: while LINKED_CALENDAR_SYNC_ENABLED is off, every reader
 * excludes linked rows (sourceAccountId NULL only), so turning the flag off
 * hides rows already synced immediately instead of leaving them on screen.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  anyLinkedRowVisible,
  CALENDAR_PROVIDER_ENABLED,
  calendarSourceScope,
  isCalendarRowVisible,
  type ProviderEnabledMap,
} from "../pim/calendar-scope.js";

const KEY = "LINKED_CALENDAR_SYNC_ENABLED";
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
});

// The linked-sync flag on its own: an empty registry, so no connector's flag is in play.
describe("calendarSourceScope", () => {
  it("limits a where clause to primary and LOCAL rows while the flag is off", () => {
    delete process.env[KEY];
    expect(calendarSourceScope({})).toEqual({ sourceAccountId: null });
    process.env[KEY] = "false";
    expect(calendarSourceScope({})).toEqual({ sourceAccountId: null });
  });

  it("adds nothing once the flag is on", () => {
    process.env[KEY] = "true";
    expect(calendarSourceScope({})).toEqual({});
  });

  it("is read at request time: a flip needs no restart", () => {
    process.env[KEY] = "true";
    expect(calendarSourceScope({})).toEqual({});
    process.env[KEY] = "off";
    expect(calendarSourceScope({})).toEqual({ sourceAccountId: null });
  });

  it("returns a fresh object each call so a caller cannot poison the next query", () => {
    delete process.env[KEY];
    const first = calendarSourceScope({}) as { sourceAccountId?: unknown };
    first.sourceAccountId = "x";
    expect(calendarSourceScope({})).toEqual({ sourceAccountId: null });
  });
});

describe("isCalendarRowVisible", () => {
  it("hides a linked row while the flag is off, shows it once on", () => {
    delete process.env[KEY];
    expect(isCalendarRowVisible({ sourceAccountId: "acct-1" }, {})).toBe(false);
    process.env[KEY] = "true";
    expect(isCalendarRowVisible({ sourceAccountId: "acct-1" }, {})).toBe(true);
  });

  it("always shows primary and LOCAL rows, whatever the flag", () => {
    delete process.env[KEY];
    expect(isCalendarRowVisible({ sourceAccountId: null }, {})).toBe(true);
    expect(isCalendarRowVisible({}, {})).toBe(true);
    process.env[KEY] = "true";
    expect(isCalendarRowVisible({ sourceAccountId: null }, {})).toBe(true);
  });
});

// C7: a connector's own flag (OUTLOOK_CALENDAR_ENABLED in C4, and so on) plugs into the
// same kill switch through a map of provider to "is it enabled". GOOGLE keeps the
// linked-sync flag; a provider with no entry has no connector, so no row can exist.
describe("per-provider kill switch", () => {
  let outlookOn = false;
  const providers: ProviderEnabledMap = { OUTLOOK: () => outlookOn };

  afterEach(() => {
    outlookOn = false;
  });

  it("changes nothing while no provider is registered (today's queries, byte for byte)", () => {
    delete process.env[KEY];
    expect(calendarSourceScope({})).toEqual({ sourceAccountId: null });
    process.env[KEY] = "true";
    expect(calendarSourceScope({})).toEqual({});
  });

  it("hides a registered provider's rows while its flag is off, with the linked sync on or off", () => {
    delete process.env[KEY];
    expect(calendarSourceScope(providers)).toEqual({
      sourceAccountId: null,
      provider: { notIn: ["OUTLOOK"] },
    });
    process.env[KEY] = "true";
    expect(calendarSourceScope(providers)).toEqual({ provider: { notIn: ["OUTLOOK"] } });
  });

  it("shows a registered provider's linked rows once its own flag is on, without the Google linked flag", () => {
    delete process.env[KEY];
    outlookOn = true;
    expect(calendarSourceScope(providers)).toEqual({
      OR: [{ sourceAccountId: null }, { provider: { in: ["OUTLOOK"] } }],
    });
  });

  it("adds nothing once both the linked sync and the provider's flag are on", () => {
    process.env[KEY] = "true";
    outlookOn = true;
    expect(calendarSourceScope(providers)).toEqual({});
  });

  it("reads the provider's flag at request time", () => {
    delete process.env[KEY];
    expect(calendarSourceScope(providers)).toHaveProperty("provider");
    outlookOn = true;
    expect(calendarSourceScope(providers)).toHaveProperty("OR");
  });

  it("isCalendarRowVisible follows the provider's flag for a row fetched by id", () => {
    delete process.env[KEY];
    const row = { sourceAccountId: "acct-9", provider: "OUTLOOK" };
    expect(isCalendarRowVisible(row, providers)).toBe(false);
    outlookOn = true;
    expect(isCalendarRowVisible(row, providers)).toBe(true);
  });

  it("a Google linked row still follows the linked-sync flag, whatever the other providers do", () => {
    delete process.env[KEY];
    outlookOn = true;
    expect(isCalendarRowVisible({ sourceAccountId: "a", provider: "GOOGLE" }, providers)).toBe(
      false,
    );
    process.env[KEY] = "true";
    expect(isCalendarRowVisible({ sourceAccountId: "a", provider: "GOOGLE" }, providers)).toBe(
      true,
    );
  });

  it("a row of a registered provider with no linked account is hidden too while its flag is off (a device bridge)", () => {
    const device: ProviderEnabledMap = { DEVICE: () => false };
    expect(isCalendarRowVisible({ sourceAccountId: null, provider: "DEVICE" }, device)).toBe(false);
    expect(isCalendarRowVisible({ sourceAccountId: null, provider: "GOOGLE" }, device)).toBe(true);
    expect(isCalendarRowVisible({ sourceAccountId: null, provider: "LOCAL" }, device)).toBe(true);
  });

  it("never reads a provider flag off the prototype chain", () => {
    delete process.env[KEY];
    for (const provider of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(isCalendarRowVisible({ sourceAccountId: null, provider }, providers)).toBe(true);
      expect(isCalendarRowVisible({ sourceAccountId: "a", provider }, providers)).toBe(false);
    }
    process.env[KEY] = "true";
    expect(isCalendarRowVisible({ sourceAccountId: "a", provider: "constructor" }, providers)).toBe(
      true,
    );
  });
});

describe("anyLinkedRowVisible: can a linked row reach a reader at all?", () => {
  let outlookOn = false;
  const providers: ProviderEnabledMap = { OUTLOOK: () => outlookOn };

  afterEach(() => {
    outlookOn = false;
  });

  it("is false with the linked sync off and no registered provider on", () => {
    delete process.env[KEY];
    expect(anyLinkedRowVisible({})).toBe(false);
    expect(anyLinkedRowVisible(providers)).toBe(false);
  });

  it("is true once the linked sync is on", () => {
    process.env[KEY] = "true";
    expect(anyLinkedRowVisible({})).toBe(true);
  });

  it("is true once a registered provider's own flag is on, with the linked sync off", () => {
    delete process.env[KEY];
    outlookOn = true;
    expect(anyLinkedRowVisible(providers)).toBe(true);
  });
});

// C4: Outlook plugs into the kill switch. Its rows follow outlookCalendarEnabled()
// (OUTLOOK_CALENDAR_ENABLED and OUTLOOK_INBOX_ENABLED), read at request time,
// whatever the Google linked-sync flag says, and nothing else changes.
describe("the default registry: OUTLOOK follows outlookCalendarEnabled() (C4)", () => {
  const OUTLOOK_KEYS = ["OUTLOOK_CALENDAR_ENABLED", "OUTLOOK_INBOX_ENABLED"] as const;
  const savedOutlook: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of OUTLOOK_KEYS) {
      savedOutlook[k] = process.env[k];
      delete process.env[k];
    }
    delete process.env[KEY];
  });
  afterEach(() => {
    for (const k of OUTLOOK_KEYS) {
      if (savedOutlook[k] === undefined) delete process.env[k];
      else process.env[k] = savedOutlook[k];
    }
  });

  function outlookFlags(on: boolean) {
    process.env.OUTLOOK_CALENDAR_ENABLED = on ? "true" : "false";
    process.env.OUTLOOK_INBOX_ENABLED = on ? "true" : "false";
  }

  const outlookRow = { sourceAccountId: "acct-out", provider: "OUTLOOK" };
  const googleLinkedRow = { sourceAccountId: "acct-g", provider: "GOOGLE" };
  const primaryRow = { sourceAccountId: null, provider: "GOOGLE" };
  const localRow = { sourceAccountId: null, provider: "LOCAL" };

  it("registers OUTLOOK, and only OUTLOOK", () => {
    expect(Object.keys(CALENDAR_PROVIDER_ENABLED)).toEqual(["OUTLOOK"]);
  });

  it("hides OUTLOOK rows while its flags are off, whatever the linked sync says", () => {
    expect(calendarSourceScope()).toEqual({
      sourceAccountId: null,
      provider: { notIn: ["OUTLOOK"] },
    });
    process.env[KEY] = "true";
    expect(calendarSourceScope()).toEqual({ provider: { notIn: ["OUTLOOK"] } });
    expect(isCalendarRowVisible(outlookRow)).toBe(false);
  });

  it("shows OUTLOOK rows once its flags are on, with the linked sync off", () => {
    outlookFlags(true);

    expect(calendarSourceScope()).toEqual({
      OR: [{ sourceAccountId: null }, { provider: { in: ["OUTLOOK"] } }],
    });
    expect(isCalendarRowVisible(outlookRow)).toBe(true);
  });

  it("adds nothing once both the linked sync and Outlook are on", () => {
    outlookFlags(true);
    process.env[KEY] = "true";

    expect(calendarSourceScope()).toEqual({});
  });

  it.each([
    ["only the calendar flag", { OUTLOOK_CALENDAR_ENABLED: "true" }],
    ["only the inbox flag", { OUTLOOK_INBOX_ENABLED: "true" }],
  ])("keeps OUTLOOK rows hidden with %s: both are required", (_label, env) => {
    Object.assign(process.env, env);

    expect(isCalendarRowVisible(outlookRow)).toBe(false);
    expect(calendarSourceScope()).toHaveProperty("provider");
  });

  it("is read at request time: a flip hides and shows the rows at once", () => {
    outlookFlags(true);
    expect(isCalendarRowVisible(outlookRow)).toBe(true);
    outlookFlags(false);
    expect(isCalendarRowVisible(outlookRow)).toBe(false);
  });

  it("leaves Google primary, LOCAL and Google linked rows exactly as they were", () => {
    for (const on of [false, true]) {
      outlookFlags(on);
      delete process.env[KEY];
      expect(isCalendarRowVisible(primaryRow)).toBe(true);
      expect(isCalendarRowVisible(localRow)).toBe(true);
      expect(isCalendarRowVisible(googleLinkedRow)).toBe(false);
      process.env[KEY] = "true";
      expect(isCalendarRowVisible(googleLinkedRow)).toBe(true);
      expect(isCalendarRowVisible(primaryRow)).toBe(true);
    }
  });
});
