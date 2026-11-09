/**
 * Which Klorn desktop apps a user has running, for "Where you get alerts" (N8).
 *
 * The desktop apps hold no push token: the Mac app keeps a WebSocket open to
 * the hub (`/ws?type=desktop`, RealtimeClient.swift) and the Windows wrapper
 * runs the web app, which tags its socket `type=desktop&app=windows`. The hub
 * reports each open and close here.
 *
 * In memory, per API process, by design — no table for a liveness hint:
 *   - running is exact while this process holds the socket;
 *   - "last seen" after a close survives only until the process restarts, so
 *     after a deploy an app that is not running simply drops off the list;
 *   - with more than one API instance, each sees only its own sockets.
 *   - a half-open socket (sleep, network drop) still counts as running until
 *     the socket closes or errors; the hub runs no server-side heartbeat sweep.
 */

import type { DesktopApp, DesktopPresence } from "./alert-endpoints.js";

export type WsClientType = "web" | "desktop" | "widget";

const WS_CLIENT_TYPES: ReadonlySet<string> = new Set(["web", "desktop", "widget"]);

/** The `type` query param of a /ws connection; anything unexpected is a web tab. */
export function parseWsClientType(raw: string | null): WsClientType {
  return raw !== null && WS_CLIENT_TYPES.has(raw) ? (raw as WsClientType) : "web";
}

/** The `app` query param of a desktop socket. The Mac app sends none. */
export function parseWsClientApp(raw: string | null): DesktopApp {
  return raw === "windows" ? "windows" : "mac";
}

interface AppState {
  sockets: Set<string>;
  lastSeenAt: number;
}

export function createDesktopPresence() {
  const byUser = new Map<string, Map<DesktopApp, AppState>>();
  const socketOwner = new Map<string, { userId: string; app: DesktopApp }>();

  return {
    connected(userId: string, clientId: string, app: DesktopApp, now: number): void {
      const apps = byUser.get(userId) ?? new Map<DesktopApp, AppState>();
      const state = apps.get(app) ?? { sockets: new Set<string>(), lastSeenAt: now };
      state.sockets.add(clientId);
      state.lastSeenAt = now;
      apps.set(app, state);
      byUser.set(userId, apps);
      socketOwner.set(clientId, { userId, app });
    },

    disconnected(userId: string, clientId: string, now: number): void {
      const owner = socketOwner.get(clientId);
      if (!owner || owner.userId !== userId) return;
      socketOwner.delete(clientId);
      const state = byUser.get(userId)?.get(owner.app);
      if (!state) return;
      state.sockets.delete(clientId);
      state.lastSeenAt = now;
    },

    list(userId: string, now: number): DesktopPresence[] {
      const apps = byUser.get(userId);
      if (!apps) return [];
      return [...apps.entries()].map(([app, state]) => {
        const running = state.sockets.size > 0;
        return { app, running, lastSeenAt: running ? now : state.lastSeenAt };
      });
    },
  };
}

/** The hub's single instance (websocket.ts writes, the alert-endpoints route reads). */
export const desktopPresence = createDesktopPresence();
