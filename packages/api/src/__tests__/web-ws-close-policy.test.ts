/**
 * The web client's reaction to the API WebSocket's close codes (packages/web
 * src/lib/ws-close-policy.ts, used by components/use-websocket.ts — the same
 * hook runs inside the Windows Tauri wrapper):
 *   - 1013 "Try Again Later" (the handshake's session check could not reach
 *     the database): reconnect with the normal exponential backoff;
 *   - 4001 (the session is definitively over): wait the capped delay — an
 *     immediate retry with the same dead token only earns another 4001.
 * The socket never signs the user out: a 401 on an HTTP call is the sole
 * sign-out path (lib/api.ts apiFetch), so a database blip on the socket can't
 * log anyone out.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  WS_CLOSE_SESSION_ENDED,
  WS_CLOSE_TRY_AGAIN_LATER,
  wsReconnectDelayMs,
} from "../../../web/src/lib/ws-close-policy";
import {
  WS_CLOSE_SESSION_ENDED as API_WS_CLOSE_SESSION_ENDED,
  WS_CLOSE_SESSION_CHECK_UNAVAILABLE,
} from "../websocket.js";

const noJitter = () => 0;

describe("web WebSocket close policy", () => {
  it("speaks the API's close codes", () => {
    expect(WS_CLOSE_TRY_AGAIN_LATER).toBe(WS_CLOSE_SESSION_CHECK_UNAVAILABLE);
    expect(WS_CLOSE_SESSION_ENDED).toBe(API_WS_CLOSE_SESSION_ENDED);
  });

  it("reconnects after a 1013 with the normal exponential backoff", () => {
    expect(wsReconnectDelayMs(1013, 0, noJitter)).toBe(1_000);
    expect(wsReconnectDelayMs(1013, 1, noJitter)).toBe(2_000);
    expect(wsReconnectDelayMs(1013, 3, noJitter)).toBe(8_000);
    expect(wsReconnectDelayMs(1013, 10, noJitter)).toBe(30_000);
  });

  it("waits the capped delay after a 4001 instead of hammering with a dead token", () => {
    expect(wsReconnectDelayMs(4001, 0, noJitter)).toBe(30_000);
    expect(wsReconnectDelayMs(4001, 5, noJitter)).toBe(30_000);
  });

  it("keeps the exponential backoff for every other close (network drop, server restart)", () => {
    expect(wsReconnectDelayMs(1006, 0, noJitter)).toBe(1_000);
    expect(wsReconnectDelayMs(1000, 2, noJitter)).toBe(4_000);
    expect(wsReconnectDelayMs(1011, 4, noJitter)).toBe(16_000);
  });

  it("adds up to one second of jitter", () => {
    expect(wsReconnectDelayMs(1013, 0, () => 0.5)).toBe(1_500);
    expect(wsReconnectDelayMs(4001, 0, () => 0.999)).toBeLessThan(31_000);
  });

  it("the hook routes the close code through the policy and never signs out", async () => {
    // Source-level pin: the hook is only reachable in a browser, which the
    // unit harness doesn't run.
    const src = await readFile(
      new URL("../../../web/src/components/use-websocket.ts", import.meta.url),
      "utf8",
    );
    expect(src).toContain("ws.onclose = (event) => {");
    expect(src).toContain("wsReconnectDelayMs(event.code, attempt)");
    // No sign-out primitive: dropping the token or navigating away.
    expect(src).not.toMatch(/clearStoredAuthToken|location\.(href|assign|replace)/);
  });

  it("the hook resets the backoff on the server's welcome, not on open", async () => {
    // The server accepts the upgrade before its session check, so a rejected
    // socket opens and then closes 1013/4001. A reset on open pinned every
    // retry at ~1s through a database outage.
    const src = await readFile(
      new URL("../../../web/src/components/use-websocket.ts", import.meta.url),
      "utf8",
    );
    const onOpen = src.slice(src.indexOf("ws.onopen = () => {"), src.indexOf("ws.onmessage"));
    expect(onOpen).not.toContain("reconnectAttemptsRef.current = 0");
    expect(src).toMatch(/case "connected":\s*reconnectAttemptsRef\.current = 0;/);
  });
});
