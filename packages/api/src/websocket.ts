/**
 * WebSocket Hub — Real-time communication layer
 *
 * Enables:
 * - Real-time notifications push to all connected clients
 * - Multi-tab coordination (tabs can see each other's state)
 * - Desktop widget live updates
 * - Voice command streaming
 */

import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  isDemoAccessEnabled,
  isDeviceSessionValid,
  sessionRevokedForToken,
  verifyToken,
} from "./auth.js";

interface WsClient {
  ws: WebSocket;
  userId: string;
  clientId: string;
  type: "web" | "desktop" | "widget";
  connectedAt: number;
}

interface WsMessage {
  type: string;
  payload: unknown;
  from?: string;
}

const clients: Map<string, WsClient> = new Map();

let wss: WebSocketServer | null = null;

/** Subprotocol marker that carries the auth JWT out of the URL. The client
 *  offers ["klorn-ws-v1", <jwt>] as its Sec-WebSocket-Protocol; the server
 *  selects only the marker back and reads the JWT from the value after it. */
export const WS_AUTH_SUBPROTOCOL = "klorn-ws-v1";

/**
 * Pull the auth JWT from a Sec-WebSocket-Protocol header when the client used
 * the subprotocol relay (token as the value right after the marker). Returns
 * null if the marker is absent, so the caller can fall back to the legacy
 * ?token= query param. Keeping the JWT in a header rather than the URL stops
 * the long-lived credential from landing in proxy/LB access logs.
 */
export function extractWsSubprotocolToken(header: string | string[] | undefined): string | null {
  if (!header) return null;
  const parts = (Array.isArray(header) ? header.join(",") : header)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const idx = parts.indexOf(WS_AUTH_SUBPROTOCOL);
  if (idx === -1) return null;
  return parts[idx + 1] ?? null;
}

/** Initialize WebSocket server attached to existing HTTP server */
export function initWebSocket(server: Server): WebSocketServer {
  wss = new WebSocketServer({
    server,
    path: "/ws",
    // Accept the auth marker subprotocol so clients can carry the JWT in the
    // Sec-WebSocket-Protocol header instead of the URL. Only ever select the
    // marker back — never echo the token. Clients that offer no subprotocol
    // (legacy query-param path) negotiate none and still connect.
    handleProtocols: (protocols: Set<string>) =>
      protocols.has(WS_AUTH_SUBPROTOCOL) ? WS_AUTH_SUBPROTOCOL : false,
  });

  wss.on("connection", async (ws, req) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const clientType = (url.searchParams.get("type") || "web") as WsClient["type"];

    // Authenticate. Prefer the JWT from the Sec-WebSocket-Protocol subprotocol
    // (keeps the credential out of the URL and access logs); fall back to the
    // ?token= query param for native clients not yet migrated to the relay, and
    // finally to userId for the demo-only backward-compat path.
    let userId: string;
    const token =
      extractWsSubprotocolToken(req.headers["sec-websocket-protocol"]) ||
      url.searchParams.get("token");
    if (token) {
      try {
        const payload = verifyToken(token);
        // Mirror requireAuth: a bare verifyToken only checks signature+expiry.
        // Also reject a token invalidated by a device-kick (another login) or a
        // global revocation (password reset), else a revoked token keeps
        // streaming the user's real-time notification payloads.
        const [deviceValid, revoked] = await Promise.all([
          isDeviceSessionValid(token),
          sessionRevokedForToken(payload),
        ]);
        if (!deviceValid || revoked) {
          ws.close(4001, "Session expired. Please log in again.");
          return;
        }
        userId = payload.userId;
      } catch (err) {
        // Log a signal: this now also covers two DB-backed checks (device
        // session + revocation), so a DB blip must not be indistinguishable
        // from routine invalid-token noise with zero trace.
        console.warn("[WS] auth check failed — closing socket:", err);
        ws.close(4001, "Invalid or expired token");
        return;
      }
    } else {
      // Unauthenticated demo-user is OFF in production. Same single predicate as
      // every HTTP demo path (getUserId, ensureDemoUser, /login) so the gates
      // can't drift. Without it a tokenless client must not connect.
      const demoAllowed = isDemoAccessEnabled();
      const rawUserId = url.searchParams.get("userId");
      if (!demoAllowed || (rawUserId && rawUserId !== "demo-user")) {
        ws.close(4001, "Authentication required — use token parameter");
        return;
      }
      userId = "demo-user";
    }
    const clientId = `${userId}-${clientType}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const client: WsClient = {
      ws,
      userId,
      clientId,
      type: clientType,
      connectedAt: Date.now(),
    };

    clients.set(clientId, client);
    console.log(`[WS] Client connected: ${clientId} (${clientType})`);

    // Send welcome message with client info
    ws.send(
      JSON.stringify({
        type: "connected",
        payload: {
          clientId,
          connectedClients: getConnectedClients(userId),
        },
      }),
    );

    // Broadcast to other clients that a new client joined
    broadcastToUser(
      userId,
      {
        type: "client_joined",
        payload: { clientId, clientType },
      },
      clientId,
    );

    ws.on("message", (data) => {
      try {
        const msg: WsMessage = JSON.parse(data.toString());
        handleMessage(client, msg);
      } catch {
        // ignore malformed messages
      }
    });

    ws.on("close", () => {
      clients.delete(clientId);
      console.log(`[WS] Client disconnected: ${clientId}`);

      // Broadcast to other clients
      broadcastToUser(userId, {
        type: "client_left",
        payload: { clientId, clientType },
      });
    });

    ws.on("error", (err) => {
      // A send() to a broken socket surfaces here — without a log, a realtime
      // notification can vanish with zero trace (the web-push channel is
      // independent, so the user isn't fully unnotified, but ops must see it).
      console.warn(`[WS] socket error for ${clientId}:`, err.message);
      clients.delete(clientId);
    });
  });

  console.log("[WS] WebSocket server initialized on /ws");
  return wss;
}

/** Handle incoming WebSocket messages */
function handleMessage(client: WsClient, msg: WsMessage) {
  switch (msg.type) {
    // Ping/pong for keepalive
    case "ping":
      client.ws.send(JSON.stringify({ type: "pong", payload: {} }));
      break;

    // Broadcast to all tabs of same user (multi-tab sync)
    case "sync":
      broadcastToUser(
        client.userId,
        {
          type: "sync",
          payload: msg.payload,
          from: client.clientId,
        },
        client.clientId,
      );
      break;

    // Tab activity update (what each tab is doing)
    case "activity":
      broadcastToUser(
        client.userId,
        {
          type: "activity",
          payload: { clientId: client.clientId, ...(msg.payload as object) },
          from: client.clientId,
        },
        client.clientId,
      );
      break;

    // Voice command result forwarding
    case "voice_command":
      broadcastToUser(client.userId, {
        type: "voice_command",
        payload: msg.payload,
        from: client.clientId,
      });
      break;

    // Request list of connected clients
    case "list_clients":
      client.ws.send(
        JSON.stringify({
          type: "client_list",
          payload: { clients: getConnectedClients(client.userId) },
        }),
      );
      break;

    default:
      break;
  }
}

/** Broadcast message to all clients of a specific user */
export function broadcastToUser(userId: string, msg: WsMessage, excludeClientId?: string) {
  const data = JSON.stringify(msg);
  for (const [id, client] of clients) {
    if (
      client.userId === userId &&
      id !== excludeClientId &&
      client.ws.readyState === WebSocket.OPEN
    ) {
      client.ws.send(data);
    }
  }
}

/** Send a notification to all connected clients of a user */
export function pushNotification(
  userId: string,
  notification: {
    id?: string;
    type: string;
    title: string;
    message: string;
    createdAt?: string;
    conversationId?: string;
    link?: string;
  },
) {
  broadcastToUser(userId, {
    type: "notification",
    payload: {
      ...notification,
      id: notification.id || crypto.randomUUID(),
      createdAt: notification.createdAt || new Date().toISOString(),
    },
  });
}

/** Get info about all connected clients for a user */
function getConnectedClients(userId: string): Array<{
  clientId: string;
  type: string;
  connectedAt: number;
}> {
  const result: Array<{ clientId: string; type: string; connectedAt: number }> = [];
  for (const [, client] of clients) {
    if (client.userId === userId) {
      result.push({
        clientId: client.clientId,
        type: client.type,
        connectedAt: client.connectedAt,
      });
    }
  }
  return result;
}

/** Get count of connected clients */
export function getClientCount(userId?: string): number {
  if (!userId) return clients.size;
  let count = 0;
  for (const [, client] of clients) {
    if (client.userId === userId) count++;
  }
  return count;
}
