import type { FastifyReply, FastifyRequest } from "fastify";
import {
  desktopHandoffPage,
  isAllowedNativeScheme,
  LINK_HANDOFF_COPY,
} from "../auth/native-handoff.js";
import { type LinkMarker, parkPendingLink } from "../auth/pending-links.js";
import { captureError } from "../sentry.js";

/** Answer to a park refused because the store is full: visible, never a silent drop. */
const LINKS_BUSY = "Too many account connections are in progress. Please try again in a minute.";

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
 */
export function handOffAccountLink(
  reply: FastifyReply,
  link: { userId: string; marker: LinkMarker; code: string; appScheme?: unknown; webUrl: string },
): FastifyReply {
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
    return reply.code(503).send({ error: LINKS_BUSY });
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
