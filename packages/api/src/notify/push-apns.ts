/**
 * Native iOS push — APNs (Apple Push Notification service), HTTP/2 + token auth.
 *
 * @capacitor/push-notifications yields a raw APNs device token on iOS (not an
 * FCM token), so iOS delivery cannot go through firebase-admin/FCM (push-device.ts,
 * which handles Android). This sends straight to APNs with a provider JWT signed
 * by an APNs auth key (.p8), reusing the JWT signing we already have
 * (jsonwebtoken, ES256) and Node's built-in http2 — no new dependency.
 *
 * Environment (all required to enable; absent → iOS push is skipped + logged,
 * exactly like missing VAPID/FCM):
 * - APNS_KEY_P8    — the .p8 auth key contents (PEM; literal "\n" are unescaped)
 * - APNS_KEY_ID    — the key's 10-char Key ID
 * - APNS_TEAM_ID   — the Apple Developer Team ID
 * - APNS_BUNDLE_ID — the app bundle id (apns-topic); defaults to ai.klorn.app
 * - APNS_PRODUCTION="true" → api.push.apple.com, else the sandbox host (Xcode
 *   debug builds get sandbox APNs tokens, so sandbox is the safe default).
 */

import http2 from "node:http2";
import jwt from "jsonwebtoken";
import { prisma } from "../db.js";
import { captureError } from "../sentry.js";
import type { NotifCategory } from "./notification-prefs.js";
import type { DevicePushPayload, DevicePushSummary } from "./push-device.js";

const APNS_KEY_P8 = (process.env.APNS_KEY_P8 || "").replace(/\\n/g, "\n");
const APNS_KEY_ID = process.env.APNS_KEY_ID || "";
const APNS_TEAM_ID = process.env.APNS_TEAM_ID || "";
const APNS_BUNDLE_ID = process.env.APNS_BUNDLE_ID || "ai.klorn.app";
const APNS_HOST =
  process.env.APNS_PRODUCTION === "true"
    ? "https://api.push.apple.com"
    : "https://api.sandbox.push.apple.com";

// Apple accepts a provider token for up to 60 min and rejects refreshing it more
// than once every 20 min — cache and refresh at 50.
const PROVIDER_TOKEN_TTL_MS = 50 * 60 * 1000;
const APNS_REQUEST_TIMEOUT_MS = 10_000;

/** APNs reasons (or HTTP 410) that mean the token is dead → prune, don't retry. */
const DEAD_TOKEN_REASONS = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"]);

export function isApnsConfigured(): boolean {
  return Boolean(APNS_KEY_P8 && APNS_KEY_ID && APNS_TEAM_ID);
}

let cachedToken: { token: string; mintedAt: number } | null = null;

function providerToken(): string {
  if (cachedToken && Date.now() - cachedToken.mintedAt < PROVIDER_TOKEN_TTL_MS) {
    return cachedToken.token;
  }
  const token = jwt.sign({}, APNS_KEY_P8, {
    algorithm: "ES256",
    keyid: APNS_KEY_ID,
    issuer: APNS_TEAM_ID,
  });
  cachedToken = { token, mintedAt: Date.now() };
  return token;
}

function skipped(reason: string): DevicePushSummary {
  return { status: "skipped", reason, tokens: 0, accepted: 0, failed: 0 };
}

interface ApnsResult {
  ok: boolean;
  prune: boolean;
}

function sendOne(
  client: http2.ClientHttp2Session,
  providerJwt: string,
  deviceToken: string,
  body: string,
): Promise<ApnsResult> {
  return new Promise((resolve) => {
    // Idempotent settle so the promise can NEVER hang: whichever of end/error/
    // close fires first wins. (A timeout calls req.destroy → 'error'; a bare
    // 'close' with no end/error still resolves here.)
    let settled = false;
    const done = (r: ApnsResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      authorization: `bearer ${providerJwt}`,
      "apns-topic": APNS_BUNDLE_ID,
      "apns-push-type": "alert",
      "apns-priority": "10",
      // Give APNs a 24h retry window if the device is offline (default 0 = drop
      // immediately). This is an urgency product — don't silently lose it.
      "apns-expiration": String(Math.floor(Date.now() / 1000) + 86400),
      "content-type": "application/json",
    });
    // destroy(err) (not close()) so the timeout fires the 'error' handler and
    // resolves the promise instead of leaving it pending.
    req.setTimeout(APNS_REQUEST_TIMEOUT_MS, () => req.destroy(new Error("APNS request timeout")));

    let status = 0;
    let respBody = "";
    req.on("response", (headers) => {
      status = Number(headers[":status"]) || 0;
    });
    req.on("data", (chunk) => {
      respBody += chunk;
    });
    req.on("error", (err) => {
      console.error("[PUSH-APNS] request error:", err);
      done({ ok: false, prune: false });
    });
    // Safety net: stream closed without end/error (e.g. RST) must still resolve
    // — and log, so a per-device failure has a cause beyond the aggregate count.
    req.on("close", () => {
      console.error("[PUSH-APNS] stream closed without end/error (RST?)");
      done({ ok: false, prune: false });
    });
    req.on("end", () => {
      if (status === 200) return done({ ok: true, prune: false });
      let reason = "";
      try {
        reason = (JSON.parse(respBody) as { reason?: string }).reason ?? "";
      } catch {
        // non-JSON error body — leave reason empty
      }
      const prune = status === 410 || DEAD_TOKEN_REASONS.has(reason);
      console.error(`[PUSH-APNS] send failed status=${status} reason=${reason || "unknown"}`);
      done({ ok: false, prune });
    });
    req.end(body);
  });
}

/**
 * Send a push to a user's iOS devices via APNs. Prunes tokens APNs reports as
 * permanently dead. Best-effort: returns a summary and never throws.
 */
export async function sendApnsPush(
  userId: string,
  payload: DevicePushPayload,
  category: NotifCategory = "system",
): Promise<DevicePushSummary> {
  if (!isApnsConfigured()) {
    console.log(`[PUSH-APNS] Skipped — APNs not configured (user ${userId})`);
    return skipped("missing_apns_credentials");
  }

  const rows = await prisma.devicePushToken.findMany({
    where: { userId, platform: "ios" },
    select: { token: true },
  });
  if (rows.length === 0) return skipped("no_device_tokens");

  let jwtToken: string;
  try {
    jwtToken = providerToken();
  } catch (err) {
    console.error("[PUSH-APNS] Failed to mint provider JWT (check APNS_KEY_P8/ID/TEAM):", err);
    captureError(err, { tags: { scope: "push-apns.jwt" } });
    return skipped("apns_jwt_error");
  }

  const body = JSON.stringify({
    aps: { alert: { title: payload.title, body: payload.body }, sound: "default" },
    ...(payload.url ? { url: payload.url } : {}),
    ...(payload.notificationId ? { notificationId: payload.notificationId } : {}),
    category,
  });

  let client: http2.ClientHttp2Session;
  try {
    client = http2.connect(APNS_HOST);
  } catch (err) {
    console.error("[PUSH-APNS] connect failed:", err);
    captureError(err, { tags: { scope: "push-apns.connect" } });
    return skipped("apns_connect_error");
  }
  client.on("error", (err) => {
    console.error("[PUSH-APNS] session error:", err);
    captureError(err, { tags: { scope: "push-apns.session" } });
  });

  let accepted = 0;
  let failed = 0;
  const deadTokens: string[] = [];
  try {
    await Promise.all(
      rows.map((row) =>
        sendOne(client, jwtToken, row.token, body).then((r) => {
          if (r.ok) accepted++;
          else {
            failed++;
            if (r.prune) deadTokens.push(row.token);
          }
        }),
      ),
    );
  } finally {
    client.close();
  }

  if (deadTokens.length > 0) {
    // Scope the delete to this user (least privilege) even though token is unique
    // — a token could have migrated owners between query and prune.
    await prisma.devicePushToken.deleteMany({ where: { userId, token: { in: deadTokens } } });
    console.log(`[PUSH-APNS] Pruned ${deadTokens.length} dead iOS token(s) for ${userId}`);
  }

  console.log(`[PUSH-APNS] Sent ${accepted}/${rows.length} iOS push(es) for ${userId}`);
  return { status: "sent", tokens: rows.length, accepted, failed };
}
