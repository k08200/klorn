/**
 * IMAP provider connection routes (formerly routes/naver-imap.ts; a
 * per-provider factory since Phase 2). Registered once per provider:
 *
 *   GET  /api/<prefix>/status     — connected accounts (multi since 0b)
 *   POST /api/<prefix>/connect    — body { email, password } → verify + row
 *   POST /api/<prefix>/disconnect — body { email? } → remove one, or all
 *
 * `password` is the app password the user generates in the provider's
 * security settings (Naver "외부 메일 가져오기 비밀번호", Apple
 * app-specific password) — NOT their account login password. We test the
 * credentials with a short IMAP LOGIN handshake before persisting them so a
 * typo doesn't quietly leave the user "connected" with bad creds that fail
 * on every poll.
 *
 * Phase 0b (docs/providers/multi-provider-plan.md): credentials live in
 * LinkedInboxAccount rows — one row per mailbox, which is what makes this
 * multi-account. The old response shape (connected/email/host/connectedAt =
 * the first account) is preserved for existing Naver clients; `accounts` is
 * the real list. New providers reuse the same shape so the settings UI is
 * one component.
 *
 * `opts.gate` (Phase 2, CASA surface freeze): while the provider's flag is
 * OFF every route — including unauthenticated probes — answers 404, so the
 * DAST-scanned surface is identical to the flag not existing at all.
 *
 * Generic IMAP (step B4, `cfg.hostPolicy === "user-supplied"`): the body's `host`
 * is REQUIRED and is a DNS name on port 993, checked by the host grammar before
 * anything else, before an attempt is counted and with messages that depend only
 * on the input. The attempt is then counted (10 an hour per user) and verified
 * through the pinned connection; every connection failure answers one message.
 * See docs/providers/unified-platform-plan.md, B4.
 */

import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { requireEntitled } from "../billing/entitlement-guard.js";
import { encryptToken } from "../crypto-tokens.js";
import { prisma } from "../db.js";
import { takeGenericImapAttempt } from "../mail/generic-imap-attempts.js";
import { type HostRejection, parseGenericImapHost } from "../mail/generic-imap-host.js";
import { verifyGenericImapCredentials } from "../mail/generic-imap-verify.js";
import { clearPollBackoff } from "../mail/imap-poll-backoff.js";
import { hostMatchesProvider, type ImapProviderConfig } from "../mail/imap-providers.js";
import { verifyImapCredentials } from "../mail/imap-sync.js";
import { isAllowedImapHost } from "../mail/is-allowed-imap-host.js";
import { darkRouteGate } from "./dark-route-gate.js";

const GENERIC_HOST_HINT =
  "Enter your mail server's host name, for example imap.example.com. Only port 993 (IMAP over TLS) is supported.";

/** What the user is told about a host the grammar refused. A function of the input only, never of the network. */
const GENERIC_HOST_MESSAGES: Readonly<Record<HostRejection, string>> = {
  empty: GENERIC_HOST_HINT,
  "too-long": GENERIC_HOST_HINT,
  "invalid-format": GENERIC_HOST_HINT,
  "single-label": GENERIC_HOST_HINT,
  "internal-suffix": "Only public mail servers can be connected.",
  "ip-literal": "Use the server's host name, not an IP address.",
  "port-not-allowed": "Only port 993 (IMAP over TLS) is supported.",
  "built-in-provider": "Use the built-in connection for that provider instead.",
};

/**
 * Re-pointing an existing generic account at another server is refused (v1). The row
 * keeps its INBOX UIDVALIDITY and every message row from the old server; the next
 * poll would either hold the mailbox forever (the new server's UIDVALIDITY differs) or,
 * when both servers happen to report the same value, treat the new server's UIDs as
 * the old messages' (same ids, `generic-imap:<email>:<uid>`) and dedupe real mail away.
 * The follow-up is the UIDVALIDITY re-key with tombstones of step B2b, done on a host
 * change. A constant: it says nothing about either host.
 */
const SERVER_CHANGE_REFUSED =
  "Disconnect this account first; changing the server is not supported yet.";

const TOO_MANY_ATTEMPTS = "Too many connection attempts. Try again later.";

const connectBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["email", "password"],
  properties: {
    email: { type: "string", format: "email", maxLength: 200 },
    password: { type: "string", minLength: 4, maxLength: 200 },
    host: { type: "string", maxLength: 200 },
  },
} as const;

type HostChoice = { ok: true; imapHost: string } | { ok: false; message: string };

/**
 * The host to store and connect to, or why the request's host is refused. No network
 * is involved, so the answer depends on the input alone.
 *
 * Generic IMAP: a DNS name on 993 and nothing else (the grammar), folded to its
 * stored form. Fixed providers: the SSRF guard. This host is opened as a TLS
 * connection here AND on every subsequent poll, so anything outside the provider
 * allowlist is refused before we connect, and a user can't probe internal hosts via
 * this endpoint. Host and provider are pinned together: the global allowlist alone
 * would let a NAVER row point at the iCloud host (and vice versa).
 */
function resolveConnectHost(cfg: ImapProviderConfig, host: string | undefined): HostChoice {
  if (cfg.hostPolicy === "user-supplied") {
    const parsed = parseGenericImapHost(host);
    return parsed.ok
      ? { ok: true, imapHost: parsed.stored }
      : { ok: false, message: GENERIC_HOST_MESSAGES[parsed.reason] };
  }
  const imapHost = (host ?? cfg.defaultHost ?? "").trim();
  if (!isAllowedImapHost(imapHost) || !hostMatchesProvider(imapHost, cfg)) {
    return { ok: false, message: `Unsupported IMAP host. Only ${cfg.defaultHost} is allowed.` };
  }
  return { ok: true, imapHost };
}

type Refusal = { status: number; message: string };

/** Would this request move an existing generic account to another server? Compared in folded form. */
function isServerChange(
  cfg: ImapProviderConfig,
  storedHost: string | null | undefined,
  requestedHost: string,
): boolean {
  if (cfg.hostPolicy !== "user-supplied") return false;
  const stored = parseGenericImapHost(storedHost);
  return !stored.ok || stored.stored !== requestedHost;
}

interface ExistingAccount {
  id: string;
  imapHost: string | null;
}

async function findExistingAccount(
  cfg: ImapProviderConfig,
  userId: string,
  email: string,
): Promise<ExistingAccount | null> {
  return prisma.linkedInboxAccount.findUnique({
    where: { userId_provider_email: { userId, provider: cfg.provider, email } },
    select: { id: true, imapHost: true },
  });
}

/**
 * What stops this connect before any connection is made, or null.
 *   - An existing account may be re-verified (password rotation) on the SAME host and
 *     never on another (409, see SERVER_CHANGE_REFUSED).
 *   - NEW accounts are capped; re-verifying an address that already has a row is
 *     always allowed, mirroring the Google link route's "never lock a user out of
 *     reconnecting" rule.
 * This look is advisory: for a generic host the write below re-checks it atomically.
 */
async function connectRefusal(
  cfg: ImapProviderConfig,
  userId: string,
  existing: ExistingAccount | null,
  imapHost: string,
): Promise<Refusal | null> {
  if (existing) {
    return isServerChange(cfg, existing.imapHost, imapHost)
      ? { status: 409, message: SERVER_CHANGE_REFUSED }
      : null;
  }
  const count = await prisma.linkedInboxAccount.count({
    where: { userId, provider: cfg.provider },
  });
  return count >= cfg.maxAccounts
    ? { status: 400, message: `At most ${cfg.maxAccounts} ${cfg.label} accounts.` }
    : null;
}

interface SaveArgs {
  userId: string;
  email: string;
  imapHost: string;
  password: string;
  existing: ExistingAccount | null;
}

type Saved = { ok: true; id: string | undefined } | { ok: false };

/** Prisma's unique-constraint violation (the (user, provider, email) key). */
const isUniqueViolation = (err: unknown): boolean =>
  (err as { code?: unknown } | null)?.code === "P2002";

/**
 * Store a generic account WITHOUT letting two requests race past the re-point check
 * (a check-then-upsert let two concurrent first connects to different hosts both pass,
 * the second re-pointing the row the first had just made). An existing row is updated
 * only while it still has the host it was checked with; a new row is created, and a
 * collision with a concurrent create is settled by looking at the winner: the same host
 * is a double click, another host is refused. Never an upsert.
 */
async function saveGenericAccount(cfg: ImapProviderConfig, args: SaveArgs): Promise<Saved> {
  const { userId, email, imapHost, password } = args;
  const imapPasswordCipher = encryptToken(password);
  let current = args.existing;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (current) {
      const updated = await prisma.linkedInboxAccount.updateMany({
        where: { id: current.id, userId, provider: cfg.provider, imapHost: current.imapHost },
        // A successful re-verify clears the reconnect prompt.
        data: { imapHost, imapPasswordCipher, needsReconnect: false },
      });
      return updated.count === 1 ? { ok: true, id: current.id } : { ok: false };
    }
    try {
      const created = await prisma.linkedInboxAccount.create({
        data: { userId, provider: cfg.provider, email, imapHost, imapPasswordCipher },
      });
      return { ok: true, id: created?.id };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      current = await findExistingAccount(cfg, userId, email); // a concurrent request won
      if (current && isServerChange(cfg, current.imapHost, imapHost)) return { ok: false };
    }
  }
  return { ok: false };
}

/** Fixed-host providers keep the upsert they always had (their host cannot differ). */
async function saveFixedAccount(cfg: ImapProviderConfig, args: SaveArgs): Promise<Saved> {
  const { userId, email, imapHost, password } = args;
  const saved = await prisma.linkedInboxAccount.upsert({
    where: { userId_provider_email: { userId, provider: cfg.provider, email } },
    create: {
      userId,
      provider: cfg.provider,
      email,
      imapHost,
      imapPasswordCipher: encryptToken(password),
    },
    update: {
      imapHost,
      imapPasswordCipher: encryptToken(password),
      // A successful re-verify clears the reconnect prompt.
      needsReconnect: false,
    },
  });
  return { ok: true, id: saved?.id };
}

const saveAccount = (cfg: ImapProviderConfig, args: SaveArgs): Promise<Saved> =>
  cfg.hostPolicy === "user-supplied" ? saveGenericAccount(cfg, args) : saveFixedAccount(cfg, args);

/**
 * Counts this connect attempt when the host is user-supplied (design D5): every
 * verify then opens a real connection to a host the user chose. Null when the attempt
 * is allowed (or not counted), else how long to wait.
 */
function retryAfterMsFor(cfg: ImapProviderConfig, userId: string): number | null {
  if (cfg.hostPolicy !== "user-supplied") return null;
  const attempt = takeGenericImapAttempt(userId);
  return attempt.allowed ? null : attempt.retryAfterMs;
}

/** A user-supplied host gets the verify whose failures all read the same. */
const verifierFor = (cfg: ImapProviderConfig) =>
  cfg.hostPolicy === "user-supplied" ? verifyGenericImapCredentials : verifyImapCredentials;

export function imapConnectRoutes(
  cfg: ImapProviderConfig,
  opts: { gate?: () => boolean } = {},
): (app: FastifyInstance) => Promise<void> {
  return async function routes(app: FastifyInstance) {
    // Feature-flag gate FIRST — shared darkRouteGate (see its doc comment
    // for why onRequest and why the body must match Fastify's default 404).
    if (opts.gate) {
      app.addHook("onRequest", darkRouteGate(opts.gate));
    }
    app.addHook("preHandler", requireAuth);

    app.get("/status", async (request) => {
      const userId = getUserId(request);
      const rows = await prisma.linkedInboxAccount.findMany({
        where: { userId, provider: cfg.provider },
        select: {
          email: true,
          imapHost: true,
          createdAt: true,
          lastSyncedAt: true,
          needsReconnect: true,
        },
        orderBy: { createdAt: "asc" },
      });
      const first = rows[0];
      return {
        // Legacy single-account shape — existing web/desktop clients read these.
        connected: rows.length > 0,
        email: first?.email ?? null,
        host: first?.imapHost ?? null,
        connectedAt: first?.createdAt.toISOString() ?? null,
        // The real list (multi-account since Phase 0b).
        accounts: rows.map((r) => ({
          email: r.email,
          host: r.imapHost,
          connectedAt: r.createdAt.toISOString(),
          lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null,
          needsReconnect: r.needsReconnect,
        })),
      };
    });

    app.post<{
      Body: { email: string; password: string; host?: string };
    }>(
      "/connect",
      {
        // Multi-account (connecting a SECOND inbox beyond the primary Google
        // account) is a paid feature — Pro/Team/Enterprise only. requireAuth
        // first sets userId for requireEntitled. Inert while the paywall is off.
        // /status (read) and /disconnect stay open so a downgraded user can still
        // see and remove an inbox they connected while paid.
        preHandler: [requireAuth, requireEntitled],
        schema: { body: connectBodySchema },
        // Every call opens a real IMAP connection to the provider; without a
        // tight limit this is both a credential-stuffing oracle and a way to
        // get our egress IP blocked by the provider.
        config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
      },
      async (request, reply) => {
        const userId = getUserId(request);
        const { email, password, host } = request.body;
        const hostChoice = resolveConnectHost(cfg, host);
        if (!hostChoice.ok) {
          reply.code(400);
          return { ok: false, message: hostChoice.message };
        }
        const { imapHost } = hostChoice;

        const existing = await findExistingAccount(cfg, userId, email);
        const refusal = await connectRefusal(cfg, userId, existing, imapHost);
        if (refusal) {
          reply.code(refusal.status);
          return { ok: false, message: refusal.message };
        }

        // Counted only now: the refusals above made no connection.
        const retryAfterMs = retryAfterMsFor(cfg, userId);
        if (retryAfterMs !== null) {
          reply.code(429).header("retry-after", Math.ceil(retryAfterMs / 1000));
          return { ok: false, message: TOO_MANY_ATTEMPTS };
        }

        // Smoke-test the credentials before persisting. We don't want the
        // user to leave the settings page thinking they're connected when
        // every subsequent poll will silently 401.
        const verify = await verifierFor(cfg)({
          provider: cfg,
          email,
          password,
          host: imapHost,
        });
        if (!verify.ok) {
          reply.code(400);
          return { ok: false, message: verify.message };
        }

        const saved = await saveAccount(cfg, { userId, email, imapHost, password, existing });
        if (!saved.ok) {
          // Another request changed the account's server while this one was being verified.
          reply.code(409);
          return { ok: false, message: SERVER_CHANGE_REFUSED };
        }
        // A relink starts the poll over: no leftover backoff for this account.
        if (saved.id && cfg.hostPolicy === "user-supplied") clearPollBackoff(saved.id);

        return { ok: true, email, host: imapHost };
      },
    );

    // No body schema on purpose: the deployed web client POSTs with NO body at
    // all, and a schema would 400 that. The optional email is validated by hand.
    app.post<{ Body: { email?: string } | null }>("/disconnect", async (request, reply) => {
      const userId = getUserId(request);
      const email = request.body?.email;
      if (email !== undefined && (typeof email !== "string" || email.length > 200)) {
        reply.code(400);
        return { ok: false, message: "email must be a string" };
      }
      // No email (the legacy client shape) removes every account for this
      // provider — exactly what the old single-account disconnect did.
      await prisma.linkedInboxAccount.deleteMany({
        where: { userId, provider: cfg.provider, ...(email ? { email } : {}) },
      });
      return { ok: true };
    });
  };
}
