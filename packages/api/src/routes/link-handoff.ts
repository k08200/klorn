import type { FastifyReply, FastifyRequest } from "fastify";
import {
  desktopHandoffPage,
  isAllowedNativeScheme,
  LINK_HANDOFF_COPY,
} from "../auth/native-handoff.js";
import { allowPark, parkClientKey } from "../auth/park-throttle.js";
import { LINK_FLOW_PATHS, type LinkMarker, parkPendingLink } from "../auth/pending-links.js";
import { captureError } from "../sentry.js";

/**
 * The account-link leg of an OAuth callback. The authorization code is NOT
 * exchanged here: it is parked (auth/pending-links.ts) and its handle handed
 * back to the client that started the flow, which completes it with its own
 * session through POST /api/auth/link/complete.
 *
 * - Native start (an allowlisted scheme was signed into the state): a no-store
 *   page deep-links `<scheme>://link-complete?h=<handle>` to the app.
 * - Web: a 302 to `${webUrl}/link/complete#h=<handle>`. The fragment keeps the
 *   handle out of server logs and the Referer header.
 * - Refused (this client parked too often, or the store is full): a 302 to the
 *   flow's own failure path, which the web already shows as "couldn't connect";
 *   never a raw JSON page on the API origin.
 */
export function handOffAccountLink(
  reply: FastifyReply,
  link: { userId: string; marker: LinkMarker; code: string; appScheme?: unknown; webUrl: string },
): FastifyReply {
  const failed = `${link.webUrl}${LINK_FLOW_PATHS[link.marker].failed}`;
  if (!allowPark(parkClientKey(reply.request))) {
    console.warn(`[LINK] park throttle hit; refused a ${link.marker} park`);
    return reply.redirect(failed);
  }
  const appScheme = isAllowedNativeScheme(link.appScheme) ? link.appScheme : undefined;
  const handle = parkPendingLink({
    userId: link.userId,
    marker: link.marker,
    code: link.code,
    ...(appScheme ? { appScheme } : {}),
  });
  if (!handle) {
    console.warn(`[LINK] pending-link store full; refused a ${link.marker} park`);
    captureError(new Error("pending-link store full"), {
      tags: { scope: "auth.link.park_full" },
      extra: { marker: link.marker },
    });
    return reply.redirect(failed);
  }
  // Either answer carries a live handle: never cache it.
  reply.header("Cache-Control", "no-store");
  if (appScheme) {
    reply.type("text/html");
    return reply.send(
      desktopHandoffPage(`${appScheme}://link-complete?h=${handle}`, LINK_HANDOFF_COPY),
    );
  }
  return reply.redirect(`${link.webUrl}/link/complete#h=${handle}`);
}

/**
 * The allowlisted native scheme a link start was asked to hand back to
 * (`?appScheme=`), or nothing. Signed into the state so the callback can
 * deep-link the parked handle to the app on the device that started the flow.
 * Anything not on the allowlist is dropped, never signed.
 */
export function linkStartScheme(request: FastifyRequest): { appScheme?: string } {
  const { appScheme } = (request.query ?? {}) as { appScheme?: unknown };
  return isAllowedNativeScheme(appScheme) ? { appScheme } : {};
}
