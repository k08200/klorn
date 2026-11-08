// N8: the Klorn desktop apps poll and hold a WebSocket instead of a push
// token, so "Running · seen N min ago" comes from the WS hub's own connection
// events. In memory only — see notify/desktop-presence.ts for what that misses.
import { beforeEach, describe, expect, it } from "vitest";
import {
  createDesktopPresence,
  parseWsClientApp,
  parseWsClientType,
} from "../notify/desktop-presence.js";

describe("parseWsClientType", () => {
  it.each([
    ["web", "web"],
    ["desktop", "desktop"],
    ["widget", "widget"],
    [null, "web"],
    ["admin", "web"],
    ["DESKTOP", "web"],
  ])("maps %s to %s", (raw, type) => {
    expect(parseWsClientType(raw)).toBe(type);
  });
});

describe("parseWsClientApp", () => {
  it("reads only the Windows wrapper's tag; anything else is the Mac app", () => {
    expect(parseWsClientApp("windows")).toBe("windows");
    expect(parseWsClientApp(null)).toBe("mac");
    expect(parseWsClientApp("mac")).toBe("mac");
    expect(parseWsClientApp("<x>")).toBe("mac");
  });
});

describe("createDesktopPresence", () => {
  let presence: ReturnType<typeof createDesktopPresence>;
  beforeEach(() => {
    presence = createDesktopPresence();
  });

  it("knows nothing about a user who never connected a desktop app", () => {
    expect(presence.list("user-1", 1_000)).toEqual([]);
  });

  it("reports a connected app as running, seen now", () => {
    presence.connected("user-1", "c1", "mac", 1_000);
    expect(presence.list("user-1", 5_000)).toEqual([
      { app: "mac", running: true, lastSeenAt: 5_000 },
    ]);
  });

  it("keeps the close time after the last socket of an app goes away", () => {
    presence.connected("user-1", "c1", "mac", 1_000);
    presence.connected("user-1", "c2", "mac", 2_000);
    presence.disconnected("user-1", "c1", 3_000);
    expect(presence.list("user-1", 4_000)[0]).toMatchObject({ running: true });
    presence.disconnected("user-1", "c2", 6_000);
    expect(presence.list("user-1", 9_000)).toEqual([
      { app: "mac", running: false, lastSeenAt: 6_000 },
    ]);
  });

  it("tracks the Mac and Windows apps apart and never across users", () => {
    presence.connected("user-1", "c1", "mac", 1_000);
    presence.connected("user-1", "c2", "windows", 1_000);
    presence.connected("user-2", "c3", "mac", 1_000);
    expect(
      presence
        .list("user-1", 2_000)
        .map((p) => p.app)
        .sort(),
    ).toEqual(["mac", "windows"]);
    presence.disconnected("user-2", "c3", 3_000);
    expect(presence.list("user-1", 4_000).every((p) => p.running)).toBe(true);
  });

  it("ignores a disconnect for a socket it never saw", () => {
    presence.disconnected("user-1", "ghost", 1_000);
    expect(presence.list("user-1", 2_000)).toEqual([]);
  });
});
