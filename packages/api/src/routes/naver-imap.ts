/**
 * Naver IMAP connection routes.
 *
 *   GET  /api/naver-imap/status     — is this user connected, and when?
 *   POST /api/naver-imap/connect    — body { email, password } → encrypt + save
 *   POST /api/naver-imap/disconnect — clear all four naverImap* columns
 *
 * `password` is the "외부 메일 가져오기 비밀번호" the user generates in
 * their Naver security settings — NOT their Naver account login password.
 * We test the credentials with a short IMAP LOGIN handshake before
 * persisting them so a typo doesn't quietly leave the user "connected"
 * with bad creds that fail on every poll.
 */

import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { encryptToken } from "../crypto-tokens.js";
import { prisma } from "../db.js";
import { requireEntitled } from "../entitlement-guard.js";
import { isAllowedImapHost } from "../is-allowed-imap-host.js";
import { verifyNaverImapCredentials } from "../naver-imap.js";

const DEFAULT_NAVER_IMAP_HOST = "imap.naver.com:993";

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

export async function naverImapRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/status", async (request) => {
    const userId = getUserId(request);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        naverImapEmail: true,
        naverImapHost: true,
        naverImapConnectedAt: true,
      },
    });
    return {
      connected: Boolean(user?.naverImapEmail),
      email: user?.naverImapEmail ?? null,
      host: user?.naverImapHost ?? null,
      connectedAt: user?.naverImapConnectedAt?.toISOString() ?? null,
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
      // Every call opens a real IMAP connection to Naver; without a tight
      // limit this is both a credential-stuffing oracle and a way to get
      // our egress IP blocked by Naver.
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
      const userId = getUserId(request);
      const { email, password, host } = request.body;
      const imapHost = (host ?? DEFAULT_NAVER_IMAP_HOST).trim();

      // SSRF guard: this host is opened as a TLS connection here AND on every
      // subsequent poll. Reject anything outside the provider allowlist before
      // we connect, so a user can't probe internal hosts via this endpoint.
      if (!isAllowedImapHost(imapHost)) {
        reply.code(400);
        return { ok: false, message: "Unsupported IMAP host. Only imap.naver.com:993 is allowed." };
      }

      // Smoke-test the credentials before persisting. We don't want the
      // user to leave the settings page thinking they're connected when
      // every subsequent poll will silently 401.
      const verify = await verifyNaverImapCredentials({
        email,
        password,
        host: imapHost,
      });
      if (!verify.ok) {
        reply.code(400);
        return { ok: false, message: verify.message };
      }

      await prisma.user.update({
        where: { id: userId },
        data: {
          naverImapEmail: email,
          naverImapPasswordCipher: encryptToken(password),
          naverImapHost: imapHost,
          naverImapConnectedAt: new Date(),
        },
      });

      return { ok: true, email, host: imapHost };
    },
  );

  app.post("/disconnect", async (request) => {
    const userId = getUserId(request);
    await prisma.user.update({
      where: { id: userId },
      data: {
        naverImapEmail: null,
        naverImapPasswordCipher: null,
        naverImapHost: null,
        naverImapConnectedAt: null,
      },
    });
    return { ok: true };
  });
}
