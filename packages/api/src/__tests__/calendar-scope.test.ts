/**
 * C2 kill switch: while LINKED_CALENDAR_SYNC_ENABLED is off, every reader
 * excludes linked rows (sourceAccountId NULL only), so turning the flag off
 * hides rows already synced immediately instead of leaving them on screen.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
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

describe("calendarSourceScope", () => {
  it("limits a where clause to primary and LOCAL rows while the flag is off", () => {
    delete process.env[KEY];
    expect(calendarSourceScope()).toEqual({ sourceAccountId: null });
    process.env[KEY] = "false";
    expect(calendarSourceScope()).toEqual({ sourceAccountId: null });
  });

  it("adds nothing once the flag is on", () => {
    process.env[KEY] = "true";
    expect(calendarSourceScope()).toEqual({});
  });

  it("is read at request time: a flip needs no restart", () => {
    process.env[KEY] = "true";
    expect(calendarSourceScope()).toEqual({});
    process.env[KEY] = "off";
    expect(calendarSourceScope()).toEqual({ sourceAccountId: null });
  });

  it("returns a fresh object each call so a caller cannot poison the next query", () => {
    delete process.env[KEY];
    const first = calendarSourceScope() as { sourceAccountId?: unknown };
    first.sourceAccountId = "x";
    expect(calendarSourceScope()).toEqual({ sourceAccountId: null });
  });
});

describe("isCalendarRowVisible", () => {
  it("hides a linked row while the flag is off, shows it once on", () => {
    delete process.env[KEY];
    expect(isCalendarRowVisible({ sourceAccountId: "acct-1" })).toBe(false);
    process.env[KEY] = "true";
    expect(isCalendarRowVisible({ sourceAccountId: "acct-1" })).toBe(true);
  });

  it("always shows primary and LOCAL rows, whatever the flag", () => {
    delete process.env[KEY];
    expect(isCalendarRowVisible({ sourceAccountId: null })).toBe(true);
    expect(isCalendarRowVisible({})).toBe(true);
    process.env[KEY] = "true";
    expect(isCalendarRowVisible({ sourceAccountId: null })).toBe(true);
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
});
