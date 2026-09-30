/**
 * C1 (docs/providers/unified-platform-plan.md) — provider-aware CalendarEvent
 * rows. `pim/calendar-rows.ts` is the one place that decides which
 * (provider, externalId, sourceAccountId) a row is written with, and the one
 * place the three Google sync sites upsert through. Reads stay on googleId.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const upsert = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("../db.js", () => {
  const prisma = { calendarEvent: { upsert } };
  return { prisma, db: prisma };
});

const { eventSourceForGoogleId, googleEventSource, localEventSource, upsertGoogleEventRow } =
  await import("../pim/calendar-rows.js");

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
    });
  });

  it("a Klorn-created event with no external calendar is LOCAL with no externalId", () => {
    expect(localEventSource()).toEqual({
      provider: "LOCAL",
      externalId: null,
      sourceAccountId: null,
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
  });

  it("does not mutate the fields object it is given", async () => {
    const input = { ...FIELDS };
    await upsertGoogleEventRow("u1", "g-1", input);
    expect(input).toEqual(FIELDS);
  });
});
