"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getStoredAuthToken } from "../lib/api";
import { shellKind } from "../lib/native/shell";

// Match the API default in lib/api.ts so WS and HTTP point at the same host
// in local dev (Klorn API runs on :3001 via docker-compose).
const WS_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001")
  .replace("http://", "ws://")
  .replace("https://", "wss://");

interface WsMessage {
  type: string;
  payload: Record<string, unknown>;
  from?: string;
}

// Heartbeat cadence: ping every 30s; if NOTHING (pong or otherwise) has
// arrived for 45s, treat the socket as half-open and force a reconnect.
// Mirrors the desktop RealtimeClient's 30s ping / timeout pair.
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_SILENCE_LIMIT_MS = 45_000;

export function useWebSocket(userId: string) {
  const [connected, setConnected] = useState(false);
  const [clientId, setClientId] = useState<string | null>(null);
  const [connectedClients, setConnectedClients] = useState<
    Array<{ clientId: string; type: string }>
  >([]);
  const [lastNotification, setLastNotification] = useState<{
    type: string;
    title: string;
    message: string;
    timestamp: string;
  } | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const listenersRef = useRef<Map<string, Set<(payload: Record<string, unknown>) => void>>>(
    new Map(),
  );
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const mountedRef = useRef(true);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastActivityRef = useRef(Date.now());

  const connect = useCallback(() => {
    if (!userId) return;
    if (!mountedRef.current) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    if (wsRef.current?.readyState === WebSocket.CONNECTING) return;

    // Carry the JWT in the Sec-WebSocket-Protocol subprotocol (marker
    // "klorn-ws-v1", matched server-side) instead of a ?token= query param —
    // a query param leaks the long-lived credential into proxy/LB access logs.
    const token = getStoredAuthToken();
    // Inside the Windows desktop wrapper (Tauri) the socket says so, which is
    // how settings → Where you get alerts shows "Klorn for Windows · Running"
    // (api notify/desktop-presence.ts). Every other host is a web tab.
    const clientQuery = shellKind() === "tauri" ? "type=desktop&app=windows" : "type=web";
    const ws = token
      ? new WebSocket(`${WS_URL}/ws?${clientQuery}`, ["klorn-ws-v1", token])
      : new WebSocket(`${WS_URL}/ws?userId=${encodeURIComponent(userId)}&${clientQuery}`);

    ws.onopen = () => {
      if (!mountedRef.current) {
        ws.close();
        return;
      }
      setConnected(true);
      reconnectAttemptsRef.current = 0;
      // Half-open detection (ported from the desktop RealtimeClient, which
      // fixed the 2026-08-06 "web ~1s, desktop stale" miss in the other
      // direction): a socket that sleeps through macOS suspend or a NAT
      // rebind still LOOKS open but receives nothing, silently downgrading
      // every surface to its fallback poll. Ping on an interval; if nothing
      // at all has arrived for ~1.5 intervals, force-close so the normal
      // backoff reconnect takes over. Any inbound frame counts as life —
      // the server answers "ping" with "pong" (websocket.ts handleMessage).
      lastActivityRef.current = Date.now();
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      heartbeatRef.current = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - lastActivityRef.current > HEARTBEAT_SILENCE_LIMIT_MS) {
          ws.close(); // half-open: let onclose schedule the reconnect
          return;
        }
        ws.send(JSON.stringify({ type: "ping", payload: {} }));
      }, HEARTBEAT_INTERVAL_MS);
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;
      lastActivityRef.current = Date.now();
      try {
        const msg: WsMessage = JSON.parse(event.data);

        switch (msg.type) {
          case "connected":
            setClientId((msg.payload as { clientId: string }).clientId);
            setConnectedClients(
              (msg.payload as { connectedClients: Array<{ clientId: string; type: string }> })
                .connectedClients,
            );
            break;
          case "client_joined":
          case "client_left":
          case "client_list":
            if (msg.payload && "clients" in msg.payload) {
              setConnectedClients(msg.payload.clients as Array<{ clientId: string; type: string }>);
            }
            break;
          case "notification":
            setLastNotification(
              msg.payload as { type: string; title: string; message: string; timestamp: string },
            );
            break;
          default:
            break;
        }

        // Dispatch to registered listeners
        const listeners = listenersRef.current.get(msg.type);
        if (listeners) {
          for (const listener of listeners) {
            listener(msg.payload as Record<string, unknown>);
          }
        }
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
      if (!mountedRef.current) return;
      setConnected(false);
      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (cap). Jitter avoids a
      // thundering herd if many clients reconnect at once after a server blip.
      const attempt = reconnectAttemptsRef.current;
      reconnectAttemptsRef.current = attempt + 1;
      const base = Math.min(30_000, 1_000 * 2 ** attempt);
      const delay = base + Math.random() * 1_000;
      reconnectRef.current = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      ws.close();
    };

    wsRef.current = ws;
  }, [userId]);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect]);

  const send = useCallback((type: string, payload: Record<string, unknown> = {}) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type, payload }));
    }
  }, []);

  const on = useCallback((type: string, listener: (payload: Record<string, unknown>) => void) => {
    if (!listenersRef.current.has(type)) {
      listenersRef.current.set(type, new Set());
    }
    listenersRef.current.get(type)?.add(listener);

    return () => {
      listenersRef.current.get(type)?.delete(listener);
    };
  }, []);

  return {
    connected,
    clientId,
    connectedClients,
    lastNotification,
    send,
    on,
  };
}
