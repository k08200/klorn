/**
 * iCloud and Naver CALENDAR link routes, over CalDAV with an app-specific password
 * — step C3 of docs/providers/unified-platform-plan.md. Read-only calendars; the
 * server URL is never the caller's: it comes from the provider registry
 * (pim/caldav/caldav-providers.ts) and every request passes its host guard.
 *
 *   POST   /link                  — body { provider, username, password } or
 *                                   { provider, username, reuseInboxPassword: true };
 *                                   verify with a PROPFIND, then store (Pro-gated)
 *   GET    /linked-calendars      — the user's ICLOUD and NAVER calendar accounts (never a password)
 *   DELETE /linked-calendars/:id  — unlink one, with the events synced from it
 *
 * `reuseInboxPassword` takes the app password of the user's OWN linked inbox of the
 * same provider and address (LinkedInboxAccount, an IMAP link), so a user who
 * linked iCloud or Naver mail does not have to make a second app password. The
 * password stays on the server: it is decrypted, verified against CalDAV and stored
 * again as this account's own cipher. An Apple app-specific password already grants
 * the whole account, so the copy widens nothing; unlinking the inbox does not
 * unlink the calendar.
 *
 * Every route sits behind `caldavCalendarEnabled` (CALDAV_CALENDAR_ENABLED) via
 * darkRouteGate: while off they answer Fastify's default 404.
 *
 * Link attempts are limited twice (review fix 2026-10-02): per client IP, as the
 * IMAP connect route does, and per Apple ID or Naver ID (normalised, hashed), so
 * rotating IPs cannot hammer one account's password at Apple or Naver (a lockout
 * of the victim, and our egress IP blocked). The IMAP connect route still has the
 * IP limit only (noted in the plan; not changed here).
 */

import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { requireEntitled } from "../billing/entitlement-guard.js";
import { decryptToken, encryptToken } from "../crypto-tokens.js";
import { prisma } from "../db.js";
import { clearCaldavBackoff } from "../pim/caldav/caldav-backoff.js";
import { type CaldavLinkDeps, verifyCaldavLogin } from "../pim/caldav/caldav-link.js";
import {
  CALDAV_PROVIDERS,
  type CaldavAccountIdentity,
  type CaldavProviderConfig,
  type CaldavProviderKey,
  caldavAccountIdentity,
} from "../pim/caldav/caldav-providers.js";
import { unlinkCalendarAccount } from "../pim/linked-calendar-unlink.js";
import { darkRouteGate } from "./dark-route-gate.js";

// Same demo sentinel as routes/auth.ts and routes/outlook-calendar-link.ts.
const DEMO_USER_ID = "demo-user";
const PRISMA_UNIQUE_VIOLATION = "P2002";
const CALDAV_PROVIDER_KEYS: CaldavProviderKey[] = ["ICLOUD", "NAVER"];

/** The ONE answer to every failed verification: no server text, nothing to probe with. */
export const CALDAV_LINK_FAILED =
  "Could not connect this calendar. Check the address and the app-specific password.";

const linkBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["provider", "username"],
  properties: {
    provider: { type: "string", enum: CALDAV_PROVIDER_KEYS },
    username: { type: "string", minLength: 1, maxLength: 200 },
    password: { type: "string", minLength: 4, maxLength: 200 },
    reuseInboxPassword: { type: "boolean" },
  },
} as const;

interface LinkBody {
  provider: CaldavProviderKey;
  username: string;
  password?: string;
  reuseInboxPassword?: boolean;
}

/** Each limit: 5 attempts per 15 minutes, the IMAP connect route's. */
const LINK_ATTEMPTS = { max: 5, timeWindow: "15 minutes" } as const;
const LINK_LIMITED = "Too many attempts for this account. Try again later.";
const HTTP_TOO_MANY_REQUESTS = 429;

function fail(reply: FastifyReply, message: string) {
  reply.code(400);
  return { ok: false, message };
}

/** The cap applies to NEW links only: a re-link must always be allowed. */
async function isOverCap(
  userId: string,
  config: CaldavProviderConfig,
  email: string,
): Promise<boolean> {
  const existing = await prisma.linkedCalendarAccount.findUnique({
    where: { userId_provider_email: { userId, provider: config.provider, email } },
    select: { id: true },
  });
  if (existing) return false;
  const count = await prisma.linkedCalendarAccount.count({
    where: { userId, provider: config.provider },
  });
  return count >= config.maxAccounts;
}

/** The linked inbox's app password, or null (no such inbox, none stored, unreadable). */
async function inboxPassword(
  userId: string,
  config: CaldavProviderConfig,
  identity: CaldavAccountIdentity,
): Promise<string | null> {
  const inbox = await prisma.linkedInboxAccount.findUnique({
    where: {
      userId_provider_email: { userId, provider: config.provider, email: identity.accountEmail },
    },
    select: { imapPasswordCipher: true },
  });
  if (!inbox?.imapPasswordCipher) return null;
  try {
    return decryptToken(inbox.imapPasswordCipher);
  } catch {
    return null;
  }
}

async function saveAccount(
  userId: string,
  config: CaldavProviderConfig,
  identity: CaldavAccountIdentity,
  password: string,
) {
  const cipher = encryptToken(password);
  return prisma.linkedCalendarAccount.upsert({
    where: {
      userId_provider_email: { userId, provider: config.provider, email: identity.accountEmail },
    },
    create: {
      userId,
      // The schema default is GOOGLE: a CalDAV row must say which provider it is.
      provider: config.provider,
      email: identity.accountEmail,
      caldavPasswordCipher: cipher,
    },
    // Re-linking (a new app password) clears the reconnect prompt.
    update: { caldavPasswordCipher: cipher, needsReconnect: false },
    select: { id: true, provider: true, email: true },
  });
}

/**
 * The per-account key: provider and a hash of the normalised address (the raw
 * address never sits in the limiter's store). A body the schema let through always
 * has both; an address the provider refuses is keyed on its trimmed lowercase form.
 */
export function linkIdentityKey(request: FastifyRequest): string {
  const { provider, username } = request.body as LinkBody;
  const identity = caldavAccountIdentity(CALDAV_PROVIDERS[provider], username);
  const subject = identity?.accountEmail ?? username.trim().toLowerCase();
  const digest = createHash("sha256").update(subject, "utf8").digest("hex").slice(0, 32);
  return `caldav-link:${provider}:${digest}`;
}

type AccountLimiter = ReturnType<FastifyInstance["createRateLimit"]>;

/** The per-account limiter; none when the rate-limit plugin is not registered (some tests). */
function accountLimiter(app: FastifyInstance): AccountLimiter | null {
  if (!app.hasDecorator("createRateLimit")) return null;
  return app.createRateLimit({ ...LINK_ATTEMPTS, keyGenerator: linkIdentityKey });
}

/** True when this attempt is one too many for the account it names (and answers 429). */
async function overAccountLimit(
  limiter: AccountLimiter | null,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  if (!limiter) return false;
  const limit = await limiter(request);
  if (limit.isAllowed || !limit.isExceeded) return false;
  reply.header("retry-after", String(limit.ttlInSeconds));
  reply.code(HTTP_TOO_MANY_REQUESTS).send({ error: LINK_LIMITED });
  return true;
}

/** POST /link: verify the password with a PROPFIND, then store it (see the header). */
function linkHandler(limiter: AccountLimiter | null, deps: Partial<CaldavLinkDeps> | undefined) {
  return async (request: FastifyRequest<{ Body: LinkBody }>, reply: FastifyReply) => {
    const userId = getUserId(request);
    if (userId === DEMO_USER_ID) {
      return reply.code(403).send({ error: "Authentication required to link a calendar" });
    }
    const { provider, username, password, reuseInboxPassword } = request.body;
    const config = CALDAV_PROVIDERS[provider];
    if ((password === undefined) === (reuseInboxPassword !== true)) {
      return fail(reply, "Send either a password or reuseInboxPassword: true.");
    }
    const identity = caldavAccountIdentity(config, username);
    if (!identity) {
      return fail(
        reply,
        provider === "ICLOUD" ? "Use your Apple ID address." : "Use your Naver ID.",
      );
    }
    if (await isOverCap(userId, config, identity.accountEmail)) {
      return fail(reply, `At most ${config.maxAccounts} ${config.label} calendars.`);
    }
    if (await overAccountLimit(limiter, request, reply)) return reply;
    const secret = password ?? (await inboxPassword(userId, config, identity));
    if (!secret || !(await verifyCaldavLogin(config, identity, secret, deps))) {
      return fail(reply, CALDAV_LINK_FAILED);
    }
    return storeAccount(reply, userId, config, identity, secret);
  };
}

async function storeAccount(
  reply: FastifyReply,
  userId: string,
  config: CaldavProviderConfig,
  identity: CaldavAccountIdentity,
  secret: string,
) {
  try {
    const account = await saveAccount(userId, config, identity, secret);
    // A re-link (a new password, just verified) starts the failure backoff over.
    clearCaldavBackoff(account.id);
    return { ok: true, account };
  } catch (err) {
    if ((err as { code?: string })?.code !== PRISMA_UNIQUE_VIOLATION) throw err;
    // The address is already linked as ANOTHER provider's calendar, which the
    // legacy (userId, email) unique still forbids until the contract phase.
    console.warn("[CALDAV] calendar link refused: address already linked as another provider");
    return fail(reply, CALDAV_LINK_FAILED);
  }
}

/** GET /linked-calendars: the CalDAV calendar accounts (never a password). */
async function listHandler(request: FastifyRequest) {
  const userId = getUserId(request);
  const accounts = await prisma.linkedCalendarAccount.findMany({
    where: { userId, provider: { in: CALDAV_PROVIDER_KEYS } },
    select: { id: true, provider: true, email: true, createdAt: true, needsReconnect: true },
    orderBy: { createdAt: "asc" },
  });
  return { accounts };
}

/**
 * DELETE /linked-calendars/:id: unlink one CalDAV account, with its events and
 * their attention items in one transaction. The provider is read first, scoped to
 * the user and to ICLOUD/NAVER, so this surface can never remove a Google or
 * Outlook account by id.
 */
async function unlinkHandler(request: FastifyRequest, reply: FastifyReply) {
  const userId = getUserId(request);
  const { id } = request.params as { id: string };
  const account = await prisma.linkedCalendarAccount.findFirst({
    where: { id, userId, provider: { in: CALDAV_PROVIDER_KEYS } },
    select: { provider: true },
  });
  if (!account || !(await unlinkCalendarAccount(userId, id, account.provider))) {
    return reply.code(404).send({ error: "Linked calendar not found" });
  }
  return { success: true };
}

export function caldavCalendarRoutes(opts: {
  gate: () => boolean;
  /** Tests only: the CalDAV transport and resolver the verification uses. */
  deps?: Partial<CaldavLinkDeps>;
}): (app: FastifyInstance) => Promise<void> {
  return async function routes(app: FastifyInstance) {
    app.addHook("onRequest", darkRouteGate(opts.gate));
    app.post<{ Body: LinkBody }>(
      "/link",
      {
        preHandler: [requireAuth, requireEntitled],
        schema: { body: linkBodySchema },
        // Every attempt makes real requests to Apple or Naver with the given
        // password: per client IP here, per account in the handler (see the header).
        config: { rateLimit: LINK_ATTEMPTS },
      },
      linkHandler(accountLimiter(app), opts.deps),
    );
    // Pro-gated to match the link route.
    app.get("/linked-calendars", { preHandler: [requireAuth, requireEntitled] }, listHandler);
    // Auth-only (not Pro-gated) so a downgraded user can always disconnect.
    app.delete("/linked-calendars/:id", { preHandler: requireAuth }, unlinkHandler);
  };
}
