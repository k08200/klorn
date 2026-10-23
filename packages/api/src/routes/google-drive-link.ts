/**
 * Google Drive link routes — step D5b of docs/providers/unified-platform-plan.md.
 * They ride the Google OAuth flow of routes/auth.ts (same client, same redirect
 * URI, same callback): a distinct signed-state marker (`__link_drive__`) picks
 * the drive branch, the consent asks for drive.file and the identity scopes
 * only, and the result is a LinkedDriveAccount. Like every account link
 * (#1451), the callback only parks the code; POST /api/auth/link/complete
 * finishes it for the session that started it (routes/link-complete.ts).
 *
 *   POST   /link           — start the consent (requireEntitled), returns { url }
 *   GET    /accounts       — the user's Google Drive accounts (never a token)
 *   DELETE /accounts/:id   — unlink one, with every file indexed from it
 *   POST   /accounts/:id/picker-session — (D5c, requireEntitled) the browser
 *                            Picker's token, developer key and app id, no-store
 *   POST   /accounts/:id/picked — (D5c, requireEntitled) index the picked ids;
 *                            returns { added, refused: [{ id, code }] }
 *   (the callback is routes/auth.ts's: it parks a drive state's code, and
 *   routes/link-complete.ts calls `completeGoogleDriveLink`)
 *
 * Tokens: picker-session's `accessToken` is the ONLY token Klorn puts on the
 * wire, by design: the Google Picker runs in the browser and needs one. It is a
 * drive.file token minted on click, sent `Cache-Control: no-store`, and never
 * stored or logged (drive/google-drive-picker.ts). Every other answer carries
 * none. /picked accepts ids only: its body schema has no other field, and every
 * field of a row is what Google says about that id.
 *
 * Unlinking does not call Google's revoke endpoint: Google revokes a combined
 * grant whole, so for the primary's own Google account it would cut Gmail and
 * Calendar too (plan, D5 "Unlink"). The user can remove the grant at Google.
 *
 * Every route sits behind DRIVE_ENABLED and GOOGLE_DRIVE_ENABLED
 * (`googleDriveRoutesEnabled`, read per request) via darkRouteGate: while either
 * is off they answer Fastify's default 404, before authentication, exactly as
 * if they were not registered.
 */

import type {
  GoogleDriveAccountsResponse,
  GoogleDriveLinkResponse,
  GoogleDrivePickedRequest,
  GoogleDrivePickedResponse,
  GoogleDrivePickerSessionResponse,
  GoogleDriveUnlinkResponse,
} from "@klorn/contract";
import type { FastifyInstance, FastifyReply } from "fastify";
import { removeAndRevokeGoogle } from "../auth/google-grant-revoke.js";
import { getUserId, requireAuth } from "../auth.js";
import { requireEntitled } from "../billing/entitlement-guard.js";
import { GOOGLE_DRIVE_FLAGS } from "../config.js";
import { DRIVE_ID_MAX_CHARS } from "../drive/drive-rows.js";
import { googleDriveRoutesEnabled } from "../drive/drive-scope.js";
import {
  GOOGLE_PICK_MAX_IDS,
  indexPickedGoogleFiles,
  openGooglePickerSession,
  type PickedFilesResult,
  type PickerSessionResult,
} from "../drive/google-drive-picker.js";
import { listDriveAccounts, unlinkDriveAccount } from "../drive/linked-drive-accounts.js";
import { getLinkDriveAuthUrl } from "../drive/providers/google-auth.js";
import { cohortGate } from "./cohort-gate.js";
import { darkRouteGate } from "./dark-route-gate.js";
import { linkStartScheme } from "./link-handoff.js";

// Same demo sentinel as routes/auth.ts and routes/outlook-calendar-link.ts.
const DEMO_USER_ID = "demo-user";
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_BAD_GATEWAY = 502;
const HTTP_SERVICE_UNAVAILABLE = 503;

/** An OAuth start: the same limit as the calendar and inbox links. */
const LINK_RATE_LIMIT = { max: 10, timeWindow: "15 minutes" } as const;
/** The drive's read limit (routes/drive.ts). */
const ACCOUNTS_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const;
const UNLINK_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const;
/** A Picker opening: one token minted each. */
const PICKER_SESSION_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const;
/** A pick: up to GOOGLE_PICK_MAX_IDS files.get calls each. */
const PICKED_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const;

const idParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string", minLength: 1, maxLength: DRIVE_ID_MAX_CHARS } },
} as const;

/** The longest id a pick may name; the shape check is per id (`invalid`). */
const PICKED_ID_MAX_CHARS = 256;

/** Ids only: any other field is dropped before the handler sees the body. */
const pickedBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["ids"],
  properties: {
    ids: {
      type: "array",
      minItems: 1,
      maxItems: GOOGLE_PICK_MAX_IDS,
      items: { type: "string", minLength: 1, maxLength: PICKED_ID_MAX_CHARS },
    },
  },
} as const;

type PickerFailure = Extract<PickerSessionResult | PickedFilesResult, { ok: false }>["reason"];

/** A refused Picker step's answer. Never echoes a value the caller or Google sent. */
function sendPickerFailure(reply: FastifyReply, reason: PickerFailure) {
  switch (reason) {
    case "not-found":
      return reply.code(HTTP_NOT_FOUND).send({ error: "Drive account not found" });
    case "needs-reconnect":
      return reply
        .code(HTTP_CONFLICT)
        .send({ error: "Reconnect this Google account", code: "needs-reconnect" });
    case "grant-too-broad":
      // The grant carries more than drive.file: its token must not reach a browser.
      return reply.code(HTTP_CONFLICT).send({
        error:
          "This Google grant carries more than Google Drive access. Remove Klorn at Google, then connect again.",
        code: "grant-too-broad",
      });
    case "not-configured":
      return reply
        .code(HTTP_SERVICE_UNAVAILABLE)
        .send({ error: "The Google Picker is not configured", code: "picker-not-configured" });
    case "unavailable":
      return reply
        .code(HTTP_BAD_GATEWAY)
        .send({ error: "Google Drive did not answer. Try again.", code: "drive-unavailable" });
  }
}

export function googleDriveLinkRoutes(opts: {
  gate: () => boolean;
}): (app: FastifyInstance) => Promise<void> {
  return async function routes(app: FastifyInstance) {
    app.addHook("onRequest", darkRouteGate(opts.gate));

    // POST /link — the Google consent for drive.file. Plan gate:
    // requireEntitled, as link-calendar (default 2026-10-15; the founder may
    // change it — open question, not yet answered). The callback checks the
    // plan again.
    app.post(
      "/link",
      {
        preHandler: [requireAuth, cohortGate(GOOGLE_DRIVE_FLAGS), requireEntitled],
        config: { rateLimit: LINK_RATE_LIMIT },
      },
      async (request, reply) => {
        const userId = getUserId(request);
        if (userId === DEMO_USER_ID) {
          return reply
            .code(HTTP_FORBIDDEN)
            .send({ error: "Authentication required to link Google Drive" });
        }
        const body: GoogleDriveLinkResponse = {
          url: getLinkDriveAuthUrl(userId, linkStartScheme(request)),
        };
        return reply.send(body);
      },
    );

    // GET /accounts — auth only, no requireEntitled: a downgraded user must still be
    // able to see an account in order to unlink it.
    app.get(
      "/accounts",
      {
        preHandler: [requireAuth, cohortGate(GOOGLE_DRIVE_FLAGS)],
        config: { rateLimit: ACCOUNTS_RATE_LIMIT },
      },
      async (request): Promise<GoogleDriveAccountsResponse> => {
        const userId = getUserId(request);
        const accounts = await listDriveAccounts(userId, "GOOGLE");
        return {
          accounts: accounts.map((account) => ({
            id: account.id,
            email: account.email,
            needsReconnect: account.needsReconnect,
            createdAt: account.createdAt.toISOString(),
          })),
        };
      },
    );

    // DELETE /accounts/:id — this user's GOOGLE account only; another user's
    // id answers the same 404 as an unknown one. Auth only, like GET.
    app.delete(
      "/accounts/:id",
      {
        preHandler: [requireAuth, cohortGate(GOOGLE_DRIVE_FLAGS)],
        schema: { params: idParamsSchema },
        config: { rateLimit: UNLINK_RATE_LIMIT },
      },
      async (request, reply) => {
        const userId = getUserId(request);
        const { id } = request.params as { id: string };
        const unlinked = await removeAndRevokeGoogle(
          userId,
          { driveIds: [id] },
          () => unlinkDriveAccount(userId, "GOOGLE", id),
          (removed) => removed,
        );
        if (!unlinked) {
          return reply.code(HTTP_NOT_FOUND).send({ error: "Drive account not found" });
        }
        const body: GoogleDriveUnlinkResponse = { success: true };
        return reply.send(body);
      },
    );

    // POST /accounts/:id/picker-session — the Picker's token, key and app id for
    // this user's GOOGLE account. The token is the one on the wire by design
    // (see the header); never cached anywhere on the way.
    app.post(
      "/accounts/:id/picker-session",
      {
        preHandler: [requireAuth, cohortGate(GOOGLE_DRIVE_FLAGS), requireEntitled],
        schema: { params: idParamsSchema },
        config: { rateLimit: PICKER_SESSION_RATE_LIMIT },
      },
      async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const userId = getUserId(request);
        const { id } = request.params as { id: string };
        const result = await openGooglePickerSession(userId, id);
        if (!result.ok) return sendPickerFailure(reply, result.reason);
        const body: GoogleDrivePickerSessionResponse = result.session;
        return reply.send(body);
      },
    );

    // POST /accounts/:id/picked — index the picked ids of this user's GOOGLE
    // account from Google's own metadata. Ids only (pickedBodySchema).
    app.post(
      "/accounts/:id/picked",
      {
        preHandler: [requireAuth, cohortGate(GOOGLE_DRIVE_FLAGS), requireEntitled],
        schema: { params: idParamsSchema, body: pickedBodySchema },
        config: { rateLimit: PICKED_RATE_LIMIT },
      },
      async (request, reply) => {
        const userId = getUserId(request);
        const { id } = request.params as { id: string };
        const { ids } = request.body as GoogleDrivePickedRequest;
        const result = await indexPickedGoogleFiles(userId, id, ids);
        if (!result.ok) return sendPickerFailure(reply, result.reason);
        const body: GoogleDrivePickedResponse = { added: result.added, refused: result.refused };
        return reply.send(body);
      },
    );
  };
}

export { googleDriveRoutesEnabled };
