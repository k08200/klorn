/**
 * "Where you get alerts" (settings → Notifications, N8): the user's alert
 * endpoints as a client-safe list. Pure: routes/alert-endpoints.ts loads the
 * rows, this shapes them.
 *
 * Privacy contract: the DTO carries ids and labels only. A push endpoint URL is
 * a bearer capability (anyone holding it plus the keys can push to the
 * browser), a device token is the same for FCM/APNs, and the client deviceId is
 * a stable per-browser identifier — none of them leave the server.
 */

import type { NotificationLanguage } from "./notification-strings.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A subscription with no confirmed receipt inside this window is flagged. */
export const ALERT_RECEIPT_WINDOW_MS = 3 * DAY_MS;

export const ALERT_BROWSERS = ["chrome", "edge", "firefox", "safari", "samsung", "opera"] as const;
export const ALERT_OSES = ["ios", "android", "macos", "windows", "linux", "chromeos"] as const;

export type AlertBrowser = (typeof ALERT_BROWSERS)[number];
export type AlertOs = (typeof ALERT_OSES)[number];

const PHONE_OSES: ReadonlySet<AlertOs> = new Set(["ios", "android"]);

export interface ClientPlatform {
  browser: AlertBrowser | null;
  os: AlertOs | null;
}

// Order matters: Edge, Samsung and Opera all also say "Chrome"; Chrome also
// says "Safari"; Android says "Linux"; iPhone says "like Mac OS X".
function browserFromUa(ua: string): AlertBrowser | null {
  if (/\bEdg(e|A|iOS)?\//.test(ua)) return "edge";
  if (/SamsungBrowser\//.test(ua)) return "samsung";
  if (/\bOPR\/|OPiOS\//.test(ua)) return "opera";
  if (/Firefox\/|FxiOS\//.test(ua)) return "firefox";
  if (/Chrome\/|CriOS\//.test(ua)) return "chrome";
  // Safari proper, or an iOS home-screen web app (WebKit with no Safari token).
  if (/AppleWebKit\//.test(ua) && (/Safari\//.test(ua) || /iPhone|iPad|iPod/.test(ua))) {
    return "safari";
  }
  return null;
}

function osFromUa(ua: string): AlertOs | null {
  if (/iPhone|iPad|iPod/.test(ua)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/CrOS/.test(ua)) return "chromeos";
  if (/Windows NT/.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/.test(ua)) return "macos";
  if (/Linux|X11/.test(ua)) return "linux";
  return null;
}

/** Browser and OS of the agent that registered a subscription. */
export function parseClientPlatform(ua: string | undefined | null): ClientPlatform {
  if (!ua) return { browser: null, os: null };
  const os = osFromUa(ua);
  const browser = browserFromUa(ua);
  // An agent with neither is not a browser we can name (curl, a bot).
  if (!browser) return { browser: null, os: os && /Mozilla\//.test(ua) ? os : null };
  return { browser, os };
}

/** The browser family a push service belongs to — for rows stored before the
 *  subscribing browser was recorded. */
export function browserFromPushHost(endpoint: string): AlertBrowser | null {
  let host: string;
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === "fcm.googleapis.com" || host === "android.googleapis.com") return "chrome";
  if (host.endsWith(".push.services.mozilla.com")) return "firefox";
  if (host === "web.push.apple.com" || host.endsWith(".push.apple.com")) return "safari";
  if (host.endsWith(".notify.windows.com")) return "edge";
  return null;
}

export type WebPushHealth = "ok" | "new" | "stale";

/**
 * ok: a receipt came back inside the window. new: the subscription is younger
 * than the window and has none yet, so silence says nothing. stale: no receipt
 * confirmed in the window — the row offers "Send test".
 */
export function webPushHealth(input: {
  createdAt: number;
  lastReceivedAt: number | null;
  now: number;
}): WebPushHealth {
  const { createdAt, lastReceivedAt, now } = input;
  if (lastReceivedAt !== null && now - lastReceivedAt <= ALERT_RECEIPT_WINDOW_MS) return "ok";
  if (lastReceivedAt === null && now - createdAt < ALERT_RECEIPT_WINDOW_MS) return "new";
  return "stale";
}

export type DesktopApp = "mac" | "windows";

export interface DesktopPresence {
  app: DesktopApp;
  running: boolean;
  lastSeenAt: number;
}

export interface WebSubscriptionRow {
  id: string;
  endpoint: string;
  deviceId: string | null;
  browser: string | null;
  os: string | null;
  createdAt: Date;
  needsResubscribeAt?: Date | null;
}

export interface NativeTokenRow {
  id: string;
  platform: string;
  updatedAt: Date;
}

export type AlertEndpointDTO =
  | {
      kind: "web";
      id: string;
      browser: AlertBrowser | null;
      os: AlertOs | null;
      /** This row is the browser making the request. */
      current: boolean;
      createdAt: string;
      lastReceivedAt: string | null;
      health: WebPushHealth;
      /** A zombie (notify/push-zombie.ts): the push service accepts, the
       *  device confirms nothing. Turning alerts back on replaces it. */
      needsResubscribe: boolean;
    }
  | { kind: "native"; id: string; platform: "android" | "ios"; registeredAt: string }
  | { kind: "desktop"; app: DesktopApp; running: boolean; lastSeenAt: string };

export interface AlertEndpointList {
  endpoints: AlertEndpointDTO[];
  /** Some endpoint rings a phone: a phone browser subscription or a native token. */
  phoneConfigured: boolean;
}

function knownBrowser(value: string | null): AlertBrowser | null {
  return (ALERT_BROWSERS as readonly string[]).includes(value ?? "")
    ? (value as AlertBrowser)
    : null;
}

function knownOs(value: string | null): AlertOs | null {
  return (ALERT_OSES as readonly string[]).includes(value ?? "") ? (value as AlertOs) : null;
}

function toWebDto(
  row: WebSubscriptionRow,
  lastReceived: Date | undefined,
  currentDeviceId: string | undefined,
  now: number,
): AlertEndpointDTO {
  const lastReceivedAt = lastReceived?.getTime() ?? null;
  return {
    kind: "web",
    id: row.id,
    browser: knownBrowser(row.browser) ?? browserFromPushHost(row.endpoint),
    os: knownOs(row.os),
    current: Boolean(currentDeviceId) && row.deviceId === currentDeviceId,
    createdAt: row.createdAt.toISOString(),
    lastReceivedAt: lastReceived ? lastReceived.toISOString() : null,
    health: webPushHealth({ createdAt: row.createdAt.getTime(), lastReceivedAt, now }),
    needsResubscribe: Boolean(row.needsResubscribeAt),
  };
}

export function buildAlertEndpoints(input: {
  web: WebSubscriptionRow[];
  native: NativeTokenRow[];
  desktop: DesktopPresence[];
  lastReceivedBySubscription: ReadonlyMap<string, Date>;
  currentDeviceId?: string;
  now: number;
}): AlertEndpointList {
  const web = input.web.map((row) =>
    toWebDto(row, input.lastReceivedBySubscription.get(row.id), input.currentDeviceId, input.now),
  );
  const native: AlertEndpointDTO[] = input.native
    .filter((row) => row.platform === "android" || row.platform === "ios")
    .map((row) => ({
      kind: "native",
      id: row.id,
      platform: row.platform as "android" | "ios",
      registeredAt: row.updatedAt.toISOString(),
    }));
  const desktop: AlertEndpointDTO[] = input.desktop.map((d) => ({
    kind: "desktop",
    app: d.app,
    running: d.running,
    lastSeenAt: new Date(d.lastSeenAt).toISOString(),
  }));
  const phoneConfigured =
    native.length > 0 || web.some((e) => e.kind === "web" && e.os !== null && PHONE_OSES.has(e.os));
  return { endpoints: [...web, ...native, ...desktop], phoneConfigured };
}

/** "Send test" copy, in the user's notification language. Typed by the
 *  language union, so a new language fails the build until it is added here. */
const ALERT_TEST_COPY: Record<NotificationLanguage, { title: string; body: string }> = {
  en: { title: "Klorn test alert", body: "Alerts reach this device." },
  ko: { title: "Klorn 테스트 알림", body: "이 기기로 알림이 도착합니다." },
  ja: { title: "Klorn テスト通知", body: "このデバイスに通知が届きます。" },
  zh: { title: "Klorn 测试提醒", body: "提醒可以送达此设备。" },
  es: { title: "Alerta de prueba de Klorn", body: "Las alertas llegan a este dispositivo." },
  fr: { title: "Alerte d’essai Klorn", body: "Les alertes arrivent sur cet appareil." },
  de: {
    title: "Klorn-Testbenachrichtigung",
    body: "Benachrichtigungen kommen auf diesem Gerät an.",
  },
};

export function alertTestCopy(
  language: NotificationLanguage,
  url: string,
): { title: string; body: string; url: string } {
  return { ...(ALERT_TEST_COPY[language] ?? ALERT_TEST_COPY.en), url };
}
