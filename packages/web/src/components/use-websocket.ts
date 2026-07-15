"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getStoredAuthToken } from "../lib/api";

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

  const connect = useCallback(() => {
    if (!userId) return;
    if (!mountedRef.current) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    if (wsRef.current?.readyState === WebSocket.CONNECTING) return;

    // Carry the JWT in the Sec-WebSocket-Protocol subprotocol (marker
    // "klorn-ws-v1", matched server-side) instead of a ?token= query param —
    // a query param leaks the long-lived credential into proxy/LB access logs.
    const token = getStoredAuthToken();
    const ws = token
      ? new WebSocket(`${WS_URL}/ws?type=web`, ["klorn-ws-v1", token])
      : new WebSocket(`${WS_URL}/ws?userId=${encodeURIComponent(userId)}&type=web`);

    ws.onopen = () => {
      if (!mountedRef.current) {
        ws.close();
        return;
      }
      setConnected(true);
      reconnectAttemptsRef.current = 0;
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;
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
