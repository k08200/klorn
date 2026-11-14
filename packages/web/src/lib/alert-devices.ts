/**
 * Pure UI decisions for phone alerts (N7) and "Where you get alerts" (N8).
 * The components read the browser and render; everything that decides lives
 * here so it is unit-tested (api/src/__tests__/web-alert-devices.test.ts).
 */

/** What the phone-setup QR code opens. Encoded in the browser, never sent out. */
export const PHONE_SETUP_URL = "https://app.klorn.ai";

const IOS_DEVICE = /iPad|iPhone|iPod/;

/**
 * Whether the "Allow notifications" banner may run on this platform.
 * iOS delivers web push only to a Home Screen web app — pushManager.subscribe()
 * throws in a Safari tab — so an iOS tab gets the home-screen card instead
 * (IosInstallHint) and the installed app gets this banner. Desktop and Android
 * browsers subscribe from a normal tab. The native shell uses FCM/APNs.
 */
export function shouldOfferPushBanner(ctx: {
  userAgent: string;
  standalone: boolean;
  native: boolean;
}): boolean {
  if (ctx.native) return false;
  if (IOS_DEVICE.test(ctx.userAgent) && !ctx.standalone) return false;
  return true;
}

// ── Alert endpoint list (mirror of the API DTO, notify/alert-endpoints.ts) ──

export type AlertBrowser = "chrome" | "edge" | "firefox" | "safari" | "samsung" | "opera";
export type AlertOs = "ios" | "android" | "macos" | "windows" | "linux" | "chromeos";

export type AlertEndpoint =
  | {
      kind: "web";
      id: string;
      browser: AlertBrowser | null;
      os: AlertOs | null;
      current: boolean;
      createdAt: string;
      lastReceivedAt: string | null;
      health: "ok" | "new" | "stale";
      /** A zombie: the push service accepts, this device confirms nothing.
       *  Absent from an API that predates it. */
      needsResubscribe?: boolean;
    }
  | { kind: "native"; id: string; platform: "android" | "ios"; registeredAt: string }
  | { kind: "desktop"; app: "mac" | "windows"; running: boolean; lastSeenAt: string };

export interface AlertEndpointList {
  endpoints: AlertEndpoint[];
  phoneConfigured: boolean;
}

// Product and platform names are proper nouns: the same in every locale.
const BROWSER_NAMES: Record<AlertBrowser, string> = {
  chrome: "Chrome",
  edge: "Edge",
  firefox: "Firefox",
  safari: "Safari",
  samsung: "Samsung Internet",
  opera: "Opera",
};

const OS_NAMES: Record<AlertOs, string> = {
  ios: "iPhone",
  android: "Android",
  macos: "Mac",
  windows: "Windows",
  linux: "Linux",
  chromeos: "ChromeOS",
};

export interface I18nRef {
  key: string;
  params: Record<string, string>;
}

/** The row's name as an i18n key + params. */
export function alertEndpointName(e: AlertEndpoint): I18nRef {
  if (e.kind === "native") {
    return {
      key: e.platform === "ios" ? "alertDevices.name.iphoneApp" : "alertDevices.name.androidApp",
      params: {},
    };
  }
  if (e.kind === "desktop") {
    return {
      key: e.app === "windows" ? "alertDevices.name.windowsApp" : "alertDevices.name.macApp",
      params: {},
    };
  }
  // On iOS every subscription is a Home Screen web app, whatever the engine.
  if (e.os === "ios") return { key: "alertDevices.name.iphoneWeb", params: {} };
  if (e.browser && e.os) {
    return {
      key: "alertDevices.name.web",
      params: { browser: BROWSER_NAMES[e.browser], os: OS_NAMES[e.os] },
    };
  }
  if (e.browser) {
    return { key: "alertDevices.name.browserOnly", params: { browser: BROWSER_NAMES[e.browser] } };
  }
  return { key: "alertDevices.name.unknownBrowser", params: {} };
}

export type AlertTone = "ok" | "warn" | "neutral" | "off";

export interface AlertRowStatus {
  /** Colour of the dot. Always paired with the text — never colour alone. */
  tone: AlertTone;
  /** Status text key; takes an `{ago}` param when `at` is set. */
  key: string;
  at: string | null;
}

export function alertRowStatus(e: AlertEndpoint): AlertRowStatus {
  if (e.kind === "native") {
    return { tone: "neutral", key: "alertDevices.status.registered", at: e.registeredAt };
  }
  if (e.kind === "desktop") {
    return e.running
      ? { tone: "ok", key: "alertDevices.status.running", at: e.lastSeenAt }
      : { tone: "off", key: "alertDevices.status.notRunning", at: e.lastSeenAt };
  }
  if (e.needsResubscribe) {
    return {
      tone: "warn",
      key: e.current
        ? "alertDevices.status.needsResubscribe"
        : "alertDevices.status.needsResubscribeElsewhere",
      at: e.lastReceivedAt,
    };
  }
  if (e.health === "ok") {
    return { tone: "ok", key: "alertDevices.status.delivered", at: e.lastReceivedAt };
  }
  if (e.health === "new")
    return { tone: "neutral", key: "alertDevices.status.new", at: e.createdAt };
  return e.lastReceivedAt
    ? { tone: "warn", key: "alertDevices.status.staleSince", at: e.lastReceivedAt }
    : { tone: "warn", key: "alertDevices.status.staleNever", at: null };
}

/** Rows that take "Send test" / "Remove" (desktop apps have no push channel). */
export function isPushEndpoint(
  e: AlertEndpoint,
): e is Extract<AlertEndpoint, { kind: "web" | "native" }> {
  return e.kind !== "desktop";
}

// ── Notification center footer: "Where you get alerts" in one line ──

export interface AlertStripItem {
  id: string;
  /** Short channel name ("Mac app", "Chrome", "Phone"). */
  name: I18nRef;
  /** Dot colour; always next to `statusKey` text, never alone. */
  tone: AlertTone;
  statusKey: string;
}

const PHONE_OS: readonly (AlertOs | null)[] = ["ios", "android"];
const TONE_RANK: Record<AlertTone, number> = { ok: 3, neutral: 2, warn: 1, off: 0 };
const TONE_STATUS: Record<AlertTone, string> = {
  ok: "notifCenter.status.ok",
  neutral: "notifCenter.status.new",
  warn: "notifCenter.status.check",
  off: "notifCenter.status.notConnected",
};

function webTone(e: Extract<AlertEndpoint, { kind: "web" }>): AlertTone {
  if (e.needsResubscribe || e.health === "stale") return "warn";
  return e.health === "ok" ? "ok" : "neutral";
}

function better(a: AlertTone | undefined, b: AlertTone): AlertTone {
  return a !== undefined && TONE_RANK[a] >= TONE_RANK[b] ? a : b;
}

/**
 * One item per desktop app, one per browser (the best of its endpoints) and
 * always one for the phone, so "phone not connected" is visible too.
 */
export function alertStripItems(list: AlertEndpointList): AlertStripItem[] {
  const desktop: AlertStripItem[] = [];
  const browsers = new Map<string, AlertTone>();
  let phone: AlertTone | undefined;
  for (const e of list.endpoints) {
    if (e.kind === "desktop") {
      if (desktop.some((d) => d.id === e.app)) continue;
      desktop.push({
        id: e.app,
        name: { key: `notifCenter.device.${e.app}`, params: {} },
        tone: e.running ? "ok" : "off",
        statusKey: e.running ? "notifCenter.status.running" : "notifCenter.status.notRunning",
      });
    } else if (e.kind === "native") {
      phone = better(phone, "ok");
    } else if (PHONE_OS.includes(e.os)) {
      phone = better(phone, webTone(e));
    } else {
      const name = e.browser ? BROWSER_NAMES[e.browser] : "";
      browsers.set(name, better(browsers.get(name), webTone(e)));
    }
  }
  const web = [...browsers].map(
    ([browser, tone]): AlertStripItem => ({
      id: `web:${browser}`,
      name: browser
        ? { key: "alertDevices.name.browserOnly", params: { browser } }
        : { key: "alertDevices.name.unknownBrowser", params: {} },
      tone,
      statusKey: TONE_STATUS[tone],
    }),
  );
  const phoneTone = phone ?? "off";
  return [
    ...desktop,
    ...web,
    {
      id: "phone",
      name: { key: "notifCenter.device.phone", params: {} },
      tone: phoneTone,
      statusKey: TONE_STATUS[phoneTone],
    },
  ];
}
