/**
 * C2: the same Google event id can be a row in the primary calendar AND in a
 * linked one (an invite to both addresses). Both rows are kept in the database;
 * readers that would show or count the event twice dedupe by (provider,
 * externalId) and prefer the primary copy. Matching by the event id alone is a
 * known limit (see the C7 note in the plan).
 */

import { describe, expect, it } from "vitest";
import { dedupeCalendarEvents } from "../pim/calendar-dedupe.js";

type Row = {
  id: string;
  provider: string;
  externalId: string | null;
  sourceAccountId: string | null;
  userId?: string;
};

const primary = (id: string, externalId: string | null, provider = "GOOGLE"): Row => ({
  id,
  provider,
  externalId,
  sourceAccountId: null,
});
const linked = (id: string, externalId: string, account = "acct-1", provider = "GOOGLE"): Row => ({
  id,
  provider,
  externalId,
  sourceAccountId: account,
});
const ids = (rows: readonly Row[]) => rows.map((r) => r.id);

describe("dedupeCalendarEvents", () => {
  it("keeps the primary row when the same event is also in a linked calendar", () => {
    expect(ids(dedupeCalendarEvents([primary("p", "g-1"), linked("l", "g-1")]))).toEqual(["p"]);
  });

  it("prefers the primary row even when the linked row comes first", () => {
    const out = dedupeCalendarEvents([linked("l", "g-1"), primary("p", "g-1")]);
    expect(ids(out)).toEqual(["p"]);
  });

  it("keeps the first row of a group that exists only in linked calendars", () => {
    const out = dedupeCalendarEvents([linked("a", "g-1", "acct-1"), linked("b", "g-1", "acct-2")]);
    expect(ids(out)).toEqual(["a"]);
  });

  it("keeps events with different ids, in their original order", () => {
    const rows = [primary("p1", "g-1"), linked("l2", "g-2"), primary("p3", "g-3")];
    expect(ids(dedupeCalendarEvents(rows))).toEqual(["p1", "l2", "p3"]);
  });

  it("keeps the survivor at the position of the row that survives, not of the first duplicate", () => {
    const out = dedupeCalendarEvents([
      linked("l1", "g-1"),
      primary("p2", "g-2"),
      primary("p1", "g-1"),
    ]);
    expect(ids(out)).toEqual(["p2", "p1"]);
  });

  it("never merges LOCAL rows, which have no externalId", () => {
    const rows = [primary("a", null, "LOCAL"), primary("b", null, "LOCAL")];
    expect(ids(dedupeCalendarEvents(rows))).toEqual(["a", "b"]);
  });

  it("does not merge equal ids from different providers", () => {
    const rows = [primary("g", "x-1", "GOOGLE"), primary("o", "x-1", "OUTLOOK")];
    expect(ids(dedupeCalendarEvents(rows))).toEqual(["g", "o"]);
  });

  it("does not merge rows of different users when the rows carry userId", () => {
    const a: Row = { ...primary("a", "g-1"), userId: "u1" };
    const b: Row = { ...primary("b", "g-1"), userId: "u2" };
    expect(ids(dedupeCalendarEvents([a, b]))).toEqual(["a", "b"]);
  });

  it("tolerates rows that carry no identity fields at all (selects that omit them)", () => {
    const bare = [{ id: "a" }, { id: "b" }] as unknown as Row[];
    expect(ids(dedupeCalendarEvents(bare))).toEqual(["a", "b"]);
  });

  it("returns a new array and never mutates its input", () => {
    const input = Object.freeze([primary("p", "g-1"), linked("l", "g-1")]);
    const out = dedupeCalendarEvents(input);
    expect(out).not.toBe(input);
    expect(input).toHaveLength(2);
  });

  it("returns an empty array for no rows", () => {
    expect(dedupeCalendarEvents([])).toEqual([]);
  });

  it("stays linear on 10k rows", () => {
    const rows: Row[] = [];
    for (let i = 0; i < 5000; i++) rows.push(linked(`l${i}`, `g-${i}`), primary(`p${i}`, `g-${i}`));
    const started = performance.now();
    const out = dedupeCalendarEvents(rows);
    expect(out).toHaveLength(5000);
    expect(ids(out).every((id) => id.startsWith("p"))).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
