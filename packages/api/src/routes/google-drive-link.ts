/**
 * Google Drive link routes — step D5b of docs/providers/unified-platform-plan.md.
 * They ride the Google OAuth flow of routes/auth.ts (same client, same redirect
 * URI, same callback): a distinct signed-state marker (`__link_drive__`) picks
 * the drive branch, the consent asks for drive.file and the identity scopes
 * only, and the result is a LinkedDriveAccount.
 *
 *   POST   /link           — start the consent (requireEntitled), returns { url }
 *   GET    /accounts       — the user's Google Drive accounts (never a token)
 *   DELETE /accounts/:id   — unlink one, with every file indexed from it
 *   (the callback is routes/auth.ts's; it hands a drive state to
 *   `completeGoogleDriveLink`)
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
  GoogleDriveUnlinkResponse,
} from "@klorn/contract";
import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { requireEntitled } from "../billing/entitlement-guard.js";
import { DRIVE_ID_MAX_CHARS } from "../drive/drive-rows.js";
import { googleDriveRoutesEnabled } from "../drive/drive-scope.js";
import { listDriveAccounts, unlinkDriveAccount } from "../drive/linked-drive-accounts.js";
import { getLinkDriveAuthUrl } from "../drive/providers/google-auth.js";
import { darkRouteGate } from "./dark-route-gate.js";

// Same demo sentinel as routes/auth.ts and routes/outlook-calendar-link.ts.
const DEMO_USER_ID = "demo-user";
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;

/** An OAuth start: the same limit as the calendar and inbox links. */
const LINK_RATE_LIMIT = { max: 10, timeWindow: "15 minutes" } as const;
/** The drive's read limit (routes/drive.ts). */
const ACCOUNTS_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const;
const UNLINK_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const;

const idParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string", minLength: 1, maxLength: DRIVE_ID_MAX_CHARS } },
} as const;

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
        preHandler: [requireAuth, requireEntitled],
        config: { rateLimit: LINK_RATE_LIMIT },
      },
      async (request, reply) => {
        const userId = getUserId(request);
        if (userId === DEMO_USER_ID) {
          return reply
            .code(HTTP_FORBIDDEN)
            .send({ error: "Authentication required to link Google Drive" });
        }
        const body: GoogleDriveLinkResponse = { url: getLinkDriveAuthUrl(userId) };
        return reply.send(body);
      },
    );

    // GET /accounts — auth only, no requireEntitled: a downgraded user must still be
    // able to see an account in order to unlink it.
    app.get(
      "/accounts",
      { preHandler: requireAuth, config: { rateLimit: ACCOUNTS_RATE_LIMIT } },
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
        preHandler: requireAuth,
        schema: { params: idParamsSchema },
        config: { rateLimit: UNLINK_RATE_LIMIT },
      },
      async (request, reply) => {
        const userId = getUserId(request);
        const { id } = request.params as { id: string };
        if (!(await unlinkDriveAccount(userId, "GOOGLE", id))) {
          return reply.code(HTTP_NOT_FOUND).send({ error: "Drive account not found" });
        }
        const body: GoogleDriveUnlinkResponse = { success: true };
        return reply.send(body);
      },
    );
  };
}

export { googleDriveRoutesEnabled };
