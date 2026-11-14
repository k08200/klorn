/**
 * WebSocket Hub — Real-time communication layer
 *
 * Enables:
 * - Real-time notifications push to all connected clients
 * - Multi-tab coordination (tabs can see each other's state)
 * - Desktop widget live updates
 * - Voice command streaming
 */

import type { IncomingMessage, Server } from "node:http";
import type { DesktopAlertKind, DesktopMailToast } from "@klorn/contract";
import { WebSocket, WebSocketServer } from "ws";
import {
  checkSessionActive,
  isDemoAccessEnabled,
  reportSessionCheckFailure,
  verifiedPayload,
} from "./auth.js";
import {
  desktopPresence,
  parseWsClientApp,
  parseWsClientType,
  type WsClientType,
} from "./notify/desktop-presence.js";

interface WsClient {
  ws: WebSocket;
  userId: string;
  clientId: string;
  type: WsClientType;
  connectedAt: number;
}

interface WsMessage {
  type: string;
  payload: unknown;
  from?: string;
}

const clients: Map<string, WsClient> = new Map();

let wss: WebSocketServer | null = null;

/**
 * Close codes for the handshake's session check. 4001 means the session is
 * definitively over (forged/expired JWT, kicked device, revoked epoch) — the
 * same verdict the HTTP path answers with a 401. When the database could not
 * decide (pool timeout, dropped connection) the socket closes with 1013 "Try
 * Again Later" from the IANA WebSocket close-code registry (RFC 6455 §11.7):
 * the HTTP path's retryable 503 SESSION_CHECK_UNAVAILABLE, in socket form. Clients
 * reconnect with backoff on it and never treat it as a sign-out.
 */
export const WS_CLOSE_SESSION_ENDED = 4001;
export const WS_CLOSE_SESSION_CHECK_UNAVAILABLE = 1013;
/** Close reason for 1013. Fixed text: no database error ever reaches it. */
const SESSION_CHECK_UNAVAILABLE_REASON = "Couldn't verify your session right now. Try again.";

/** Subprotocol marker that carries the auth JWT out of the URL. The client
 *  offers ["klorn-ws-v1", <jwt>] as its Sec-WebSocket-Protocol; the server
 *  selects only the marker back and reads the JWT from the value after it. */
export const WS_AUTH_SUBPROTOCOL = "klorn-ws-v1";

/**
 * Pull the auth JWT from a Sec-WebSocket-Protocol header when the client used
 * the subprotocol relay (token as the value right after the marker). Returns
 * null if the marker is absent. Keeping the JWT in a header rather than the
 * URL stops the long-lived credential from landing in proxy/LB access logs.
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

type SocketAuth = { ok: true; userId: string } | { ok: false; code: number; reason: string };

/**
 * Authenticate a new socket. The JWT rides the Sec-WebSocket-Protocol
 * subprotocol — never the URL, so the credential stays out of proxy/LB access
 * logs. The legacy ?token= query fallback is gone (every shipped client offers
 * the subprotocol); the only tokenless path left is the demo branch.
 */
async function authenticateSocket(req: IncomingMessage, url: URL): Promise<SocketAuth> {
  const token = extractWsSubprotocolToken(req.headers["sec-websocket-protocol"]);
  if (!token) {
    // Unauthenticated demo-user is OFF in production. Same single predicate as
    // every HTTP demo path (getUserId, ensureDemoUser, /login) so the gates
    // can't drift. Without it a tokenless client must not connect.
    const rawUserId = url.searchParams.get("userId");
    if (!isDemoAccessEnabled() || (rawUserId && rawUserId !== "demo-user")) {
      return {
        ok: false,
        code: WS_CLOSE_SESSION_ENDED,
        reason: "Authentication required — offer the auth subprotocol",
      };
    }
    return { ok: true, userId: "demo-user" };
  }
  const payload = verifiedPayload(token);
  if (!payload)
    return { ok: false, code: WS_CLOSE_SESSION_ENDED, reason: "Invalid or expired token" };
  // Mirror requireAuth: a bare verifyToken only checks signature+expiry. Also
  // reject a token invalidated by a device-kick (another login) or a global
  // revocation (password reset), else a revoked token keeps streaming the
  // user's real-time notification payloads.
  const verdict = await checkSessionActive(token, payload);
  if (verdict.kind === "ended") {
    return {
      ok: false,
      code: WS_CLOSE_SESSION_ENDED,
      reason: "Session expired. Please log in again.",
    };
  }
  if (verdict.kind === "unavailable") {
    // The database could not decide. The session was never shown to be over,
    // so this is not 4001 (which reads as "signed out"): a retryable close
    // that admits nothing. Logged and reported (rate-limited, shared with the
    // HTTP path); the error text stays server-side.
    console.error("[WS] session check failed: database unavailable", verdict.error);
    reportSessionCheckFailure(verdict.error);
    return {
      ok: false,
      code: WS_CLOSE_SESSION_CHECK_UNAVAILABLE,
      reason: SESSION_CHECK_UNAVAILABLE_REASON,
    };
  }
  return { ok: true, userId: payload.userId };
}

/** Initialize WebSocket server attached to existing HTTP server */
export function initWebSocket(server: Server): WebSocketServer {
  wss = new WebSocketServer({
    server,
    path: "/ws",
    // Accept the auth marker subprotocol so clients can carry the JWT in the
    // Sec-WebSocket-Protocol header instead of the URL. Only ever select the
    // marker back — never echo the token. Clients that offer no subprotocol
    // negotiate none and still connect (demo-user tokenless path only,
    // gated by isDemoAccessEnabled in the connection handler).
    handleProtocols: (protocols: Set<string>) =>
      protocols.has(WS_AUTH_SUBPROTOCOL) ? WS_AUTH_SUBPROTOCOL : false,
  });

  wss.on("connection", async (ws, req) => {
    // Before any await: a malformed frame or a reset while the session check
    // runs emits 'error', and an 'error' with no listener crashes the process.
    // Replaced by the client's own handler once the socket is admitted.
    const onEarlyError = (err: Error) => {
      console.warn("[WS] socket error before admission:", err.message);
    };
    ws.on("error", onEarlyError);
    // A fixed base: only the query is read, and a client-sent Host header that
    // is no valid URL host must not throw out of this async handler.
    const url = new URL(req.url || "/", "http://localhost");
    // Validated, not cast: the value lands in clientId, logs and broadcasts.
    const clientType = parseWsClientType(url.searchParams.get("type"));
    const desktopApp =
      clientType === "desktop" ? parseWsClientApp(url.searchParams.get("app")) : null;

    let auth: SocketAuth;
    try {
      auth = await authenticateSocket(req, url);
    } catch (err) {
      // Nothing decided the session: retryable, never 4001, admits nothing.
      console.error("[WS] session check failed unexpectedly:", err);
      auth = {
        ok: false,
        code: WS_CLOSE_SESSION_CHECK_UNAVAILABLE,
        reason: SESSION_CHECK_UNAVAILABLE_REASON,
      };
    }
    if (!auth.ok) {
      ws.close(auth.code, auth.reason);
      return;
    }
    // The peer may have left while the check ran: its 'close' already fired,
    // so registering it now would leak a client and its desktop presence.
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.off("error", onEarlyError);
    const { userId } = auth;
    const clientId = `${userId}-${clientType}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const client: WsClient = {
      ws,
      userId,
      clientId,
      type: clientType,
      connectedAt: Date.now(),
    };

    clients.set(clientId, client);
    if (desktopApp) desktopPresence.connected(userId, clientId, desktopApp, Date.now());
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
      desktopPresence.disconnected(userId, clientId, Date.now());
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
      desktopPresence.disconnected(userId, clientId, Date.now());
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
    /** OS-banner tag for the desktop shell — see notify/desktop-alert.ts. */
    alert?: DesktopAlertKind;
    /** The desktop shell's toast for a one-mail interrupt (decision N1). */
    mail?: DesktopMailToast;
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
