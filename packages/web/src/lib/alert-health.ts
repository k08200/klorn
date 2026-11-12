/**
 * Channel health on the web: can Klorn reach this person outside an open tab?
 * Mirrors the API's GET /api/notifications/alert-endpoints/health
 * (api notify/channel-health.ts). Pure decisions only, unit-tested from the api
 * suite (api/src/__tests__/web-alert-health.test.ts); the banner component
 * reads the browser and renders.
 */

export const ALERT_HEALTH_PATH = "/api/notifications/alert-endpoints/health";

export type WebPushChannelState = "live" | "stale" | "needs_resubscribe" | "none";

export interface ChannelHealth {
  webPush: {
    state: WebPushChannelState;
    currentDevice: Exclude<WebPushChannelState, "none"> | null;
  };
  desktop: { app: "mac" | "windows"; running: boolean; lastSeenAt: string }[];
  telegram: { linked: boolean };
  mobile: { registered: boolean };
  working: boolean;
}

const WEB_STATES: readonly string[] = ["live", "stale", "needs_resubscribe", "none"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The API's answer, or null for anything else — a surprise never warns. */
export function parseChannelHealth(value: unknown): ChannelHealth | null {
  if (!isRecord(value) || typeof value.working !== "boolean") return null;
  const { webPush, telegram, mobile, desktop } = value;
  if (!isRecord(webPush) || !WEB_STATES.includes(String(webPush.state))) return null;
  if (webPush.currentDevice !== null && !WEB_STATES.includes(String(webPush.currentDevice))) {
    return null;
  }
  if (!isRecord(telegram) || typeof telegram.linked !== "boolean") return null;
  if (!isRecord(mobile) || typeof mobile.registered !== "boolean") return null;
  if (!Array.isArray(desktop)) return null;
  return value as unknown as ChannelHealth;
}

/** A dismissed "no working channel" warning stays away this long on Today. */
export const NO_CHANNEL_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
export const NO_CHANNEL_DISMISS_KEY = "klorn-no-alert-channel-dismissed-at";

export type AlertHealthBanner = "resubscribe" | "no_channel" | null;

/**
 * Which banner, if any:
 *   resubscribe  this browser's subscription is a zombie and the permission is
 *                already granted — a click replaces it (no prompt, #1716)
 *   no_channel   nothing off-app can reach the person
 * Settings passes `offerResubscribe: false`: its device list carries that
 * button on the row itself.
 */
export function alertHealthBanner(
  health: ChannelHealth | null,
  ctx: {
    permission: NotificationPermission | "unsupported";
    dismissedAt: number | null;
    now: number;
    dismissible: boolean;
    offerResubscribe?: boolean;
  },
): AlertHealthBanner {
  if (!health) return null;
  if (
    ctx.offerResubscribe !== false &&
    health.webPush.currentDevice === "needs_resubscribe" &&
    ctx.permission === "granted"
  ) {
    return "resubscribe";
  }
  if (health.working) return null;
  const snoozed =
    ctx.dismissible && ctx.dismissedAt !== null && ctx.now - ctx.dismissedAt < NO_CHANNEL_SNOOZE_MS;
  return snoozed ? null : "no_channel";
}

const REACHED_DEVICE: readonly string[] = ["device_received", "opened", "actioned"];

/** A delivery's lifecycle stage proves it reached the device. "sent" does not. */
export function hasReachedDevice(state: string | undefined): boolean {
  return state !== undefined && REACHED_DEVICE.includes(state);
}

/** How long "Send test" waits for the device to confirm: 8 × 2 s. */
export const TEST_ARRIVAL_POLL = { intervalMs: 2_000, attempts: 8 } as const;
