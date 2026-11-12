// The web side of channel health (GET /api/notifications/alert-endpoints/health):
// which banner Today / Settings show, the zombie row in "Where you get alerts",
// whether a "Send test" reached the device, the re-subscribe flow (a click,
// never a permission prompt — #1716), and the service worker's action receipt.
// Run from the api suite because the web package has no unit-test runner.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type AlertEndpoint, alertRowStatus } from "../../../web/src/lib/alert-devices";
import {
  alertHealthBanner,
  type ChannelHealth,
  hasReachedDevice,
  NO_CHANNEL_SNOOZE_MS,
  parseChannelHealth,
} from "../../../web/src/lib/alert-health";
import de from "../../../web/src/lib/locales/de";
import en from "../../../web/src/lib/locales/en";
import es from "../../../web/src/lib/locales/es";
import fr from "../../../web/src/lib/locales/fr";
import ja from "../../../web/src/lib/locales/ja";
import ko from "../../../web/src/lib/locales/ko";
import zh from "../../../web/src/lib/locales/zh";

const WEB = join(__dirname, "../../../web");
const NOW = Date.parse("2026-11-12T00:00:00Z");

function health(overrides: Partial<ChannelHealth> = {}): ChannelHealth {
  return {
    webPush: { state: "none", currentDevice: null },
    desktop: [],
    telegram: { linked: false },
    mobile: { registered: false },
    working: false,
    ...overrides,
  };
}

const ctx = { permission: "default" as const, dismissedAt: null, now: NOW, dismissible: true };

describe("alertHealthBanner", () => {
  it("shows nothing until the health is known (an older API answers 404)", () => {
    expect(alertHealthBanner(null, ctx)).toBeNull();
  });

  it("warns when no off-app channel can reach the person", () => {
    expect(alertHealthBanner(health(), ctx)).toBe("no_channel");
  });

  it("shows nothing when some channel works", () => {
    expect(
      alertHealthBanner(health({ working: true, telegram: { linked: true } }), ctx),
    ).toBeNull();
  });

  it("offers to turn this browser's alerts back on when its subscription is a zombie", () => {
    const zombie = health({
      webPush: { state: "needs_resubscribe", currentDevice: "needs_resubscribe" },
    });
    expect(alertHealthBanner(zombie, { ...ctx, permission: "granted" })).toBe("resubscribe");
  });

  it("does not offer re-subscribe without a granted permission (no prompt from here)", () => {
    const zombie = health({
      webPush: { state: "needs_resubscribe", currentDevice: "needs_resubscribe" },
    });
    expect(alertHealthBanner(zombie, { ...ctx, permission: "denied" })).toBe("no_channel");
  });

  it("can leave re-subscribe to the Settings list", () => {
    const zombie = health({
      webPush: { state: "needs_resubscribe", currentDevice: "needs_resubscribe" },
      working: true,
    });
    expect(
      alertHealthBanner(zombie, { ...ctx, permission: "granted", offerResubscribe: false }),
    ).toBeNull();
  });

  it("a dismissed no-channel warning stays away for a week, then returns", () => {
    expect(alertHealthBanner(health(), { ...ctx, dismissedAt: NOW - 1000 })).toBeNull();
    expect(
      alertHealthBanner(health(), { ...ctx, dismissedAt: NOW - NO_CHANNEL_SNOOZE_MS - 1 }),
    ).toBe("no_channel");
  });

  it("treats a dismissal dated in the future as no dismissal (a wrong clock never mutes it)", () => {
    expect(alertHealthBanner(health(), { ...ctx, dismissedAt: NOW + 60_000 })).toBe("no_channel");
  });

  it("stays out of the phone app: it reaches the person by native push", () => {
    expect(alertHealthBanner(health(), { ...ctx, native: true })).toBeNull();
  });

  it("ignores a dismissal where the warning is not dismissible (Settings)", () => {
    expect(
      alertHealthBanner(health(), { ...ctx, dismissible: false, dismissedAt: NOW - 1000 }),
    ).toBe("no_channel");
  });
});

describe("parseChannelHealth", () => {
  it("accepts the API shape", () => {
    expect(parseChannelHealth(health())).toEqual(health());
  });

  it("rejects anything else, so a surprise never shows a warning", () => {
    expect(parseChannelHealth(undefined)).toBeNull();
    expect(parseChannelHealth({ error: "Not Found" })).toBeNull();
    expect(parseChannelHealth({ ...health(), working: "no" })).toBeNull();
    expect(parseChannelHealth({ ...health(), webPush: { state: "gone" } })).toBeNull();
  });
});

describe("hasReachedDevice", () => {
  it("is true from device_received on, never for sent", () => {
    expect(hasReachedDevice("device_received")).toBe(true);
    expect(hasReachedDevice("opened")).toBe(true);
    expect(hasReachedDevice("actioned")).toBe(true);
    expect(hasReachedDevice("sent")).toBe(false);
    expect(hasReachedDevice("queued")).toBe(false);
    expect(hasReachedDevice(undefined)).toBe(false);
  });
});

describe("alertRowStatus for a zombie subscription", () => {
  const row: AlertEndpoint = {
    kind: "web",
    id: "s1",
    browser: "chrome",
    os: "macos",
    current: true,
    createdAt: "2026-10-01T00:00:00Z",
    lastReceivedAt: null,
    health: "stale",
    needsResubscribe: true,
  };

  it("says alerts stopped arriving here, on this browser", () => {
    expect(alertRowStatus(row)).toEqual({
      tone: "warn",
      key: "alertDevices.status.needsResubscribe",
      at: null,
    });
  });

  it("points to the other device for any other row", () => {
    expect(alertRowStatus({ ...row, current: false }).key).toBe(
      "alertDevices.status.needsResubscribeElsewhere",
    );
  });

  it("keeps the old reading for a row from an API without the field", () => {
    const { needsResubscribe: _omit, ...older } = row;
    expect(alertRowStatus(older as AlertEndpoint).key).toBe("alertDevices.status.staleNever");
  });
});

describe("re-subscribe flow (lib/push.ts)", () => {
  const src = readFileSync(join(WEB, "src/lib/push.ts"), "utf8");
  const fn = src.slice(src.indexOf("export async function resubscribeThisBrowser"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));

  it("exists", () => {
    expect(body.length).toBeGreaterThan(50);
  });

  it("never prompts: it needs a permission that is already granted", () => {
    expect(body).not.toMatch(/requestPermission/);
    expect(body).toMatch(/Notification\.permission !== "granted"/);
  });

  it("builds the key before dropping the old subscription, and retries the subscribe once", () => {
    expect(body.indexOf("urlBase64ToUint8Array(")).toBeLessThan(body.indexOf(".unsubscribe()"));
    expect(body.match(/pushManager\.subscribe\(/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(body).toMatch(/return "failed"/);
  });

  it("drops the old subscription before making a new one, and tells the server", () => {
    expect(body.indexOf(".unsubscribe()")).toBeGreaterThan(-1);
    expect(body.indexOf(".unsubscribe()")).toBeLessThan(body.indexOf("pushManager.subscribe("));
    expect(body).toMatch(/resubscribed: true/);
  });
});

describe("service worker action receipt", () => {
  const sw = readFileSync(join(WEB, "public/sw.js"), "utf8");

  it("reports an action button as actioned, with the action", () => {
    expect(sw).toMatch(/sendPushReceipt\(data, "actioned", event\.action\)/);
    expect(sw).toMatch(/JSON\.stringify\(action \? \{ event, action \} : \{ event \}\)/);
  });
});

describe("copy, all 7 locales", () => {
  const LOCALES = { en, ko, ja, zh, de, fr, es } as const;
  const KEYS = [
    "alertHealth.noChannel.title",
    "alertHealth.noChannel.body",
    "alertHealth.noChannel.action",
    "alertHealth.noChannel.dismiss",
    "alertHealth.resubscribe.title",
    "alertHealth.resubscribe.body",
    "alertHealth.resubscribe.action",
    "alertHealth.resubscribe.working",
    "alertHealth.resubscribe.done",
    "alertHealth.resubscribe.failed",
    "alertHealth.resubscribe.error",
    "alertDevices.status.needsResubscribe",
    "alertDevices.status.needsResubscribeElsewhere",
    "alertDevices.resubscribe",
    "alertDevices.toast.testArrived",
    "alertDevices.toast.testNoReceipt",
  ] as const;

  it("ships every key in every locale", () => {
    for (const [code, table] of Object.entries(LOCALES)) {
      for (const key of KEYS) {
        expect((table as Record<string, string>)[key], `${code}:${key}`).toBeTruthy();
      }
    }
  });

  it("uses the locked English copy", () => {
    expect(en["alertHealth.noChannel.title"]).toBe("Urgent mail can't reach you outside Klorn");
    expect(en["alertHealth.resubscribe.title"]).toBe("Alerts stopped reaching this browser");
    expect(en["alertHealth.resubscribe.action"]).toBe("Turn alerts back on");
  });

  it("names no lane, makes no 'coming soon' promise and names no model", () => {
    for (const table of Object.values(LOCALES)) {
      for (const [key, value] of Object.entries(table as Record<string, string>)) {
        if (!KEYS.includes(key as (typeof KEYS)[number])) continue;
        expect(value, key).not.toMatch(/coming soon|Claude|Haiku|Opus|GPT|Gemini/i);
        expect(value, key).not.toMatch(/\b(PUSH|MEETING|QUEUE|INFO|SILENT|AUTO|CALL)\b/);
      }
    }
  });
});
