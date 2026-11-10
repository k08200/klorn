// N7 + N8 UI decisions, pure: which push prompt a browser gets, how each
// alert endpoint row is labelled, and what its status dot + text say.
// Run from the api suite because the web package has no unit-test runner
// (see web-tool-labels.test.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  alertEndpointName,
  alertRowStatus,
  PHONE_SETUP_URL,
  shouldOfferPushBanner,
} from "../../../web/src/lib/alert-devices";
import de from "../../../web/src/lib/locales/de";
import en from "../../../web/src/lib/locales/en";
import es from "../../../web/src/lib/locales/es";
import fr from "../../../web/src/lib/locales/fr";
import ja from "../../../web/src/lib/locales/ja";
import ko from "../../../web/src/lib/locales/ko";
import zh from "../../../web/src/lib/locales/zh";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";
const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

describe("shouldOfferPushBanner", () => {
  const base = { standalone: false, native: false };

  it("leaves an iPhone Safari tab to the home-screen card (web push cannot subscribe there)", () => {
    expect(shouldOfferPushBanner({ ...base, userAgent: IPHONE_SAFARI })).toBe(false);
  });

  it("offers it in the installed iPhone home-screen app", () => {
    expect(shouldOfferPushBanner({ ...base, userAgent: IPHONE_SAFARI, standalone: true })).toBe(
      true,
    );
  });

  it.each([
    ["Android Chrome", ANDROID_CHROME],
    ["desktop Chrome", MAC_CHROME],
  ])("offers it in %s", (_name, userAgent) => {
    expect(shouldOfferPushBanner({ ...base, userAgent })).toBe(true);
  });

  it("never offers it inside the native shell", () => {
    expect(shouldOfferPushBanner({ ...base, userAgent: ANDROID_CHROME, native: true })).toBe(false);
  });
});

describe("alertEndpointName", () => {
  it("names a browser subscription by browser and OS", () => {
    expect(
      alertEndpointName({
        kind: "web",
        id: "a",
        browser: "chrome",
        os: "android",
        current: false,
        createdAt: "2026-11-01T00:00:00Z",
        lastReceivedAt: null,
        health: "new",
      }),
    ).toEqual({ key: "alertDevices.name.web", params: { browser: "Chrome", os: "Android" } });
  });

  it("names an iPhone home-screen subscription as the iPhone app, not Safari", () => {
    expect(
      alertEndpointName({
        kind: "web",
        id: "a",
        browser: "safari",
        os: "ios",
        current: false,
        createdAt: "2026-11-01T00:00:00Z",
        lastReceivedAt: null,
        health: "new",
      }),
    ).toEqual({ key: "alertDevices.name.iphoneWeb", params: {} });
  });

  it("falls back to the browser alone, then to a generic name", () => {
    const row = {
      kind: "web" as const,
      id: "a",
      current: false,
      createdAt: "2026-11-01T00:00:00Z",
      lastReceivedAt: null,
      health: "new" as const,
    };
    expect(alertEndpointName({ ...row, browser: "firefox", os: null })).toEqual({
      key: "alertDevices.name.browserOnly",
      params: { browser: "Firefox" },
    });
    expect(alertEndpointName({ ...row, browser: null, os: null })).toEqual({
      key: "alertDevices.name.unknownBrowser",
      params: {},
    });
  });

  it("names native and desktop apps", () => {
    expect(
      alertEndpointName({ kind: "native", id: "t", platform: "android", registeredAt: "x" }),
    ).toEqual({ key: "alertDevices.name.androidApp", params: {} });
    expect(
      alertEndpointName({ kind: "desktop", app: "windows", running: true, lastSeenAt: "x" }),
    ).toEqual({ key: "alertDevices.name.windowsApp", params: {} });
  });
});

describe("alertRowStatus — the dot never carries meaning alone", () => {
  const web = {
    kind: "web" as const,
    id: "a",
    browser: "chrome" as const,
    os: "macos" as const,
    current: false,
    createdAt: "2026-11-01T00:00:00Z",
  };

  it.each([
    [
      { ...web, health: "ok" as const, lastReceivedAt: "2026-11-08T00:00:00Z" },
      "ok",
      "alertDevices.status.delivered",
      "2026-11-08T00:00:00Z",
    ],
    [
      { ...web, health: "new" as const, lastReceivedAt: null },
      "neutral",
      "alertDevices.status.new",
      "2026-11-01T00:00:00Z",
    ],
    [
      { ...web, health: "stale" as const, lastReceivedAt: "2026-11-02T00:00:00Z" },
      "warn",
      "alertDevices.status.staleSince",
      "2026-11-02T00:00:00Z",
    ],
    [
      { ...web, health: "stale" as const, lastReceivedAt: null },
      "warn",
      "alertDevices.status.staleNever",
      null,
    ],
  ])("web row %#", (row, tone, key, at) => {
    expect(alertRowStatus(row)).toEqual({ tone, key, at });
  });

  it("native and desktop rows", () => {
    expect(
      alertRowStatus({
        kind: "native",
        id: "t",
        platform: "ios",
        registeredAt: "2026-11-01T00:00:00Z",
      }),
    ).toEqual({
      tone: "neutral",
      key: "alertDevices.status.registered",
      at: "2026-11-01T00:00:00Z",
    });
    expect(
      alertRowStatus({
        kind: "desktop",
        app: "mac",
        running: true,
        lastSeenAt: "2026-11-08T00:00:00Z",
      }),
    ).toEqual({ tone: "ok", key: "alertDevices.status.running", at: "2026-11-08T00:00:00Z" });
    expect(
      alertRowStatus({
        kind: "desktop",
        app: "mac",
        running: false,
        lastSeenAt: "2026-11-08T00:00:00Z",
      }),
    ).toEqual({ tone: "off", key: "alertDevices.status.notRunning", at: "2026-11-08T00:00:00Z" });
  });
});

describe("phone setup", () => {
  it("points the QR code at the app itself, encoded locally", () => {
    expect(PHONE_SETUP_URL).toBe("https://app.klorn.ai");
    const src = readFileSync(
      join(__dirname, "../../../web/src/components/alert-devices/phone-setup.tsx"),
      "utf8",
    );
    // No third-party QR web service: the URL is encoded in the browser.
    expect(src).not.toMatch(/https?:\/\/(?!app\.klorn\.ai)[^"'\s]*qr/i);
    expect(src).toMatch(/qrcode-generator/);
  });
});

describe("copy (N7/N8), all 7 locales", () => {
  const LOCALES = { en, ko, ja, zh, de, fr, es } as const;
  const KEYS = [
    "pwa.ios.title",
    "pwa.ios.step1",
    "pwa.ios.step2",
    "pwa.ios.step3",
    "pwa.ios.notNow",
    "alertDevices.title",
    "alertDevices.helper",
    "alertDevices.sendTest",
    "alertDevices.remove",
    "alertDevices.phone.notSetUp",
    "alertDevices.phone.setUp",
  ] as const;

  it("ships every key in every locale", () => {
    for (const [code, table] of Object.entries(LOCALES)) {
      for (const key of KEYS) {
        expect((table as Record<string, string>)[key], `${code}:${key}`).toBeTruthy();
      }
    }
  });

  it("uses the locked English copy", () => {
    expect(en["pwa.ios.title"]).toBe("Get urgent mail alerts on this iPhone");
    expect(en["pwa.ios.notNow"]).toBe("Not now");
    expect(en["alertDevices.title"]).toBe("Where you get alerts");
    expect(en["alertDevices.helper"]).toBe(
      "Urgent mail rings on these. Klorn apps alert only while they're running.",
    );
  });

  it("makes no 'coming soon' promise and names no model", () => {
    for (const table of Object.values(LOCALES)) {
      for (const [key, value] of Object.entries(table as Record<string, string>)) {
        if (!/^(alertDevices|pwa\.ios)\./.test(key)) continue;
        expect(value, key).not.toMatch(/coming soon|Claude|Haiku|Opus|GPT|Gemini/i);
      }
    }
  });
});
