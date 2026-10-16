/**
 * Outlook (Microsoft Graph) CALENDAR link routes — step C4 of
 * docs/providers/unified-platform-plan.md. They ride the Outlook OAuth flow of
 * routes/outlook-auth.ts (same app registration, same redirect URI, same
 * callback) and differ in three ways: a distinct signed-state marker picks the
 * calendar branch, the authorize request carries the calendar scope set
 * (Calendars.Read, no mail), and the result is a LinkedCalendarAccount.
 *
 *   POST   /link-calendar          — start OAuth (Pro-gated), returns { url }
 *   GET    /linked-calendars       — list OUTLOOK calendar accounts (never tokens)
 *   DELETE /linked-calendars/:id   — unlink one, with the events synced from it
 *   (the callback is outlook-auth.ts's; it parks a calendar state's code, and
 *   POST /api/auth/link/complete runs `finishOutlookCalendarLink`)
 *
 * Every route sits behind `outlookCalendarEnabled` (OUTLOOK_CALENDAR_ENABLED and
 * OUTLOOK_INBOX_ENABLED) via darkRouteGate: while off they answer Fastify's
 * default 404, exactly as if they were not registered.
 */

import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth, signToken } from "../auth.js";
import { requireEntitled } from "../billing/entitlement-guard.js";
import { isEntitled } from "../billing/stripe.js";
import { encryptOptional, encryptToken } from "../crypto-tokens.js";
import { prisma } from "../db.js";
import {
  exchangeOutlookCode,
  fetchOutlookAccountEmail,
  getOutlookAuthUrl,
  outlookConfigured,
} from "../mail/outlook-oauth.js";
import { unlinkCalendarAccount } from "../pim/linked-calendar-unlink.js";
import { captureError } from "../sentry.js";
import { darkRouteGate } from "./dark-route-gate.js";
import { linkStartScheme } from "./link-handoff.js";

/** State marker of a calendar link: distinct from the inbox link's `__link_outlook__`. */
export const OUTLOOK_CALENDAR_STATE_MARKER = "__link_outlook_calendar__" as const;

// Same demo sentinel as routes/auth.ts and routes/outlook-auth.ts (module-private there).
const DEMO_USER_ID = "demo-user";
// Same ceiling rationale as MAX_OUTLOOK_INBOXES: a cap per provider keeps one user
// from unbounded row growth and sync fan-out.
const MAX_OUTLOOK_CALENDARS = 10;
const PRISMA_UNIQUE_VIOLATION = "P2002";
const STATE_TTL = "10m";

const CALENDAR_PATH = "/calendar";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === PRISMA_UNIQUE_VIOLATION;
}

type LinkOutcome = "success" | "failed" | "limit";

/** The web path a calendar link lands on: the same `linked=` markers the Google flow uses. */
export function calendarLinkPath(outcome: LinkOutcome): string {
  return `${CALENDAR_PATH}?linked=${outcome}`;
}

/** Where the browser lands after a calendar link: the same `linked=` markers the Google flow uses. */
export function calendarLinkRedirect(webUrl: string, outcome: LinkOutcome): string {
  return `${webUrl}${calendarLinkPath(outcome)}`;
}

/** The cap applies to NEW links only: a re-link must always be allowed. */
async function isOverCap(userId: string, email: string): Promise<boolean> {
  const existing = await prisma.linkedCalendarAccount.findUnique({
    where: { userId_provider_email: { userId, provider: "OUTLOOK", email } },
    select: { id: true },
  });
  if (existing) return false;
  const count = await prisma.linkedCalendarAccount.count({
    where: { userId, provider: "OUTLOOK" },
  });
  return count >= MAX_OUTLOOK_CALENDARS;
}

async function saveAccount(
  userId: string,
  email: string,
  tokens: { accessToken: string; refreshToken: string | null; expiresAt: Date | null },
): Promise<void> {
  await prisma.linkedCalendarAccount.upsert({
    where: { userId_provider_email: { userId, provider: "OUTLOOK", email } },
    update: {
      accessToken: encryptToken(tokens.accessToken),
      refreshToken: encryptOptional(tokens.refreshToken),
      expiresAt: tokens.expiresAt,
      // Re-linking a previously-revoked calendar clears the reconnect prompt.
      needsReconnect: false,
    },
    create: {
      userId,
      // The schema default is GOOGLE: an Outlook row must say so.
      provider: "OUTLOOK",
      email,
      accessToken: encryptToken(tokens.accessToken),
      refreshToken: encryptOptional(tokens.refreshToken),
      expiresAt: tokens.expiresAt,
    },
  });
}

async function linkAccount(code: string, userId: string): Promise<LinkOutcome> {
  const tokens = await exchangeOutlookCode(code, "calendar");
  if ("error" in tokens) return "failed";
  // A DIFFERENT Microsoft account is attached to the ALREADY-logged-in user as an
  // additional calendar. The session user is never resolved or switched by this
  // address: the linked token only feeds this user's own calendar.
  const accountEmail = await fetchOutlookAccountEmail(tokens.accessToken);
  if (!accountEmail) return "failed";
  // Re-verify entitlement at callback time (TOCTOU): a Pro user who downgraded
  // during the 10-minute OAuth window must not complete a Pro-only link.
  const linker = await prisma.user.findUnique({
    where: { id: userId },
    select: { plan: true, role: true },
  });
  if (!linker || !isEntitled(linker.plan, linker.role)) return "failed";
  const email = normalizeEmail(accountEmail);
  if (await isOverCap(userId, email)) return "limit";
  await saveAccount(userId, email, tokens);
  return "success";
}

/**
 * The calendar branch of the Outlook callback (the state was verified and
 * carries the calendar marker). Always answers with a path: a failure must land
 * the user back on the calendar, never on a JSON error page. Run by
 * POST /api/auth/link/complete for the session of the user who started the
 * flow; the callback itself only parks the code.
 */
export async function finishOutlookCalendarLink(params: {
  code: string;
  userId: string;
  enabled: boolean;
}): Promise<string> {
  const { code, userId, enabled } = params;
  // The flag was turned off after this flow started (the state lives 10 minutes):
  // nothing is exchanged and nothing is written.
  if (!enabled) return calendarLinkPath("failed");
  try {
    return calendarLinkPath(await linkAccount(code, userId));
  } catch (err) {
    if (isUniqueViolation(err)) {
      // The address is already linked as ANOTHER provider's calendar, which the
      // legacy (userId, email) unique still forbids until the contract phase.
      console.warn(
        "[outlook-oauth] calendar link refused: address already linked as another provider",
      );
      return calendarLinkPath("failed");
    }
    // console first — captureError is a no-op without a Sentry DSN.
    console.error("[outlook-oauth] calendar callback failed:", err);
    captureError(err, { tags: { scope: "outlook-oauth.calendar-callback" } });
    return calendarLinkPath("failed");
  }
}

export function outlookCalendarRoutes(opts: {
  gate: () => boolean;
}): (app: FastifyInstance) => Promise<void> {
  return async function routes(app: FastifyInstance) {
    app.addHook("onRequest", darkRouteGate(opts.gate));

    // POST /link-calendar — start OAuth to link an Outlook account for its calendar
    // only (Calendars.Read, no mail). Pro-gated. Short-lived signed state: the
    // callback attaches a credential-bearing row, so an intercepted state URL must
    // not be replayable for the default 7-day token window.
    app.post(
      "/link-calendar",
      {
        preHandler: [requireAuth, requireEntitled],
        // OAuth-start endpoint on a public repo: cap starts (same limit as the inbox link).
        config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
      },
      async (request, reply) => {
        const userId = getUserId(request);
        if (userId === DEMO_USER_ID) {
          return reply.code(403).send({ error: "Authentication required to link a calendar" });
        }
        if (!outlookConfigured()) {
          // Flags on but the Azure registration's credentials are not in the env:
          // fail loudly for the operator instead of sending the user to a consent
          // screen that will reject the client_id.
          return reply.code(503).send({ error: "Outlook linking is not configured" });
        }
        const signedState = signToken(
          { userId, email: OUTLOOK_CALENDAR_STATE_MARKER, ...linkStartScheme(request) },
          STATE_TTL,
        );
        return reply.send({ url: getOutlookAuthUrl(signedState, "calendar") });
      },
    );

    // GET /linked-calendars — the OUTLOOK calendar accounts (never tokens).
    // Pro-gated to match the connect route.
    app.get(
      "/linked-calendars",
      { preHandler: [requireAuth, requireEntitled] },
      async (request) => {
        const userId = getUserId(request);
        const accounts = await prisma.linkedCalendarAccount.findMany({
          where: { userId, provider: "OUTLOOK" },
          select: { id: true, email: true, createdAt: true, needsReconnect: true },
          orderBy: { createdAt: "asc" },
        });
        return { accounts };
      },
    );

    // DELETE /linked-calendars/:id — unlink one, with its events and their
    // mirrored attention items in one transaction. Auth-only (not Pro-gated) so a
    // downgraded user can always disconnect; scoped by userId and to OUTLOOK.
    app.delete("/linked-calendars/:id", { preHandler: requireAuth }, async (request, reply) => {
      const userId = getUserId(request);
      const { id } = request.params as { id: string };
      if (!(await unlinkCalendarAccount(userId, id, "OUTLOOK"))) {
        return reply.code(404).send({ error: "Linked calendar not found" });
      }
      return { success: true };
    });
  };
}
