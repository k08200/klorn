/**
 * Subscriptions — the per-sender bulk unsubscriber (Mail → Subscriptions).
 *
 * GET  /api/email/subscriptions — the senders of the caller's last 90 days of
 *      mail that carry List-Unsubscribe info, one row per (sender address,
 *      connected account). Accounts are never merged: the same newsletter in two
 *      inboxes is two subscriptions, and unsubscribing one must not act as the
 *      other account.
 * POST /api/email/subscriptions/unsubscribe {sender, linkedInboxAccountId,
 *      archive?} — unsubscribe through that sender's newest mail in that account
 *      (mail/unsubscribe-action, the same steps as POST /:id/unsubscribe), and
 *      with `archive` also archive its most recent mail in that account through
 *      the bulk-archive path (attention items closed).
 *
 * User-initiated only; nothing here runs on a schedule. Dark (Fastify's default
 * 404) while BULK_UNSUBSCRIBE_ENABLED is off.
 */

import type {
  EmailSubscriptionsResponse,
  EmailSubscriptionUnsubscribeResponse,
  EmailSubscriptionWire,
  EmailUnsubscribeMethod,
} from "@klorn/contract";
import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { prisma } from "../db.js";
import { unsubscribeFromEmail } from "../mail/unsubscribe-action.js";
import { darkRouteGate } from "./dark-route-gate.js";
import { archiveEmailMessages } from "./email-bulk.js";

export const SUBSCRIPTIONS_WINDOW_DAYS = 90;
export const SUBSCRIPTIONS_MAX_ROWS = 200;
/** The most recent mail archived per request — the bulk-archive cap. */
export const SUBSCRIPTION_ARCHIVE_LIMIT = 100;

const MAX_SENDER_CHARS = 320;
const MAX_ACCOUNT_ID_CHARS = 128;
const SENDER_RE = /^[^\s@<>]+@[^\s@<>]+$/;

/** Mail that offers an unsubscribe target of any kind. */
const HAS_UNSUBSCRIBE = {
  OR: [{ listUnsubscribeUrl: { not: null } }, { listUnsubscribeMailto: { not: null } }],
};

interface SubscriptionKey {
  sender: string;
  linkedInboxAccountId: string | null;
}

const keyOf = (sender: string, account: string | null) => `${account ?? ""}\u0000${sender}`;

/** "Acme News <news@acme.com>" → "Acme News"; null when the header has no name. */
export function displayNameOf(from: string | null | undefined, address: string): string | null {
  if (!from) return null;
  const at = from.indexOf("<");
  if (at <= 0) return null;
  const name = from
    .slice(0, at)
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .trim();
  if (!name || name.toLowerCase() === address) return null;
  return name.slice(0, 200);
}

/** The most automatic method any of the group's mail offers. */
function methodOf(oneClickCount: number, anyMailto: string | null): EmailUnsubscribeMethod {
  if (oneClickCount > 0) return "one-click";
  return anyMailto ? "mailto" : "link";
}

export async function listSubscriptions(userId: string): Promise<EmailSubscriptionsResponse> {
  const since = new Date(Date.now() - SUBSCRIPTIONS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const where = {
    userId,
    receivedAt: { gte: since },
    fromAddress: { not: null },
    ...HAS_UNSUBSCRIBE,
  };
  const groups = await prisma.emailMessage.groupBy({
    by: ["fromAddress", "linkedInboxAccountId"],
    where,
    _count: { _all: true },
    _max: { receivedAt: true, from: true, listUnsubscribeMailto: true },
    orderBy: { _count: { fromAddress: "desc" } },
    take: SUBSCRIPTIONS_MAX_ROWS,
  });
  if (groups.length === 0) {
    return { subscriptions: [], windowDays: SUBSCRIPTIONS_WINDOW_DAYS };
  }

  const senders = [...new Set(groups.map((g) => g.fromAddress).filter((s): s is string => !!s))];
  const accountIds = [
    ...new Set(groups.map((g) => g.linkedInboxAccountId).filter((a): a is string => !!a)),
  ];
  const narrowed = { ...where, fromAddress: { in: senders } };
  const [unread, oneClick, accounts, user] = await Promise.all([
    prisma.emailMessage.groupBy({
      by: ["fromAddress", "linkedInboxAccountId"],
      where: { ...narrowed, isRead: false },
      _count: { _all: true },
    }),
    prisma.emailMessage.groupBy({
      by: ["fromAddress", "linkedInboxAccountId"],
      where: { ...narrowed, listUnsubscribeOneClick: true },
      _count: { _all: true },
    }),
    accountIds.length > 0
      ? prisma.linkedInboxAccount.findMany({
          where: { userId, id: { in: accountIds } },
          select: { id: true, email: true },
        })
      : Promise.resolve([]),
    prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
  ]);

  const countBy = (rows: typeof unread) =>
    new Map(rows.map((r) => [keyOf(r.fromAddress ?? "", r.linkedInboxAccountId), r._count._all]));
  const unreadBy = countBy(unread);
  const oneClickBy = countBy(oneClick);
  const labelBy = new Map(accounts.map((a) => [a.id, a.email]));

  const subscriptions: EmailSubscriptionWire[] = [];
  for (const g of groups) {
    const sender = g.fromAddress;
    const lastReceivedAt = g._max.receivedAt;
    if (!sender || !lastReceivedAt) continue;
    const key = keyOf(sender, g.linkedInboxAccountId);
    const account = g.linkedInboxAccountId;
    subscriptions.push({
      sender,
      displayName: displayNameOf(g._max.from, sender),
      linkedInboxAccountId: account,
      accountLabel: account ? (labelBy.get(account) ?? null) : (user?.email ?? null),
      count: g._count._all,
      unreadCount: unreadBy.get(key) ?? 0,
      lastReceivedAt: lastReceivedAt.toISOString(),
      method: methodOf(oneClickBy.get(key) ?? 0, g._max.listUnsubscribeMailto),
    });
  }
  // The database orders by count; the tie-break (newest first) is ours.
  subscriptions.sort(
    (a, b) => b.count - a.count || b.lastReceivedAt.localeCompare(a.lastReceivedAt),
  );
  return { subscriptions, windowDays: SUBSCRIPTIONS_WINDOW_DAYS };
}

export type ParsedUnsubscribeBody =
  | { ok: true; key: SubscriptionKey; archive: boolean }
  | { ok: false; error: string };

/** Boundary validation for the POST body. The sender is normalized like `fromAddress`. */
export function parseUnsubscribeBody(body: unknown): ParsedUnsubscribeBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Body must be an object." };
  }
  const { sender, linkedInboxAccountId, archive } = body as Record<string, unknown>;
  if (typeof sender !== "string") return { ok: false, error: "sender must be a string." };
  const normalized = sender.trim().toLowerCase();
  if (normalized.length > MAX_SENDER_CHARS || !SENDER_RE.test(normalized)) {
    return { ok: false, error: "sender must be an email address." };
  }
  if (linkedInboxAccountId !== null) {
    if (
      typeof linkedInboxAccountId !== "string" ||
      linkedInboxAccountId.trim() === "" ||
      linkedInboxAccountId.length > MAX_ACCOUNT_ID_CHARS
    ) {
      return {
        ok: false,
        error: "linkedInboxAccountId must be an account id, or null for the primary account.",
      };
    }
  }
  if (archive !== undefined && typeof archive !== "boolean") {
    return { ok: false, error: "archive must be a boolean." };
  }
  return {
    ok: true,
    key: { sender: normalized, linkedInboxAccountId: linkedInboxAccountId ?? null },
    archive: archive === true,
  };
}

/**
 * Archive the sender's most recent mail in one account through the bulk-archive
 * path, which also closes the archived mail's attention items. Rows still present
 * are the ones not yet archived (an archive deletes the row).
 */
async function archiveSenderMail(scope: {
  userId: string;
  fromAddress: string;
  linkedInboxAccountId: string | null;
}): Promise<{ archived: number; archiveFailed: number }> {
  const recent = await prisma.emailMessage.findMany({
    where: scope,
    orderBy: { receivedAt: "desc" },
    take: SUBSCRIPTION_ARCHIVE_LIMIT,
  });
  if (recent.length === 0) return { archived: 0, archiveFailed: 0 };
  const result = await archiveEmailMessages(scope.userId, recent);
  return { archived: result.updatedCount, archiveFailed: result.failed.length };
}

export function emailSubscriptionsRoutes(opts: {
  gate: () => boolean;
}): (app: FastifyInstance) => Promise<void> {
  return async function routes(app: FastifyInstance) {
    // Before any auth hook, so a probe cannot tell a dark route from a missing one.
    app.addHook("onRequest", darkRouteGate(opts.gate));

    app.get("/subscriptions", { preHandler: requireAuth }, (request) =>
      listSubscriptions(getUserId(request)),
    );

    app.post(
      "/subscriptions/unsubscribe",
      {
        preHandler: requireAuth,
        config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      },
      async (request, reply) => {
        const uid = getUserId(request);
        const parsed = parseUnsubscribeBody(request.body);
        if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
        const { sender, linkedInboxAccountId } = parsed.key;
        // userId-scoped, and in THIS account only: the newest mail that offers a target.
        const scope = { userId: uid, fromAddress: sender, linkedInboxAccountId };
        const newest = await prisma.emailMessage.findFirst({
          where: { ...scope, ...HAS_UNSUBSCRIBE },
          orderBy: { receivedAt: "desc" },
          select: {
            id: true,
            linkedInboxAccountId: true,
            listUnsubscribeMailto: true,
            listUnsubscribeUrl: true,
            listUnsubscribeOneClick: true,
          },
        });
        if (!newest) return reply.code(404).send({ error: "Subscription not found" });

        const outcome = await unsubscribeFromEmail(uid, newest);
        // A failed unsubscribe archives nothing: the user asked for both, and
        // half of it silently done is harder to reason about than neither.
        if (!outcome.ok) return reply.code(outcome.statusCode).send({ error: outcome.error });

        const { archived, archiveFailed } = parsed.archive
          ? await archiveSenderMail(scope)
          : { archived: 0, archiveFailed: 0 };
        const response: EmailSubscriptionUnsubscribeResponse = {
          ...outcome.body,
          archived,
          archiveFailed,
        };
        return response;
      },
    );
  };
}
