/**
 * Today home (productization plan P6, UNIFIED_HOME) — the pure rules in
 * packages/web/src/app/today/model.ts and packages/web/src/lib/home.ts: which
 * accounts count as connected and how healthy they are, how a lane block is
 * cut, the day's range in the user's zone, the merged calendar's order,
 * conflicts and "now" marker, and which route is home.
 */

import type { InboxOption } from "@klorn/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CalendarEventWire,
  dayRangeInZone,
  eventBarColor,
  eventPhase,
  eventSourceProvider,
  findConflicts,
  laneBlock,
  nowMarkerIndex,
  orderEvents,
} from "../../../web/src/app/today/model";
import { connectedAccounts } from "../../../web/src/lib/connected-accounts";
import {
  assistantHref,
  forgetHome,
  homePath,
  LEGACY_HOME,
  landingHome,
  landingStep,
  rememberHome,
  signInDestination,
  TODAY_HOME,
  takeLegacyLanding,
} from "../../../web/src/lib/home";

const inbox = (over: Partial<InboxOption>): InboxOption => ({
  id: null,
  email: "me@gmail.com",
  kind: "primary",
  needsReconnect: false,
  provider: "GOOGLE",
  purpose: null,
  ...over,
});

const event = (over: Partial<CalendarEventWire>): CalendarEventWire => ({
  id: "e1",
  title: "Standup",
  startTime: "2026-10-08T01:00:00.000Z",
  endTime: "2026-10-08T01:30:00.000Z",
  location: null,
  allDay: false,
  ...over,
});

describe("homePath", () => {
  it("is Today only when the server said so", () => {
    expect(homePath({ unifiedHome: true })).toBe(TODAY_HOME);
    expect(homePath({ unifiedHome: false })).toBe(LEGACY_HOME);
    expect(homePath({})).toBe(LEGACY_HOME);
    expect(homePath(null)).toBe(LEGACY_HOME);
  });

  it("sends Assistant to the hub's approvals page (P7)", () => {
    expect(assistantHref()).toBe("/assistant/approvals");
  });
});

describe("connectedAccounts", () => {
  const linked = [
    inbox({ id: "l1", kind: "linked", provider: "OUTLOOK", email: "me@outlook.com" }),
    inbox({
      id: "l2",
      kind: "linked",
      provider: "NAVER",
      email: "me@naver.com",
      needsReconnect: true,
    }),
  ];

  it("lists every connected source, primary first, with its health", () => {
    const accounts = connectedAccounts([inbox({}), ...linked], {
      googleConnected: true,
      primarySyncing: false,
    });
    expect(accounts.map((a) => [a.provider, a.health])).toEqual([
      ["GOOGLE", "synced"],
      ["OUTLOOK", "synced"],
      ["NAVER", "reconnect"],
    ]);
  });

  it("drops the primary row when Google was never connected", () => {
    // GET /api/email/inboxes always returns a primary row; without a grant it
    // is not a source, and showing it would claim a Google account is synced.
    const accounts = connectedAccounts([inbox({}), ...linked], {
      googleConnected: false,
      primarySyncing: false,
    });
    expect(accounts.map((a) => a.provider)).toEqual(["OUTLOOK", "NAVER"]);
  });

  it("is empty for a signed-in user with nothing connected", () => {
    expect(
      connectedAccounts([inbox({})], { googleConnected: false, primarySyncing: false }),
    ).toEqual([]);
  });

  it("keeps the primary while the connection state is still unknown", () => {
    const accounts = connectedAccounts([inbox({})], {
      googleConnected: null,
      primarySyncing: false,
    });
    expect(accounts).toHaveLength(1);
  });

  it("marks only the primary as syncing, and reconnect wins over syncing", () => {
    const syncing = connectedAccounts([inbox({}), ...linked], {
      googleConnected: true,
      primarySyncing: true,
    });
    expect(syncing.map((a) => a.health)).toEqual(["syncing", "synced", "reconnect"]);
    const dead = connectedAccounts([inbox({ needsReconnect: true })], {
      googleConnected: true,
      primarySyncing: true,
    });
    expect(dead[0].health).toBe("reconnect");
  });
});

describe("laneBlock", () => {
  const rows = ["a", "b", "c", "d", "e", "f", "g"];

  it("shows the first rows and counts the rest from the lane's own total", () => {
    expect(laneBlock(rows, 42, 5)).toEqual({ shown: ["a", "b", "c", "d", "e"], more: 37 });
  });

  it("has nothing more when everything fits", () => {
    expect(laneBlock(["a", "b"], 2, 5)).toEqual({ shown: ["a", "b"], more: 0 });
  });

  it("never reports a negative remainder when the total lags the rows", () => {
    expect(laneBlock(rows, 3, 5).more).toBe(2);
    expect(laneBlock(["a"], 0, 5).more).toBe(0);
  });
});

describe("dayRangeInZone", () => {
  it("is local midnight to the next local midnight", () => {
    const { start, end } = dayRangeInZone(new Date("2026-10-08T03:15:00.000Z"), "Asia/Seoul");
    expect(start.toISOString()).toBe("2026-10-07T15:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-08T15:00:00.000Z");
  });

  it("uses the zone's day, not UTC's", () => {
    // 01:00Z on the 8th is still the 7th in Los Angeles (UTC-7 in October).
    const { start, end } = dayRangeInZone(
      new Date("2026-10-08T01:00:00.000Z"),
      "America/Los_Angeles",
    );
    expect(start.toISOString()).toBe("2026-10-07T07:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-08T07:00:00.000Z");
  });

  it("spans 23 hours on the day the clocks go forward", () => {
    const { start, end } = dayRangeInZone(
      new Date("2026-03-08T18:00:00.000Z"),
      "America/Los_Angeles",
    );
    expect(start.toISOString()).toBe("2026-03-08T08:00:00.000Z");
    expect(end.toISOString()).toBe("2026-03-09T07:00:00.000Z");
  });

  it("falls back to UTC for a zone the runtime does not know", () => {
    const { start } = dayRangeInZone(new Date("2026-10-08T03:15:00.000Z"), "Not/AZone");
    expect(start.toISOString()).toBe("2026-10-08T00:00:00.000Z");
  });
});

describe("orderEvents", () => {
  it("puts all-day events first, then by start, then by end", () => {
    const ordered = orderEvents([
      event({
        id: "late",
        startTime: "2026-10-08T05:00:00.000Z",
        endTime: "2026-10-08T06:00:00.000Z",
      }),
      event({
        id: "long",
        startTime: "2026-10-08T01:00:00.000Z",
        endTime: "2026-10-08T03:00:00.000Z",
      }),
      event({ id: "day", allDay: true, startTime: "2026-10-08T00:00:00.000Z" }),
      event({
        id: "short",
        startTime: "2026-10-08T01:00:00.000Z",
        endTime: "2026-10-08T01:30:00.000Z",
      }),
    ]);
    expect(ordered.map((e) => e.id)).toEqual(["day", "short", "long", "late"]);
  });

  it("drops an event whose times cannot be parsed, and does not mutate its input", () => {
    const input = [event({ id: "bad", startTime: "nope" }), event({ id: "ok" })];
    expect(orderEvents(input).map((e) => e.id)).toEqual(["ok"]);
    expect(input.map((e) => e.id)).toEqual(["bad", "ok"]);
  });
});

describe("findConflicts", () => {
  const at = (id: string, from: string, to: string, over: Partial<CalendarEventWire> = {}) =>
    event({
      id,
      startTime: `2026-10-08T${from}:00.000Z`,
      endTime: `2026-10-08T${to}:00.000Z`,
      ...over,
    });

  it("flags both sides of an overlap", () => {
    const conflicts = findConflicts([at("a", "01:00", "02:00"), at("b", "01:30", "02:30")]);
    expect([...conflicts].sort()).toEqual(["a", "b"]);
  });

  it("does not flag back-to-back meetings", () => {
    expect(findConflicts([at("a", "01:00", "02:00"), at("b", "02:00", "03:00")]).size).toBe(0);
  });

  it("flags an event that sits inside a longer one, and one the long event outlasts", () => {
    const conflicts = findConflicts([
      at("long", "01:00", "05:00"),
      at("inner", "02:00", "02:30"),
      at("tail", "04:00", "04:30"),
      at("free", "06:00", "07:00"),
    ]);
    expect([...conflicts].sort()).toEqual(["inner", "long", "tail"]);
  });

  it("ignores all-day events: a holiday does not conflict with a meeting", () => {
    const conflicts = findConflicts([
      at("day", "00:00", "23:59", { allDay: true }),
      at("a", "01:00", "02:00"),
    ]);
    expect(conflicts.size).toBe(0);
  });

  it("ignores zero-length and unparseable events", () => {
    const conflicts = findConflicts([
      at("point", "01:30", "01:30"),
      at("a", "01:00", "02:00"),
      event({ id: "bad", startTime: "nope", endTime: "also nope" }),
    ]);
    expect(conflicts.size).toBe(0);
  });
});

describe("eventPhase and nowMarkerIndex", () => {
  const events = orderEvents([
    event({ id: "day", allDay: true, startTime: "2026-10-08T00:00:00.000Z" }),
    event({ id: "a", startTime: "2026-10-08T01:00:00.000Z", endTime: "2026-10-08T02:00:00.000Z" }),
    event({ id: "b", startTime: "2026-10-08T04:00:00.000Z", endTime: "2026-10-08T05:00:00.000Z" }),
  ]);

  it("places an event before, during or after now", () => {
    const now = new Date("2026-10-08T04:30:00.000Z");
    expect(events.map((e) => eventPhase(e, now))).toEqual(["allDay", "past", "now"]);
    expect(eventPhase(events[2], new Date("2026-10-08T03:00:00.000Z"))).toBe("upcoming");
  });

  it("puts the marker before the first event that has not ended", () => {
    // Between a and b: after the all-day row and a, before b.
    expect(nowMarkerIndex(events, new Date("2026-10-08T03:00:00.000Z"))).toBe(2);
    // During a: the marker sits above the running event.
    expect(nowMarkerIndex(events, new Date("2026-10-08T01:30:00.000Z"))).toBe(1);
    // Before everything timed: right after the all-day rows.
    expect(nowMarkerIndex(events, new Date("2026-10-07T23:00:00.000Z"))).toBe(1);
    // After everything: at the end.
    expect(nowMarkerIndex(events, new Date("2026-10-08T09:00:00.000Z"))).toBe(3);
  });

  it("has no marker on a day with no timed events", () => {
    expect(nowMarkerIndex([events[0]], new Date("2026-10-08T03:00:00.000Z"))).toBeNull();
    expect(nowMarkerIndex([], new Date("2026-10-08T03:00:00.000Z"))).toBeNull();
  });
});

describe("event source", () => {
  it("accepts a hex calendar colour and nothing else", () => {
    expect(eventBarColor("#0B8043")).toBe("#0B8043");
    expect(eventBarColor("#abc")).toBe("#abc");
    expect(eventBarColor("7")).toBeNull();
    expect(eventBarColor("red; background:url(x)")).toBeNull();
    expect(eventBarColor(null)).toBeNull();
    expect(eventBarColor(undefined)).toBeNull();
  });

  it("badges only providers that are an account, not a device or a local event", () => {
    expect(eventSourceProvider("GOOGLE")).toBe("GOOGLE");
    expect(eventSourceProvider("OUTLOOK")).toBe("OUTLOOK");
    expect(eventSourceProvider("ICLOUD")).toBe("ICLOUD");
    expect(eventSourceProvider("NAVER")).toBe("NAVER");
    expect(eventSourceProvider("DEVICE")).toBeNull();
    expect(eventSourceProvider("LOCAL")).toBeNull();
    expect(eventSourceProvider(undefined)).toBeNull();
  });
});

describe("signInDestination", () => {
  it("returns to the page the visitor came from, for sign-in and registration alike", () => {
    expect(signInDestination("/email/abc", { unifiedHome: true })).toBe("/email/abc");
    expect(signInDestination("/inbox", { unifiedHome: true })).toBe("/inbox");
  });

  it("lands on the user's home when there is no page to return to", () => {
    expect(signInDestination(undefined, { unifiedHome: true })).toBe(TODAY_HOME);
    expect(signInDestination(null, { unifiedHome: false })).toBe(LEGACY_HOME);
    expect(signInDestination(undefined, {})).toBe(LEGACY_HOME);
    expect(signInDestination("", null)).toBe(LEGACY_HOME);
  });
});

describe("landingStep", () => {
  it("waits on the root route, whose redirect may still be in flight", () => {
    expect(landingStep("/", true)).toBe("wait");
    expect(landingStep("/", false)).toBe("wait");
  });

  it("resolves only on the legacy home, and only once the user has loaded", () => {
    expect(landingStep("/inbox", false)).toBe("wait");
    expect(landingStep("/inbox", true)).toBe("resolve");
  });

  it("drops the mark on any other route, loaded or not", () => {
    for (const path of ["/email", "/today", "/inbox/receipt", "/settings/accounts"]) {
      expect(landingStep(path, false)).toBe("discard");
      expect(landingStep(path, true)).toBe("discard");
    }
  });
});

describe("the home hint and the landing mark", () => {
  const fakeStorage = () => {
    const data = new Map<string, string>();
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
      keys: () => [...data.keys()],
    };
  };
  let local: ReturnType<typeof fakeStorage>;
  let session: ReturnType<typeof fakeStorage>;

  beforeEach(() => {
    local = fakeStorage();
    session = fakeStorage();
    vi.stubGlobal("window", { localStorage: local, sessionStorage: session });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("with the flag off nothing is kept, and the landing is the legacy home", () => {
    rememberHome({ unifiedHome: false });
    expect(local.keys()).toEqual([]);
    expect(landingHome()).toBe(LEGACY_HOME);
  });

  it("marks a landing on the legacy home, once", () => {
    expect(landingHome()).toBe(LEGACY_HOME);
    expect(takeLegacyLanding()).toBe(true);
    expect(takeLegacyLanding()).toBe(false);
  });

  it("lands on Today, unmarked, once the server has said so", () => {
    rememberHome({ unifiedHome: true });
    expect(landingHome()).toBe(TODAY_HOME);
    expect(takeLegacyLanding()).toBe(false);
  });

  it("drops the hint when the server stops saying so", () => {
    rememberHome({ unifiedHome: true });
    rememberHome({ unifiedHome: false });
    expect(landingHome()).toBe(LEGACY_HOME);
  });

  it("sign-out forgets both the hint and a pending mark", () => {
    rememberHome({ unifiedHome: true });
    session.setItem("klorn.legacyLanding", "1");
    forgetHome();
    expect(local.keys()).toEqual([]);
    expect(session.keys()).toEqual([]);
    expect(takeLegacyLanding()).toBe(false);
  });

  it("survives a browser with no usable storage", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    vi.stubGlobal("window", { localStorage: broken, sessionStorage: broken });
    expect(() => rememberHome({ unifiedHome: true })).not.toThrow();
    expect(() => forgetHome()).not.toThrow();
    expect(landingHome()).toBe(LEGACY_HOME);
    expect(takeLegacyLanding()).toBe(false);
  });
});
