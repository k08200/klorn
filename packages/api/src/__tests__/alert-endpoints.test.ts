// N8 "Where you get alerts": the pure half of GET /api/notifications/alert-endpoints.
// The DTO is what the settings list renders, so these pin both the labelling
// (browser · OS from the subscribing user agent) and the privacy contract: no
// push endpoint URL, key material, device token or client device id leaves the
// server.
import { describe, expect, it } from "vitest";
import {
  ALERT_RECEIPT_WINDOW_MS,
  browserFromPushHost,
  buildAlertEndpoints,
  parseClientPlatform,
  webPushHealth,
} from "../notify/alert-endpoints.js";

const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  // An installed (home-screen) web app on iOS drops the Version/Safari tokens.
  iphoneHomeScreen:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36",
  androidSamsung:
    "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36",
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  winEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0",
  linuxFirefox: "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
  chromeOs:
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
};

describe("parseClientPlatform", () => {
  it.each([
    ["iPhone Safari", UA.iphoneSafari, "safari", "ios"],
    ["an iPhone home-screen app", UA.iphoneHomeScreen, "safari", "ios"],
    ["Android Chrome (not 'Linux')", UA.androidChrome, "chrome", "android"],
    ["Samsung Internet (not Chrome)", UA.androidSamsung, "samsung", "android"],
    ["Chrome on a Mac", UA.macChrome, "chrome", "macos"],
    ["Safari on a Mac", UA.macSafari, "safari", "macos"],
    ["Edge on Windows (not Chrome)", UA.winEdge, "edge", "windows"],
    ["Firefox on Linux", UA.linuxFirefox, "firefox", "linux"],
    ["Chrome on ChromeOS (not Linux)", UA.chromeOs, "chrome", "chromeos"],
  ])("reads %s", (_name, ua, browser, os) => {
    expect(parseClientPlatform(ua)).toEqual({ browser, os });
  });

  it("answers null for an empty or unknown agent instead of guessing", () => {
    expect(parseClientPlatform(undefined)).toEqual({ browser: null, os: null });
    expect(parseClientPlatform("curl/8.0")).toEqual({ browser: null, os: null });
  });
});

describe("browserFromPushHost (rows stored before the browser was recorded)", () => {
  it.each([
    ["https://fcm.googleapis.com/fcm/send/abc", "chrome"],
    ["https://updates.push.services.mozilla.com/wpush/v2/abc", "firefox"],
    ["https://web.push.apple.com/QGx", "safari"],
    ["https://wns2-par02p.notify.windows.com/w/?token=abc", "edge"],
  ])("maps %s", (endpoint, browser) => {
    expect(browserFromPushHost(endpoint)).toBe(browser);
  });

  it("answers null for an unknown host or a malformed URL", () => {
    expect(browserFromPushHost("https://push.example.com/x")).toBeNull();
    expect(browserFromPushHost("not a url")).toBeNull();
  });
});

describe("webPushHealth", () => {
  const now = Date.UTC(2026, 10, 8, 12);
  const day = 24 * 60 * 60 * 1000;

  it("is ok when a receipt was confirmed inside the 3-day window", () => {
    expect(ALERT_RECEIPT_WINDOW_MS).toBe(3 * day);
    expect(webPushHealth({ createdAt: now - 30 * day, lastReceivedAt: now - 2 * day, now })).toBe(
      "ok",
    );
  });

  it("is stale when no receipt was confirmed in 3 days", () => {
    expect(
      webPushHealth({ createdAt: now - 30 * day, lastReceivedAt: now - 3 * day - 1, now }),
    ).toBe("stale");
    expect(webPushHealth({ createdAt: now - 30 * day, lastReceivedAt: null, now })).toBe("stale");
  });

  it("gives a subscription younger than the window a neutral 'new' state", () => {
    expect(webPushHealth({ createdAt: now - day, lastReceivedAt: null, now })).toBe("new");
  });
});

describe("buildAlertEndpoints", () => {
  const now = Date.UTC(2026, 10, 8, 12);
  const created = new Date(now - 10 * 24 * 60 * 60 * 1000);

  const webRow = {
    id: "sub-1",
    endpoint: "https://fcm.googleapis.com/fcm/send/SECRET-ENDPOINT",
    deviceId: "browser-uuid-1",
    browser: "chrome",
    os: "macos",
    createdAt: created,
  };

  it("never exposes endpoints, keys, device tokens or client device ids", () => {
    const result = buildAlertEndpoints({
      web: [webRow],
      native: [{ id: "tok-1", platform: "android", updatedAt: created }],
      desktop: [],
      lastReceivedBySubscription: new Map(),
      currentDeviceId: "browser-uuid-1",
      now,
    });
    const json = JSON.stringify(result);
    expect(json).not.toContain("SECRET-ENDPOINT");
    expect(json).not.toContain("fcm.googleapis.com");
    expect(json).not.toContain("browser-uuid-1");
    expect(json).not.toMatch(/"token"|"endpoint"|"p256dh"|"auth"|"deviceId"/);
  });

  it("labels a web subscription and marks the caller's own browser as current", () => {
    const received = new Date(now - 60 * 60 * 1000);
    const { endpoints } = buildAlertEndpoints({
      web: [webRow, { ...webRow, id: "sub-2", deviceId: "other", os: "windows" }],
      native: [],
      desktop: [],
      lastReceivedBySubscription: new Map([["sub-1", received]]),
      currentDeviceId: "browser-uuid-1",
      now,
    });
    expect(endpoints[0]).toEqual({
      kind: "web",
      id: "sub-1",
      browser: "chrome",
      os: "macos",
      current: true,
      createdAt: created.toISOString(),
      lastReceivedAt: received.toISOString(),
      health: "ok",
      needsResubscribe: false,
    });
    expect(endpoints[1]).toMatchObject({ id: "sub-2", current: false, health: "stale" });
  });

  it("falls back to the push service for the browser when none was recorded", () => {
    const { endpoints } = buildAlertEndpoints({
      web: [{ ...webRow, browser: null, os: null, deviceId: null }],
      native: [],
      desktop: [],
      lastReceivedBySubscription: new Map(),
      now,
    });
    expect(endpoints[0]).toMatchObject({ browser: "chrome", os: null, current: false });
  });

  it("drops a stored browser/os value outside the known set", () => {
    const { endpoints } = buildAlertEndpoints({
      web: [{ ...webRow, browser: "<script>", os: "plan9" }],
      native: [],
      desktop: [],
      lastReceivedBySubscription: new Map(),
      now,
    });
    expect(endpoints[0]).toMatchObject({ browser: "chrome", os: null });
  });

  it("lists native tokens and running desktop apps", () => {
    const seen = new Date(now - 5 * 60 * 1000);
    const { endpoints } = buildAlertEndpoints({
      web: [],
      native: [{ id: "tok-1", platform: "ios", updatedAt: created }],
      desktop: [{ app: "mac", running: true, lastSeenAt: seen.getTime() }],
      lastReceivedBySubscription: new Map(),
      now,
    });
    expect(endpoints).toEqual([
      { kind: "native", id: "tok-1", platform: "ios", registeredAt: created.toISOString() },
      { kind: "desktop", app: "mac", running: true, lastSeenAt: seen.toISOString() },
    ]);
  });

  describe("phoneConfigured", () => {
    const base = {
      native: [],
      desktop: [],
      lastReceivedBySubscription: new Map(),
      now,
    };

    it("is false with only desktop-browser subscriptions", () => {
      expect(buildAlertEndpoints({ ...base, web: [webRow] }).phoneConfigured).toBe(false);
    });

    it.each(["ios", "android"])("is true with a %s browser subscription", (os) => {
      expect(buildAlertEndpoints({ ...base, web: [{ ...webRow, os }] }).phoneConfigured).toBe(true);
    });

    it("is true with a native device token", () => {
      expect(
        buildAlertEndpoints({
          ...base,
          web: [],
          native: [{ id: "t", platform: "android", updatedAt: created }],
        }).phoneConfigured,
      ).toBe(true);
    });
  });
});
