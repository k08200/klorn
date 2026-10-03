/**
 * Device calendar routes — step C6 of docs/providers/unified-platform-plan.md. A
 * desktop app (KlornMac, EventKit) uploads the calendars the user turned on, one by
 * one (decision P4); each becomes a read-only DEVICE source whose rows every C7
 * reader shows like a linked calendar's.
 *
 *   GET    /sources              — the user's device calendars ({ key, title, uploadedAt })
 *   PUT    /sources/:key/window  — one calendar's full snapshot over a bounded window;
 *                                  the first one creates the source (Pro-gated)
 *   DELETE /sources/:key         — the user turned the calendar off: remove it, its
 *                                  rows and their attention items
 *
 * `:key` is the device's sha256 of the EventKit calendar identifier and the device
 * id (pim/device-calendar/device-source-key.ts); the raw identifier is refused.
 * Authentication is a device session (requireAuth: a live Device row for the
 * bearer token) and runs before the body is read; every query is scoped to the
 * token's user. Limits, each a named constant: the body size, the window, the
 * event count and every string (pim/device-calendar/device-snapshot.ts), and the
 * request rate per device session and per user.
 *
 * The prefix is new (/api/device-calendar, not under /api/calendar, whose `/:id`
 * route would answer for /api/calendar/device-sources) so that while
 * DEVICE_CALENDAR_ENABLED is off every route answers Fastify's default 404
 * (darkRouteGate), byte-identical to an unregistered route; the Mac app reads that
 * 404 as "feature off" and hides its setting.
 */

import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireAuth } from "../auth.js";
import { requireEntitled } from "../billing/entitlement-guard.js";
import { ingestDeviceSnapshot } from "../pim/device-calendar/device-ingest.js";
import {
  DEVICE_SNAPSHOT_BODY_LIMIT_BYTES,
  type DeviceSnapshotBody,
  deviceSnapshotBodySchema,
  normaliseDeviceSnapshot,
} from "../pim/device-calendar/device-snapshot.js";
import { DEVICE_SOURCE_KEY_SCHEMA_PATTERN } from "../pim/device-calendar/device-source-key.js";
import { listDeviceSources, removeDeviceSource } from "../pim/device-calendar/device-sources.js";
import { darkRouteGate } from "./dark-route-gate.js";

/**
 * Per device session. A Mac uploads each enabled calendar on launch, on a change
 * (debounced) and every 15 minutes, skipping an unchanged snapshot.
 */
export const DEVICE_CALENDAR_DEVICE_LIMIT = { max: 120, timeWindow: "10 minutes" } as const;
/** Per user, across every device session. */
export const DEVICE_CALENDAR_USER_LIMIT = { max: 240, timeWindow: "10 minutes" } as const;

const HTTP_TOO_MANY_REQUESTS = 429;
const RATE_LIMITED = "Too many device calendar requests. Try again later.";
/** 409: a NEW calendar past the per-user source cap. */
export const DEVICE_SOURCE_CAP_ERROR = "Too many device calendars. Turn one off first.";
/**
 * 409: the snapshot would pass a row cap. Its own words: this is about events, not
 * about how many calendars are on.
 */
export const DEVICE_ROW_CAP_ERROR = "Too many events are stored from device calendars.";
/**
 * The machine codes beside those words. A client picks its own localised text by
 * them (the Mac app: DeviceCalendarBridge.rowCapCode, pinned by its self-check), so
 * they never change.
 */
const DEVICE_SOURCE_CAP_CODE = "device_source_cap";
const DEVICE_ROW_CAP_CODE = "device_row_cap";

/** The one answer to every refused snapshot: names the part, never echoes a value. */
const SNAPSHOT_REFUSED: Record<string, string> = {
  window: "The snapshot window is not a valid interval near now.",
  events: "The snapshot has too many events.",
  event: "An event's start or end is not a valid time.",
};

const keyParamsSchema = {
  type: "object",
  required: ["key"],
  properties: { key: { type: "string", pattern: DEVICE_SOURCE_KEY_SCHEMA_PATTERN } },
} as const;

interface KeyParams {
  key: string;
}

function userIdOf(request: FastifyRequest): string {
  return (request as unknown as { userId: string }).userId;
}

/** The device session: a hash of the bearer token (the Device row's own key), else the IP. */
export function deviceSessionKey(request: FastifyRequest): string {
  const auth = request.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const digest = createHash("sha256").update(auth.slice(7), "utf8").digest("hex").slice(0, 32);
    return `device-cal:session:${digest}`;
  }
  // No token: the same unspoofable client address as the global limiter (index.ts),
  // never request.ip, which trusts X-Forwarded-For.
  const cf = request.headers["cf-connecting-ip"];
  const ip =
    typeof cf === "string" && cf.length > 0 ? cf : (request.socket?.remoteAddress ?? "unknown");
  return `device-cal:ip:${ip}`;
}

function userKey(request: FastifyRequest): string {
  return `device-cal:user:${userIdOf(request)}`;
}

/**
 * An onRequest hook enforcing one limit; none without the rate-limit plugin (some
 * tests). Hooks rather than route config so the order is explicit: the device
 * session's limit before authentication (a flood never reaches the session lookup),
 * the user's after it (it needs the user).
 */
function limitHook(
  app: FastifyInstance,
  limit: { readonly max: number; readonly timeWindow: string },
  keyGenerator: (request: FastifyRequest) => string,
) {
  const limiter = app.hasDecorator("createRateLimit")
    ? app.createRateLimit({ ...limit, keyGenerator })
    : null;
  return async function rateLimited(request: FastifyRequest, reply: FastifyReply) {
    if (!limiter || reply.sent) return;
    const limit = await limiter(request);
    if (limit.isAllowed || !limit.isExceeded) return;
    reply.header("retry-after", String(limit.ttlInSeconds));
    return reply.code(HTTP_TOO_MANY_REQUESTS).send({ error: RATE_LIMITED });
  };
}

async function listHandler(request: FastifyRequest) {
  const sources = await listDeviceSources(userIdOf(request));
  return { sources };
}

async function putHandler(
  request: FastifyRequest<{ Params: KeyParams; Body: DeviceSnapshotBody }>,
  reply: FastifyReply,
) {
  const now = new Date();
  const checked = normaliseDeviceSnapshot(request.body, now);
  if (!checked.ok) {
    return reply.code(400).send({ error: SNAPSHOT_REFUSED[checked.reason] });
  }
  const outcome = await ingestDeviceSnapshot(
    userIdOf(request),
    request.params.key,
    checked.snapshot,
    now,
  );
  if (outcome.kind === "over-cap") {
    return reply.code(409).send({ error: DEVICE_SOURCE_CAP_ERROR, code: DEVICE_SOURCE_CAP_CODE });
  }
  if (outcome.kind === "over-row-cap") {
    return reply.code(409).send({ error: DEVICE_ROW_CAP_ERROR, code: DEVICE_ROW_CAP_CODE });
  }
  if (outcome.kind === "stale") {
    // A newer snapshot of this calendar was applied already: nothing changed.
    const skipped = checked.snapshot.skipped;
    return { created: 0, updated: 0, removed: 0, skipped, valveRefused: false, stale: true };
  }
  return {
    created: outcome.created,
    updated: outcome.updated,
    removed: outcome.removed,
    skipped: checked.snapshot.skipped,
    valveRefused: outcome.valveRefused,
  };
}

async function deleteHandler(request: FastifyRequest<{ Params: KeyParams }>, reply: FastifyReply) {
  if (!(await removeDeviceSource(userIdOf(request), request.params.key))) {
    return reply.code(404).send({ error: "Device calendar not found" });
  }
  return { success: true };
}

export function deviceCalendarRoutes(opts: {
  gate: () => boolean;
}): (app: FastifyInstance) => Promise<void> {
  return async function routes(app: FastifyInstance) {
    app.addHook("onRequest", darkRouteGate(opts.gate));
    // Both limits and authentication run before the body is read.
    const authed = [
      limitHook(app, DEVICE_CALENDAR_DEVICE_LIMIT, deviceSessionKey),
      requireAuth,
      limitHook(app, DEVICE_CALENDAR_USER_LIMIT, userKey),
    ];

    app.get("/sources", { onRequest: authed }, listHandler);
    app.put<{ Params: KeyParams; Body: DeviceSnapshotBody }>(
      "/sources/:key/window",
      {
        // Uploading is the feature, so it is Pro-gated, before the body is read; list
        // and remove are not, so a downgraded user can always see and turn off what
        // was uploaded.
        onRequest: [...authed, requireEntitled],
        bodyLimit: DEVICE_SNAPSHOT_BODY_LIMIT_BYTES,
        schema: { params: keyParamsSchema, body: deviceSnapshotBodySchema },
      },
      putHandler,
    );
    app.delete<{ Params: KeyParams }>(
      "/sources/:key",
      { onRequest: authed, schema: { params: keyParamsSchema } },
      deleteHandler,
    );
  };
}
