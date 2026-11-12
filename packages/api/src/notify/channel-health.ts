/**
 * Channel health: can Klorn reach this person when no Klorn tab is open?
 * Pure — routes/alert-endpoints.ts (GET /health) loads the rows.
 *
 * A channel counts as working unless it is absent or proven dead:
 *   web push   live (receipt within ALERT_RECEIPT_WINDOW_MS, or too new to
 *              judge), stale (no receipt in that window — maybe nothing was
 *              sent), needs_resubscribe (every subscription is a flagged zombie,
 *              push-zombie.ts), none. Live and stale count; the others do not.
 *   desktop    a Mac / Windows app running now, or seen within
 *              DESKTOP_RECENT_MS (its socket or its last banner receipt)
 *   telegram   a linked chat on a server with Telegram configured
 *   mobile     a registered FCM / APNs token
 *
 * The client gets states and booleans only, never an endpoint, token or chat id.
 */

import { type DesktopApp, type DesktopPresence, webPushHealth } from "./alert-endpoints.js";
import type { DeliveryChannel } from "./delivery-lifecycle.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A desktop app not seen for this long is not counted as a way to reach you. */
export const DESKTOP_RECENT_MS = 7 * DAY_MS;

export type WebPushChannelState = "live" | "stale" | "needs_resubscribe" | "none";

export interface ChannelHealthWebRow {
  row: {
    id: string;
    deviceId: string | null;
    createdAt: Date;
    needsResubscribeAt: Date | null;
  };
  lastReceivedAt: Date | null;
}

export interface ChannelHealth {
  webPush: {
    state: WebPushChannelState;
    /** This browser's own subscription (by the x-push-device id); null if none. */
    currentDevice: Exclude<WebPushChannelState, "none"> | null;
  };
  desktop: { app: DesktopApp; running: boolean; lastSeenAt: string }[];
  telegram: { linked: boolean };
  mobile: { registered: boolean };
  /** Some off-app channel can reach the person. */
  working: boolean;
}

const RANK: Record<WebPushChannelState, number> = {
  live: 3,
  stale: 2,
  needs_resubscribe: 1,
  none: 0,
};

function subscriptionState(
  web: ChannelHealthWebRow,
  now: number,
): Exclude<WebPushChannelState, "none"> {
  if (web.row.needsResubscribeAt) return "needs_resubscribe";
  const health = webPushHealth({
    createdAt: web.row.createdAt.getTime(),
    lastReceivedAt: web.lastReceivedAt?.getTime() ?? null,
    now,
  });
  return health === "stale" ? "stale" : "live";
}

export function buildChannelHealth(input: {
  web: ChannelHealthWebRow[];
  nativeTokens: number;
  telegramLinked: boolean;
  desktop: DesktopPresence[];
  currentDeviceId: string | undefined;
  now: number;
}): ChannelHealth {
  const states = input.web.map((w) => ({ w, state: subscriptionState(w, input.now) }));
  const state = states.reduce<WebPushChannelState>(
    (best, s) => (RANK[s.state] > RANK[best] ? s.state : best),
    "none",
  );
  const current = input.currentDeviceId
    ? states.find((s) => s.w.row.deviceId === input.currentDeviceId)
    : undefined;
  const desktop = input.desktop.map((d) => ({
    app: d.app,
    running: d.running,
    lastSeenAt: new Date(d.lastSeenAt).toISOString(),
  }));
  const desktopWorking = input.desktop.some(
    (d) => d.running || input.now - d.lastSeenAt <= DESKTOP_RECENT_MS,
  );
  const mobile = input.nativeTokens > 0;
  return {
    webPush: { state, currentDevice: current?.state ?? null },
    desktop,
    telegram: { linked: input.telegramLinked },
    mobile: { registered: mobile },
    working:
      state === "live" || state === "stale" || desktopWorking || input.telegramLinked || mobile,
  };
}

const APP_BY_CHANNEL: Partial<Record<DeliveryChannel, DesktopApp>> = {
  desktop_mac: "mac",
  desktop_windows: "windows",
};

/**
 * A desktop app as seen by this process's sockets (desktop-presence.ts, lost on
 * restart) and by its last banner receipt (persistent): running from the
 * socket, last seen from whichever is later.
 */
export function mergeDesktopSightings(
  presence: DesktopPresence[],
  receipts: { channel: string; lastAt: Date | null }[],
): DesktopPresence[] {
  const byApp = new Map<DesktopApp, DesktopPresence>(presence.map((p) => [p.app, { ...p }]));
  for (const r of receipts) {
    const app = APP_BY_CHANNEL[r.channel as DeliveryChannel];
    if (!app || !r.lastAt) continue;
    const seen = byApp.get(app);
    const lastAt = r.lastAt.getTime();
    byApp.set(app, {
      app,
      running: seen?.running ?? false,
      lastSeenAt: Math.max(seen?.lastSeenAt ?? 0, lastAt),
    });
  }
  return [...byApp.values()];
}
