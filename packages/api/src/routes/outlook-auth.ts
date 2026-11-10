/**
 * Outlook (Microsoft Graph) inbox link routes — Phase 3 of
 * docs/providers/multi-provider-plan.md. Mirrors the Google link-inbox flow
 * in routes/auth.ts (same state-JWT CSRF scheme, same TOCTOU entitlement
 * re-check at the callback, same new-links-only cap) but OUTLOOK-scoped and
 * OAuth'd against login.microsoftonline.com.
 *
 *   POST   /link-inbox         — start OAuth (Pro-gated), returns { url }
 *   GET    /callback           — MS redirect target (public: the browser
 *                                arrives with no Authorization header).
 *                                It parks the code and never exchanges it:
 *                                POST /api/auth/link/complete finishes the
 *                                link for the session that started it
 *                                (routes/link-complete.ts)
 *   GET    /linked-inboxes     — list OUTLOOK rows (never tokens)
 *   DELETE /linked-inboxes/:id — unlink one (auth-only, so a downgraded
 *                                user can always disconnect)
 *
 * The whole module sits behind OUTLOOK_INBOX_ENABLED via darkRouteGate:
 * while OFF, every route answers Fastify's default 404 (CASA surface
 * freeze), exactly like the iCloud surface in routes/imap-connect.ts.
 *
 * Step C4 adds a read-only CALENDAR link on the same OAuth app and callback
 * (routes/outlook-calendar-link.ts): its own routes behind their own gate
 * (OUTLOOK_CALENDAR_ENABLED plus this flag), and a calendar state marker that
 * sends this callback's calendar branch there. The inbox flow below is unchanged.
 */

import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth, signToken, verifyToken } from "../auth.js";
import {
  canConnectNewMailAccount,
  findOwnedLinkedAccount,
  keepIfOnlyMailSource,
  mayConnectMailAccount,
  requireMailLinkStart,
} from "../billing/mail-account-entitlement.js";
import { outlookCalendarEnabled } from "../config.js";
import { encryptOptional, encryptToken } from "../crypto-tokens.js";
import { prisma } from "../db.js";
import {
  exchangeOutlookCode,
  fetchOutlookAccountEmail,
  getOutlookAuthUrl,
  outlookConfigured,
} from "../mail/outlook-oauth.js";
import { captureError } from "../sentry.js";
import { darkRouteGate } from "./dark-route-gate.js";
import { handOffAccountLink, linkStartScheme } from "./link-handoff.js";
import {
  calendarLinkRedirect,
  OUTLOOK_CALENDAR_STATE_MARKER,
  outlookCalendarRoutes,
} from "./outlook-calendar-link.js";

// Same demo sentinel as routes/auth.ts (module-private there).
const DEMO_USER_ID = "demo-user";

// Same ceiling rationale as MAX_LINKED_INBOXES / MAX_NAVER_ACCOUNTS: a cap
// per provider keeps one user from unbounded row growth and sync fan-out.
const MAX_OUTLOOK_INBOXES = 10;

// State marker in the signed JWT's email field — the same scheme the Google
// callback branches on (__link_inbox__ / __link_calendar__). This module has
// its own callback, so the marker is verified for equality instead.
const STATE_MARKER = "__link_outlook__" as const;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// OAuth authorization codes routinely exceed 500 chars (Azure AD ~800), so the
// callback params get 2048 instead of the blanket 500 used elsewhere.
const outlookCallbackQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    code: { type: "string", maxLength: 2048 },
    state: { type: "string", maxLength: 2048 },
    error: { type: "string", maxLength: 2048 },
  },
} as const;

/** The state a callback carries, when it is a valid state at all: which flow started it. */
function verifiedStateOf(state: string | undefined): { userId: string; email: string } | null {
  if (!state) return null;
  try {
    return verifyToken(state);
  } catch {
    return null;
  }
}

/**
 * The inbox branch of the Outlook callback, moved here unchanged except that it
 * RETURNS the relative path the browser goes to instead of redirecting. Run by
 * POST /api/auth/link/complete for the session of the user who started the
 * flow; the callback itself only parks the code.
 */
export async function finishOutlookInboxLink(userId: string, code: string): Promise<string> {
  try {
    const tokens = await exchangeOutlookCode(code);
    if ("error" in tokens) {
      return "/settings?inbox=failed";
    }
    // A DIFFERENT Microsoft account is attached to the ALREADY-logged-in
    // user (userId) as an additional mail source. We never
    // resolve or switch the session user by this address — the linked
    // token only feeds this user's own firewall.
    const accountEmail = await fetchOutlookAccountEmail(tokens.accessToken);
    if (!accountEmail) {
      return "/settings?inbox=failed";
    }
    const linker = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!linker) {
      return "/settings?inbox=failed";
    }
    const linkedEmail = normalizeEmail(accountEmail);
    // Re-check at callback time, with the real address (TOCTOU): the
    // first mailbox is free, a second one needs Pro — a user who got a
    // mailbox or downgraded during the 10-min OAuth window cannot finish.
    // Re-linking this same account is never refused. Inert while the
    // paywall is off.
    const account = { provider: "OUTLOOK" as const, email: linkedEmail };
    if (!(await mayConnectMailAccount(userId, account))) {
      return "/settings?inbox=pro";
    }
    // Cap NEW links only: a re-link (existing row → update path) must
    // always be allowed so a user can never lock themselves out of
    // reconnecting an inbox they already have.
    // Case-insensitive: a legacy mixed-case row of this address is the
    // same account, re-linked in place (its stored address kept).
    const existingLink = await findOwnedLinkedAccount(userId, {
      provider: "OUTLOOK",
      email: linkedEmail,
    });
    if (!existingLink) {
      const linkedCount = await prisma.linkedInboxAccount.count({
        where: { userId: userId, provider: "OUTLOOK" },
      });
      if (linkedCount >= MAX_OUTLOOK_INBOXES) {
        return "/settings?inbox=limit";
      }
    }
    const saved = await prisma.linkedInboxAccount.upsert({
      where: {
        userId_provider_email: {
          userId: userId,
          provider: "OUTLOOK",
          email: existingLink?.email ?? linkedEmail,
        },
      },
      update: {
        accessToken: encryptToken(tokens.accessToken),
        refreshToken: encryptOptional(tokens.refreshToken),
        expiresAt: tokens.expiresAt,
        // Re-linking a previously-revoked inbox clears the reconnect prompt.
        needsReconnect: false,
      },
      create: {
        userId: userId,
        // The schema default is GOOGLE — an Outlook row must say so.
        provider: "OUTLOOK",
        email: linkedEmail,
        accessToken: encryptToken(tokens.accessToken),
        refreshToken: encryptOptional(tokens.refreshToken),
        expiresAt: tokens.expiresAt,
      },
    });
    // Check-after-insert for a NEW row: a parallel first connect of
    // another account may have committed meanwhile. Fails closed.
    if (!existingLink && !(await keepIfOnlyMailSource(userId, { ...account, id: saved.id }))) {
      return "/settings?inbox=pro";
    }
    return "/settings?inbox=success";
  } catch (err) {
    // console first — captureError is a no-op without a Sentry DSN.
    console.error("[outlook-oauth] callback failed:", err);
    captureError(err, { tags: { scope: "outlook-oauth.callback" } });
    return "/settings?inbox=failed";
  }
}

export function outlookAuthRoutes(opts: {
  gate: () => boolean;
  /** Gate of the calendar link (step C4); defaults to OUTLOOK_CALENDAR_ENABLED + OUTLOOK_INBOX_ENABLED. */
  calendarGate?: () => boolean;
}): (app: FastifyInstance) => Promise<void> {
  const calendarGate = opts.calendarGate ?? outlookCalendarEnabled;
  return async function routes(app: FastifyInstance) {
    app.addHook("onRequest", darkRouteGate(opts.gate));
    await app.register(outlookCalendarRoutes({ gate: calendarGate }));

    // POST /link-inbox — start OAuth to link an Outlook account as a full
    // inbox. The first mailbox is free, a second one Pro. Short-lived signed state (10 min):
    // the callback attaches a credential-bearing row, so an intercepted
    // state URL must not be replayable for the default 7-day token window.
    app.post(
      "/link-inbox",
      {
        // First mailbox free, a second one Pro (mail-account-entitlement.ts);
        // the callback re-checks with the real address.
        preHandler: [requireAuth, requireMailLinkStart("OUTLOOK")],
        // OAuth-start endpoint on a public repo: cap starts so a valid token
        // can't spam consent redirects (same limit as the Google link route).
        config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
      },
      async (request, reply) => {
        const userId = getUserId(request);
        if (userId === DEMO_USER_ID) {
          return reply.code(403).send({ error: "Authentication required to link an inbox" });
        }
        if (!outlookConfigured()) {
          // Flag flipped on but the Azure app registration's credentials are
          // not in the env: fail loudly for the operator instead of sending
          // the user to a consent screen that will reject the client_id.
          return reply.code(503).send({ error: "Outlook linking is not configured" });
        }
        const signedState = signToken(
          { userId, email: STATE_MARKER, ...linkStartScheme(request) },
          "10m",
        );
        return reply.send({ url: getOutlookAuthUrl(signedState) });
      },
    );

    // GET /callback — Microsoft redirects the browser here after consent.
    app.get(
      "/callback",
      { schema: { querystring: outlookCallbackQuerySchema } },
      async (request, reply) => {
        const {
          code,
          state,
          error: oauthError,
        } = request.query as { code?: string; state?: string; error?: string };

        const webUrl = process.env.WEB_URL || "http://localhost:8001";

        // Consent denied (or any provider-side error). The error value rides
        // the redirect and is attacker-influenced — never reflected or logged
        // verbatim; every variant maps to the fixed outlook_denied marker.
        if (oauthError) {
          console.warn(
            `[outlook-oauth] callback returned provider error (access_denied=${oauthError === "access_denied"})`,
          );
          // A calendar link lands back on the calendar; anything else, including
          // a missing or forged state, keeps the inbox marker.
          if (verifiedStateOf(state)?.email === OUTLOOK_CALENDAR_STATE_MARKER) {
            return reply.redirect(calendarLinkRedirect(webUrl, "failed"));
          }
          return reply.redirect(`${webUrl}/settings?inbox=outlook_denied`);
        }

        if (!code) {
          return reply.code(400).send({ error: "Missing authorization code" });
        }
        if (!state) {
          return reply.code(400).send({ error: "Missing state parameter" });
        }
        let statePayload: { userId: string; email: string; appScheme?: string };
        try {
          statePayload = verifyToken(state);
        } catch {
          return reply.code(400).send({ error: "Invalid or expired OAuth state" });
        }
        // The calendar link (step C4) is finished by its own module: the marker
        // decides, and it is only ever in a state this server signed for that flow.
        if (statePayload.email === OUTLOOK_CALENDAR_STATE_MARKER) {
          // The flag was turned off after this flow started (the state lives 10
          // minutes): nothing is parked, exchanged or written.
          if (!calendarGate()) return reply.redirect(calendarLinkRedirect(webUrl, "failed"));
          return handOffAccountLink(reply, {
            userId: statePayload.userId,
            marker: OUTLOOK_CALENDAR_STATE_MARKER,
            code,
            appScheme: statePayload.appScheme,
            webUrl,
          });
        }
        // A valid session JWT is NOT a valid link state: the marker must match,
        // or a stolen ordinary token could be replayed into this flow.
        if (statePayload.email !== STATE_MARKER) {
          return reply.code(400).send({ error: "Invalid or expired OAuth state" });
        }

        // The state proves only which user STARTED the link, not that this
        // browser is theirs. The code is parked for that user's own session,
        // which finishes it through POST /api/auth/link/complete
        // (finishOutlookInboxLink above); it is never exchanged here.
        return handOffAccountLink(reply, {
          userId: statePayload.userId,
          marker: STATE_MARKER,
          code,
          appScheme: statePayload.appScheme,
          webUrl,
        });
      },
    );

    // GET /linked-inboxes — list OUTLOOK rows (never tokens). Auth-only (like the IMAP /status): a Free user's FIRST mailbox may be an
    // Outlook one, and a downgraded user must still see what they can remove.
    app.get("/linked-inboxes", { preHandler: requireAuth }, async (request) => {
      const userId = getUserId(request);
      const accounts = await prisma.linkedInboxAccount.findMany({
        where: { userId, provider: "OUTLOOK" },
        select: {
          id: true,
          email: true,
          createdAt: true,
          lastSyncedAt: true,
          needsReconnect: true,
        },
        orderBy: { createdAt: "asc" },
      });
      return { accounts, canConnect: await canConnectNewMailAccount(userId) };
    });

    // DELETE /linked-inboxes/:id — unlink one. Scoped by userId so a token
    // can only remove its OWN linked accounts; auth-only (not Pro-gated) so
    // a downgraded user can always disconnect. Past synced mail is kept
    // (AttentionItem/DecisionLabel reference it), same as the Google surface.
    app.delete("/linked-inboxes/:id", { preHandler: requireAuth }, async (request, reply) => {
      const userId = getUserId(request);
      const { id } = request.params as { id: string };
      const result = await prisma.linkedInboxAccount.deleteMany({
        // provider-scoped so this endpoint can never remove a GOOGLE or
        // IMAP-provider row by id.
        where: { id, userId, provider: "OUTLOOK" },
      });
      if (result.count === 0) {
        return reply.code(404).send({ error: "Linked inbox not found" });
      }
      return { success: true };
    });
  };
}
