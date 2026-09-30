/**
 * C1/C2 (docs/providers/unified-platform-plan.md) — provider-aware CalendarEvent
 * rows. `pim/calendar-rows.ts` is the one place that decides which
 * (provider, externalId, sourceAccountId, sourceKey) a row is written with, and
 * the one place Google events are upserted. The primary calendar still matches
 * by googleId; a linked calendar's rows match by the per-source unique.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const upsert = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("../db.js", () => {
  const prisma = { calendarEvent: { upsert } };
  return { prisma, db: prisma };
});

const {
  PRIMARY_SOURCE_KEY,
  eventSourceForGoogleId,
  googleEventSource,
  linkedGoogleEventSource,
  localEventSource,
  sourceKeyFor,
  upsertGoogleEventRow,
  upsertLinkedGoogleEventRow,
} = await import("../pim/calendar-rows.js");

const FIELDS = {
  title: "Standup",
  description: null,
  startTime: new Date("2026-10-01T00:00:00.000Z"),
  endTime: new Date("2026-10-01T00:30:00.000Z"),
  location: "Room 1",
  meetingLink: "https://meet.google.com/abc-defg-hij",
  allDay: false,
};

describe("event source descriptors", () => {
  it("a Google event is GOOGLE with the Google id as externalId and no linked account", () => {
    expect(googleEventSource("g-123")).toEqual({
      provider: "GOOGLE",
      externalId: "g-123",
      sourceAccountId: null,
      sourceKey: "primary",
    });
  });

  it("a Klorn-created event with no external calendar is LOCAL with no externalId", () => {
    expect(localEventSource()).toEqual({
      provider: "LOCAL",
      externalId: null,
      sourceAccountId: null,
      sourceKey: "primary",
    });
  });

  it("maps a nullable googleId: present -> GOOGLE, null/undefined/empty -> LOCAL", () => {
    expect(eventSourceForGoogleId("g-9")).toEqual(googleEventSource("g-9"));
    expect(eventSourceForGoogleId(null)).toEqual(localEventSource());
    expect(eventSourceForGoogleId(undefined)).toEqual(localEventSource());
    expect(eventSourceForGoogleId("")).toEqual(localEventSource());
  });

  it("returns a fresh object per call so a caller cannot poison the next row", () => {
    const first = localEventSource() as { provider: string };
    first.provider = "GOOGLE";
    expect(localEventSource().provider).toBe("LOCAL");
  });
});

describe("upsertGoogleEventRow", () => {
  beforeEach(() => upsert.mockClear());

  it("still matches by (userId, googleId) — reads and lookups stay on googleId", async () => {
    await upsertGoogleEventRow("u1", "g-1", FIELDS);
    const arg = upsert.mock.calls[0]?.[0] as { where: unknown };
    expect(arg.where).toEqual({ userId_googleId: { userId: "u1", googleId: "g-1" } });
  });

  it("dual-writes provider and externalId on create, alongside googleId", async () => {
    await upsertGoogleEventRow("u1", "g-1", FIELDS);
    const arg = upsert.mock.calls[0]?.[0] as { create: Record<string, unknown> };
    expect(arg.create).toEqual({
      userId: "u1",
      ...FIELDS,
      googleId: "g-1",
      provider: "GOOGLE",
      externalId: "g-1",
      sourceAccountId: null,
      sourceKey: "primary",
    });
  });

  it("re-stamps provider and externalId on update so rows written by the previous release converge", async () => {
    await upsertGoogleEventRow("u1", "g-1", FIELDS);
    const arg = upsert.mock.calls[0]?.[0] as { update: Record<string, unknown> };
    expect(arg.update).toEqual({ ...FIELDS, provider: "GOOGLE", externalId: "g-1" });
  });

  it("never lets the update move a row to another user or rewrite its googleId", async () => {
    await upsertGoogleEventRow("u1", "g-1", FIELDS);
    const arg = upsert.mock.calls[0]?.[0] as { update: Record<string, unknown> };
    expect(arg.update).not.toHaveProperty("userId");
    expect(arg.update).not.toHaveProperty("googleId");
    expect(arg.update).not.toHaveProperty("sourceAccountId");
    expect(arg.update).not.toHaveProperty("sourceKey");
  });

  it("does not mutate the fields object it is given", async () => {
    const input = { ...FIELDS };
    await upsertGoogleEventRow("u1", "g-1", input);
    expect(input).toEqual(FIELDS);
  });
});

describe("source key", () => {
  it("is 'primary' for the primary calendar and the linked account id otherwise", () => {
    expect(PRIMARY_SOURCE_KEY).toBe("primary");
    expect(sourceKeyFor(null)).toBe("primary");
    expect(sourceKeyFor("acct-1")).toBe("acct-1");
  });

  it("every descriptor keeps sourceKey equal to sourceKeyFor(sourceAccountId), the DB CHECK's rule", () => {
    for (const source of [
      googleEventSource("g"),
      localEventSource(),
      eventSourceForGoogleId("g"),
      eventSourceForGoogleId(null),
      linkedGoogleEventSource("acct-9", "g"),
    ]) {
      expect(source.sourceKey).toBe(sourceKeyFor(source.sourceAccountId));
    }
  });
});

describe("linked Google calendar rows", () => {
  beforeEach(() => upsert.mockClear());

  it("describes a linked event as GOOGLE, tagged with its account, keyed by that account", () => {
    expect(linkedGoogleEventSource("acct-1", "g-7")).toEqual({
      provider: "GOOGLE",
      externalId: "g-7",
      sourceAccountId: "acct-1",
      sourceKey: "acct-1",
    });
  });

  it("matches by the per-source unique, never by googleId (the primary row with the same id must not be touched)", async () => {
    await upsertLinkedGoogleEventRow("u1", "acct-1", "g-7", FIELDS);
    const arg = upsert.mock.calls[0]?.[0] as { where: unknown };
    expect(arg.where).toEqual({
      userId_provider_sourceKey_externalId: {
        userId: "u1",
        provider: "GOOGLE",
        sourceKey: "acct-1",
        externalId: "g-7",
      },
    });
  });

  it("creates the row with the full linked identity and NO googleId (it stays NULL)", async () => {
    await upsertLinkedGoogleEventRow("u1", "acct-1", "g-7", FIELDS);
    const arg = upsert.mock.calls[0]?.[0] as { create: Record<string, unknown> };
    expect(arg.create).toEqual({
      userId: "u1",
      ...FIELDS,
      provider: "GOOGLE",
      externalId: "g-7",
      sourceAccountId: "acct-1",
      sourceKey: "acct-1",
    });
    expect(arg.create).not.toHaveProperty("googleId");
  });

  it("updates only the synced fields: identity and ownership never move", async () => {
    await upsertLinkedGoogleEventRow("u1", "acct-1", "g-7", FIELDS);
    const arg = upsert.mock.calls[0]?.[0] as { update: Record<string, unknown> };
    expect(arg.update).toEqual({ ...FIELDS });
  });

  it("refuses an empty account id: a linked row with no account would be a primary row", async () => {
    await expect(upsertLinkedGoogleEventRow("u1", "", "g-7", FIELDS)).rejects.toThrow(
      /linked account id/,
    );
    expect(upsert).not.toHaveBeenCalled();
  });
});
