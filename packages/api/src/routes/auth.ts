import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  comparePassword,
  getUserId,
  hashPassword,
  registerDevice,
  removeDeviceSession,
  signToken,
  verifyToken,
} from "../auth.js";
import { encryptOptional, encryptToken } from "../crypto-tokens.js";
import { prisma } from "../db.js";
import { withDbRetry } from "../db-retry.js";
import { sendPasswordResetEmail, sendVerificationEmail } from "../email.js";
import {
  getAuthedClient,
  getAuthUrl,
  getGoogleConnectionStatus,
  getGoogleUserInfo,
  getLoginAuthUrl,
  getOAuth2Client,
  isGoogleAuthError,
  markGoogleTokenForReconnect,
} from "../gmail.js";
import { mapGoogleEventTimes } from "../google-calendar-time.js";
import { localMinuteOfDay, normalizeTimeZone } from "../time-zone.js";

const authHeaderSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    authorization: { type: "string" },
  },
} as const;

/**
 * Server-side constant — not user-controlled.
 * getUserId() extracts from a verified JWT; this comparison is safe.
 */
const DEMO_USER_ID = "demo-user";

function isDemoUser(userId: string): boolean {
  return userId === DEMO_USER_ID;
}

const registerBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["email", "password"],
  properties: {
    email: { type: "string", minLength: 3, maxLength: 320 },
    password: { type: "string", minLength: 1, maxLength: 200 },
    name: { type: "string", minLength: 1, maxLength: 120 },
  },
} as const;

const loginBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["email", "password"],
  properties: {
    email: { type: "string", minLength: 3, maxLength: 320 },
    password: { type: "string", minLength: 1, maxLength: 200 },
  },
} as const;

const updateProfileBodySchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 120 },
  },
} as const;

const changePasswordBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["currentPassword", "newPassword"],
  properties: {
    currentPassword: { type: "string", minLength: 1, maxLength: 200 },
    newPassword: { type: "string", minLength: 1, maxLength: 200 },
  },
} as const;

const setPasswordBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["newPassword"],
  properties: {
    newPassword: { type: "string", minLength: 1, maxLength: 200 },
  },
} as const;

const tokenQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["token"],
  properties: {
    token: { type: "string", minLength: 1, maxLength: 500 },
  },
} as const;

const forgotPasswordBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["email"],
  properties: {
    email: { type: "string", minLength: 3, maxLength: 320 },
  },
} as const;

const resetPasswordBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["token", "newPassword"],
  properties: {
    token: { type: "string", minLength: 1, maxLength: 500 },
    newPassword: { type: "string", minLength: 1, maxLength: 200 },
  },
} as const;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hasMeaningfulText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isLoginBriefingDue(
  briefingTime: string | null | undefined,
  timeZone: string | null | undefined,
): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(briefingTime || "");
  if (!match) return false;
  const targetMinutes = Number(match[1]) * 60 + Number(match[2]);
  return localMinuteOfDay(new Date(), normalizeTimeZone(timeZone)) >= targetMinutes;
}

function triggerDueLoginBriefing(userId: string, delayMs = 0): void {
  const run = async () => {
    const config = await prisma.automationConfig.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
    const configAny = config as unknown as { timezone?: string | null };
    if (!config.dailyBriefing || !isLoginBriefingDue(config.briefingTime, configAny.timezone)) {
      return;
    }
    const { createDailyBriefingDelivery } = await import("../briefing.js");
    await createDailyBriefingDelivery(userId);
  };

  const timer = setTimeout(() => {
    run().catch((err) => {
      console.warn(`[AUTH] Login briefing catch-up failed for ${userId}:`, err);
    });
  }, delayMs);
  timer.unref?.();
}

// Beta auto-PRO: when the gate is OFF and BETA_AUTO_PRO_ENABLED=true, the
// first BETA_AUTO_PRO_LIMIT signups silently get PRO. Past the cap returns
// null and the caller falls back to default plan. Used by both the
// email/password register endpoint and the Google OAuth signup callback so
// the two paths stay consistent.
async function evaluateBetaAutoPro(): Promise<{
  plan: "PRO";
  betaProGrantedAt: Date;
} | null> {
  const betaGateEnabled = process.env.BETA_GATE_ENABLED === "true";
  const betaAutoProEnabled = !betaGateEnabled && process.env.BETA_AUTO_PRO_ENABLED === "true";
  const betaAutoProLimit = Number.parseInt(process.env.BETA_AUTO_PRO_LIMIT || "50", 10);
  if (!betaAutoProEnabled || !Number.isFinite(betaAutoProLimit) || betaAutoProLimit <= 0) {
    return null;
  }
  const grantedCount = await prisma.user.count({
    where: { betaProGrantedAt: { not: null } },
  });
  if (grantedCount >= betaAutoProLimit) return null;
  return { plan: "PRO", betaProGrantedAt: new Date() };
}

export function authRoutes(app: FastifyInstance) {
  // GET /api/auth/signup-status — Public probe so the login UI can hide the
  // sign-up tab when BETA_GATE_ENABLED is on. Returning a boolean keeps the
  // surface minimal — clients should not need to know the reason; they just
  // route to /early-access instead of /login when sign-ups are closed.
  app.get("/signup-status", async () => {
    const open = process.env.BETA_GATE_ENABLED !== "true";
    return { open };
  });

  // POST /api/auth/register — Create account
  app.post(
    "/register",
    {
      schema: { body: registerBodySchema },
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
      const { email, password, name } = request.body as {
        email: string;
        password: string;
        name?: string;
      };
      const normalizedEmail = normalizeEmail(email);
      const normalizedName = hasMeaningfulText(name) ? name.trim() : undefined;

      if (!hasMeaningfulText(normalizedEmail) || !hasMeaningfulText(password)) {
        return reply.code(400).send({ error: "Email and password required" });
      }
      if (password.length < 8) {
        return reply.code(400).send({ error: "Password must be at least 8 characters" });
      }
      if (name !== undefined && !hasMeaningfulText(name)) {
        return reply.code(400).send({ error: "Name cannot be empty" });
      }

      // Beta gate: when BETA_GATE_ENABLED=true, registration is restricted to
      // waitlist entries that an admin has approved. APPROVED registrants are
      // auto-granted PRO so yongrean doesn't have to run prod SQL after every
      // signup.
      const betaGateEnabled = process.env.BETA_GATE_ENABLED === "true";
      const waitlistEntry = betaGateEnabled
        ? await prisma.waitlist.findUnique({
            where: { email: normalizedEmail },
            select: { status: true },
          })
        : null;
      if (betaGateEnabled && waitlistEntry?.status !== "APPROVED") {
        return reply.code(403).send({
          error: "Early access is invite-only. Request access at /early-access.",
        });
      }

      const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
      if (existing) {
        return reply.code(409).send({ error: "Email already registered" });
      }

      const betaAutoProGrant = await evaluateBetaAutoPro();

      const verifyToken = crypto.randomBytes(32).toString("hex");
      const verifyTokenExp = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

      const user = await prisma.user.create({
        data: {
          email: normalizedEmail,
          passwordHash: await hashPassword(password),
          name: normalizedName || normalizedEmail.split("@")[0],
          ...(betaGateEnabled && { plan: "PRO" }),
          ...(betaAutoProGrant ?? {}),
          verifyToken,
          verifyTokenExp,
        },
      });

      // Send verification email (non-blocking)
      sendVerificationEmail(normalizedEmail, verifyToken).catch(() => {});

      // Auto-create AutomationConfig with defaults
      prisma.automationConfig.create({ data: { userId: user.id } }).catch(() => {});

      const token = signToken({ userId: user.id, email: user.email });

      // Register device session
      const ip =
        (request.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || request.ip;
      const ua = request.headers["user-agent"] || "";
      await registerDevice(user.id, token, {
        deviceName: parseDeviceName(ua),
        deviceType: parseDeviceType(ua),
        ipAddress: ip,
      });
      triggerDueLoginBriefing(user.id, 10_000);

      return reply.code(201).send({
        token,
        user: { id: user.id, email: user.email, name: user.name, plan: user.plan, role: user.role },
      });
    },
  );

  // POST /api/auth/login — Sign in
  app.post(
    "/login",
    {
      schema: { body: loginBodySchema },
      config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
      const { email, password } = request.body as { email: string; password: string };
      const normalizedEmail = normalizeEmail(email);

      if (!hasMeaningfulText(normalizedEmail) || !hasMeaningfulText(password)) {
        return reply.code(400).send({ error: "Email and password required" });
      }

      const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
      if (!user?.passwordHash) {
        return reply.code(401).send({ error: "Invalid email or password" });
      }

      const valid = await comparePassword(password, user.passwordHash);
      if (!valid) {
        return reply.code(401).send({ error: "Invalid email or password" });
      }

      const token = signToken({ userId: user.id, email: user.email });

      // Register device session
      const ip =
        (request.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || request.ip;
      const ua = request.headers["user-agent"] || "";
      await registerDevice(user.id, token, {
        deviceName: parseDeviceName(ua),
        deviceType: parseDeviceType(ua),
        ipAddress: ip,
      });

      return reply.send({
        token,
        user: { id: user.id, email: user.email, name: user.name, plan: user.plan, role: user.role },
      });
    },
  );

  // GET /api/auth/me — Get current user
  app.get("/me", async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "Not authenticated" });
    }

    try {
      const payload = verifyToken(auth.slice(7));
      const user = await prisma.user.findUnique({ where: { id: payload.userId } });
      if (!user) return reply.code(404).send({ error: "User not found" });

      const googleStatus = await getGoogleConnectionStatus(user.id);

      return reply.send({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          plan: user.plan,
          role: user.role,
          // Stored IANA timezone (User.timezone, default "Asia/Seoul").
          // Surfaced so the web client can render calendar/briefing times
          // in the user's intended zone instead of the browser default
          // (which can disagree — e.g., iOS PWA falling back to UTC).
          timezone: (user as unknown as { timezone?: string | null }).timezone ?? "Asia/Seoul",
          googleConnected: googleStatus.connected,
          googleNeedsReconnect: googleStatus.needsReconnect,
        },
      });
    } catch {
      return reply.code(401).send({ error: "Invalid token" });
    }
  });

  // PATCH /api/auth/me — Update profile
  app.patch("/me", { schema: { body: updateProfileBodySchema } }, async (request, reply) => {
    const userId = getUserId(request);
    if (isDemoUser(userId)) {
      return reply.code(403).send({ error: "Demo user cannot update profile" });
    }

    const { name } = request.body as { name?: string };
    if (name !== undefined && !hasMeaningfulText(name)) {
      return reply.code(400).send({ error: "Name cannot be empty" });
    }
    const user = await prisma.user.update({
      where: { id: userId },
      data: { ...(name !== undefined && { name: name.trim() }) },
    });

    return reply.send({
      user: { id: user.id, email: user.email, name: user.name, plan: user.plan, role: user.role },
    });
  });

  // POST /api/auth/change-password — Change password
  app.post(
    "/change-password",
    { schema: { headers: authHeaderSchema, body: changePasswordBodySchema } },
    async (request, reply) => {
      const userId = getUserId(request);
      if (isDemoUser(userId)) {
        return reply.code(403).send({ error: "Demo user cannot change password" });
      }

      const { currentPassword, newPassword } = request.body as {
        currentPassword: string;
        newPassword: string;
      };

      if (!hasMeaningfulText(currentPassword) || !hasMeaningfulText(newPassword)) {
        return reply.code(400).send({ error: "Current and new password required" });
      }
      if (newPassword.length < 8) {
        return reply.code(400).send({ error: "New password must be at least 8 characters" });
      }

      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user?.passwordHash) {
        return reply.code(400).send({ error: "No password set" });
      }

      const valid = await comparePassword(currentPassword, user.passwordHash);
      if (!valid) {
        return reply.code(401).send({ error: "Current password is incorrect" });
      }

      // Compare-and-swap on the exact hash we validated against. If a parallel
      // request (reset-password, another change-password, account recovery) has
      // already rewritten the hash, our update affects 0 rows and we reject —
      // otherwise we would silently undo their write with a password the user
      // who just rotated credentials no longer expects.
      const updated = await prisma.user.updateMany({
        where: { id: userId, passwordHash: user.passwordHash },
        data: { passwordHash: await hashPassword(newPassword) },
      });
      if (updated.count === 0) {
        return reply
          .code(409)
          .send({ error: "Password was changed elsewhere. Please log in again." });
      }

      // Revoke other device sessions; keep current request's session active.
      const currentToken = (request.headers.authorization ?? "").slice(7);
      const currentHash = currentToken
        ? crypto.createHash("sha256").update(currentToken).digest("hex")
        : null;
      await prisma.device.deleteMany({
        where: {
          userId,
          ...(currentHash ? { tokenHash: { not: currentHash } } : {}),
        },
      });

      return reply.send({ success: true });
    },
  );

  // POST /api/auth/set-password — Set password for OAuth users who don't have one
  app.post(
    "/set-password",
    { schema: { headers: authHeaderSchema, body: setPasswordBodySchema } },
    async (request, reply) => {
      const userId = getUserId(request);
      if (isDemoUser(userId)) {
        return reply.code(403).send({ error: "Demo user cannot set password" });
      }

      const { newPassword } = request.body as { newPassword: string };
      if (!hasMeaningfulText(newPassword) || newPassword.length < 8) {
        return reply.code(400).send({ error: "Password must be at least 8 characters" });
      }

      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        return reply.code(404).send({ error: "User not found" });
      }
      if (user.passwordHash) {
        return reply
          .code(400)
          .send({ error: "Password already set. Use change-password instead." });
      }

      // Atomic single-use: only set the hash if no other request has already
      // assigned one. Two concurrent set-password calls would otherwise both
      // pass the read-side check and the second writer would silently overwrite
      // the first user's freshly-set password.
      const updated = await prisma.user.updateMany({
        where: { id: userId, passwordHash: null },
        data: { passwordHash: await hashPassword(newPassword) },
      });
      if (updated.count === 0) {
        return reply
          .code(400)
          .send({ error: "Password already set. Use change-password instead." });
      }

      return reply.send({ success: true });
    },
  );

  // GET /api/auth/has-password — Check if user has a password set
  app.get("/has-password", async (request, reply) => {
    const userId = getUserId(request);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });
    return reply.send({ hasPassword: !!user?.passwordHash });
  });

  // In-memory store for desktop login (server-generated nonce → { jwt, expiresAt }).
  // Only nonces generated by /desktop-nonce are accepted — prevents arbitrary polling.
  const desktopLoginTokens = new Map<string, { jwt?: string; expiresAt: number }>();

  // In-memory store for OAuth exchange codes (?code in the redirect instead of ?token).
  // Expires after 60 s; deleted on first use. Prevents JWT leakage via browser history.
  const exchangeCodes = new Map<string, { jwt: string; expiresAt: number }>();

  // GET /api/auth/desktop-nonce — Desktop app must call this FIRST to obtain a
  // server-generated nonce before opening the browser for Google login. Calling
  // /desktop-token with a nonce that was never issued here returns 404, so
  // attackers cannot enumerate or poll for arbitrary nonces.
  app.get("/desktop-nonce", async (_request, reply) => {
    const nonce = crypto.randomBytes(32).toString("hex");
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 min window for user to complete login
    desktopLoginTokens.set(nonce, { expiresAt });
    setTimeout(() => desktopLoginTokens.delete(nonce), 10 * 60 * 1000);
    return reply.send({ nonce });
  });

  // GET /api/auth/google/login — Start Google social login flow
  // Desktop flow: call /desktop-nonce first, then open this URL with ?source=desktop&nonce=
  app.get("/google/login", async (request, reply) => {
    const { source, nonce } = request.query as { source?: string; nonce?: string };
    const isDesktop = source === "desktop" && nonce;
    if (isDesktop) {
      const entry = desktopLoginTokens.get(nonce as string);
      if (!entry || entry.jwt !== undefined || entry.expiresAt < Date.now()) {
        return reply
          .code(400)
          .send({ error: "Invalid or expired nonce. Call /api/auth/desktop-nonce first." });
      }
    }
    const loginState = signToken({
      userId: isDesktop ? nonce : "__login__",
      email: isDesktop ? "__google_login_desktop__" : "__google_login__",
    });
    const url = getLoginAuthUrl(loginState);
    return reply.redirect(url);
  });

  // GET /api/auth/desktop-token/:nonce — Desktop app polls this after login.
  // Returns 404 for nonces that were not issued by /desktop-nonce so attackers
  // cannot extract tokens by enumerating arbitrary nonces.
  app.get(
    "/desktop-token/:nonce",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { nonce } = request.params as { nonce: string };
      const entry = desktopLoginTokens.get(nonce);
      if (!entry) return reply.code(404).send({ error: "Not found" });
      if (entry.expiresAt < Date.now()) {
        desktopLoginTokens.delete(nonce);
        return reply.code(410).send({ error: "Expired" });
      }
      if (!entry.jwt) return reply.code(202).send({ status: "pending" });
      desktopLoginTokens.delete(nonce);
      return { status: "ok", token: entry.jwt };
    },
  );

  // POST /api/auth/exchange-code — One-time exchange of the short-lived OAuth code
  // for the actual JWT. Eliminates JWT exposure in redirect URLs / browser history.
  app.post(
    "/exchange-code",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { code } = (request.body ?? {}) as { code?: string };
      if (!code || typeof code !== "string") {
        return reply.code(400).send({ error: "Missing code" });
      }
      const entry = exchangeCodes.get(code);
      if (!entry) return reply.code(404).send({ error: "Invalid code" });
      if (entry.expiresAt < Date.now()) {
        exchangeCodes.delete(code);
        return reply.code(410).send({ error: "Code expired" });
      }
      exchangeCodes.delete(code);
      return { token: entry.jwt };
    },
  );

  // POST /api/auth/google/start — Build Google OAuth URL using header auth.
  // Web clients fetch this and then set window.location.href, which keeps
  // the user's session JWT out of URLs, browser history, server logs, and
  // Referer. This replaces the older GET /api/auth/google?token=… flow,
  // which was removed in PR #410.
  app.post("/google/start", async (request, reply) => {
    const userId = getUserId(request);
    if (isDemoUser(userId)) {
      return reply.code(403).send({ error: "Authentication required to connect Google" });
    }
    const signedState = signToken({ userId, email: "__oauth_state__" });
    const url = getAuthUrl(signedState);
    return reply.send({ url });
  });

  // GET /api/auth/google/callback — OAuth callback (handles both login and integration)
  app.get("/google/callback", async (request, reply) => {
    const { code, state } = request.query as { code?: string; state?: string };

    if (!code) {
      return reply.code(400).send({ error: "Missing authorization code" });
    }

    const webUrl = process.env.WEB_URL || "http://localhost:8001";

    // Validate state parameter — must be a valid server-signed JWT
    if (!state) {
      return reply.code(400).send({ error: "Missing state parameter" });
    }
    let statePayload: { userId: string; email: string };
    try {
      statePayload = verifyToken(state);
    } catch {
      return reply.code(400).send({ error: "Invalid or expired OAuth state" });
    }

    try {
      const oauth2 = getOAuth2Client();
      const { tokens } = await oauth2.getToken(code);

      // --- Google Social Login flow (state signed with __google_login__ or __google_login_desktop__ marker) ---
      const isGoogleLogin =
        statePayload.email === "__google_login__" ||
        statePayload.email === "__google_login_desktop__";
      const isDesktopLogin = statePayload.email === "__google_login_desktop__";
      if (isGoogleLogin) {
        if (!tokens.access_token) {
          return reply.redirect(`${webUrl}/login?error=google_failed`);
        }

        const profile = await getGoogleUserInfo(tokens.access_token);

        // Find or create user by email. Wrapped with withDbRetry so a Neon
        // cold-start during sign-in (suspended compute waking up) does not
        // surface as a hard "Can't reach database server" failure to the
        // user — silent retry covers the wake-up window.
        let user = await withDbRetry(
          () => prisma.user.findUnique({ where: { email: profile.email } }),
          { label: "oauth.find_user_by_email" },
        );
        if (!user) {
          // Beta gate: when BETA_GATE_ENABLED=true, the Google sign-in path
          // can only create a new user if they have an APPROVED waitlist
          // entry. This mirrors the email/password register endpoint so the
          // two paths cannot diverge. Existing users always pass through.
          const betaGateEnabled = process.env.BETA_GATE_ENABLED === "true";
          if (betaGateEnabled) {
            const waitlistEntry = await prisma.waitlist.findUnique({
              where: { email: profile.email },
              select: { status: true },
            });
            if (waitlistEntry?.status !== "APPROVED") {
              return reply.redirect(`${webUrl}/login?error=invite_only`);
            }
          }
          const betaAutoProGrant = await evaluateBetaAutoPro();
          user = await withDbRetry(
            () =>
              prisma.user.create({
                data: {
                  email: profile.email,
                  name: profile.name || profile.email.split("@")[0],
                  passwordHash: null, // Google-only user, no password
                  emailVerified: true, // Google accounts are pre-verified
                  ...(betaGateEnabled && { plan: "PRO" }),
                  ...(betaAutoProGrant ?? {}),
                },
              }),
            { label: "oauth.create_user" },
          );
        } else if (!user.emailVerified) {
          await withDbRetry(
            () =>
              prisma.user.update({
                where: { id: user!.id },
                data: { emailVerified: true },
              }),
            { label: "oauth.verify_user" },
          );
        }

        // Auto-save Google tokens for Gmail/Calendar integration (one-click setup).
        // Refuse to save a token without a refresh_token unless we already have
        // one on file to preserve. Otherwise Google's silent omission of
        // refresh_token (G Suite + unverified-app policy) leaves the user with
        // a 1-hour working window followed by a "Gmail sync failed" loop with
        // no actionable error message.
        const existingToken = await withDbRetry(
          () =>
            prisma.userToken.findUnique({
              where: { userId_provider: { userId: user!.id, provider: "google" } },
              select: { refreshToken: true },
            }),
          { label: "oauth.find_existing_token" },
        );
        const haveUsableRefreshToken = !!tokens.refresh_token || !!existingToken?.refreshToken;
        if (!haveUsableRefreshToken) {
          console.warn(
            `[GOOGLE] Refusing to save partial token for ${user!.email} — refresh_token missing, no prior token to preserve`,
          );
          // Still let the user finish signing in — they just have to retry the
          // Gmail integration from /settings where we explain why it failed.
        } else {
          await withDbRetry(
            () =>
              prisma.userToken.upsert({
                where: { userId_provider: { userId: user!.id, provider: "google" } },
                create: {
                  userId: user!.id,
                  provider: "google",
                  accessToken: encryptToken(tokens.access_token ?? ""),
                  refreshToken: encryptOptional(tokens.refresh_token),
                  expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
                },
                update: {
                  accessToken: encryptToken(tokens.access_token ?? ""),
                  // Only overwrite refreshToken if Google returned a new one — preserve existing otherwise
                  ...(tokens.refresh_token
                    ? { refreshToken: encryptToken(tokens.refresh_token) }
                    : {}),
                  expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
                },
              }),
            { label: "oauth.upsert_user_token" },
          );
        }

        // Auto-create AutomationConfig with defaults
        await withDbRetry(
          () =>
            prisma.automationConfig.upsert({
              where: { userId: user!.id },
              create: { userId: user!.id },
              update: {},
            }),
          { label: "oauth.upsert_automation_config" },
        );

        const token = signToken({ userId: user.id, email: user.email });

        // Register device session for Google login
        const ip =
          (request.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || request.ip;
        const ua = request.headers["user-agent"] || "";
        await registerDevice(user.id, token, {
          deviceName: parseDeviceName(ua),
          deviceType: parseDeviceType(ua),
          ipAddress: ip,
        });
        triggerDueLoginBriefing(user.id, 10_000);

        // Desktop app: update the server-side nonce entry with the JWT
        if (isDesktopLogin) {
          const nonce = statePayload.userId; // nonce was stored in userId field
          const existing = desktopLoginTokens.get(nonce);
          if (existing) {
            desktopLoginTokens.set(nonce, { ...existing, jwt: token });
          }
          reply.type("text/html");
          return reply.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Klorn Login</title>
<style>body{font-family:system-ui;background:#0a0a0a;color:#e5e7eb;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{text-align:center;padding:40px}.ok{font-size:48px;margin-bottom:16px}.t{font-size:14px;color:#9ca3af;margin-top:12px}</style>
</head><body><div class="box"><div class="ok">✓</div><h2>Login Successful</h2>
<p class="t">Return to the Klorn desktop app.<br>You can close this tab.</p>
</div></body></html>`);
        }

        // Issue a short-lived exchange code instead of putting the JWT in the URL.
        // The frontend exchanges it via POST /api/auth/exchange-code (60 s window).
        const xcode = crypto.randomBytes(20).toString("hex");
        exchangeCodes.set(xcode, { jwt: token, expiresAt: Date.now() + 60_000 });
        setTimeout(() => exchangeCodes.delete(xcode), 60_000);
        // Pass google integration status forward so the post-login UI can
        // either flash "connected" or surface the offline_access guidance.
        const integrationFlag = haveUsableRefreshToken
          ? "google=connected"
          : "google=offline_access_denied";
        return reply.redirect(`${webUrl}/auth/callback?code=${xcode}&${integrationFlag}`);
      }

      // --- Gmail/Calendar integration flow (state signed with __oauth_state__ marker) ---
      if (statePayload.email !== "__oauth_state__") {
        return reply.code(400).send({ error: "Invalid OAuth state" });
      }
      const userId = statePayload.userId;
      const user = await withDbRetry(() => prisma.user.findUnique({ where: { id: userId } }), {
        label: "oauth.integration.find_user",
      });
      if (!user) {
        return reply.code(404).send({ error: "User not found" });
      }

      // Refuse partial token. See the matching guard in the Google login flow
      // above for the full reasoning — G Suite + unverified-app sometimes
      // strips refresh_token, and a 1-hour-then-fail loop is worse than a
      // visible error.
      const existingIntegrationToken = await withDbRetry(
        () =>
          prisma.userToken.findUnique({
            where: { userId_provider: { userId: user.id, provider: "google" } },
            select: { refreshToken: true },
          }),
        { label: "oauth.integration.find_existing_token" },
      );
      const integrationHasUsableRefreshToken =
        !!tokens.refresh_token || !!existingIntegrationToken?.refreshToken;
      if (!integrationHasUsableRefreshToken) {
        console.warn(
          `[GOOGLE] Refusing to save partial integration token for ${user.email} — refresh_token missing, no prior token to preserve`,
        );
        return reply.redirect(`${webUrl}/settings?google=offline_access_denied`);
      }

      await withDbRetry(
        () =>
          prisma.userToken.upsert({
            where: { userId_provider: { userId: user.id, provider: "google" } },
            create: {
              userId: user.id,
              provider: "google",
              accessToken: encryptToken(tokens.access_token ?? ""),
              refreshToken: encryptOptional(tokens.refresh_token),
              expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
            },
            update: {
              accessToken: encryptToken(tokens.access_token ?? ""),
              // Only overwrite refreshToken if Google returned a new one — preserve existing otherwise
              ...(tokens.refresh_token ? { refreshToken: encryptToken(tokens.refresh_token) } : {}),
              expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
            },
          }),
        { label: "oauth.integration.upsert_user_token" },
      );

      return reply.redirect(`${webUrl}/settings?google=connected`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "OAuth failed";
      if (statePayload.email === "__google_login__") {
        return reply.redirect(`${webUrl}/login?error=${encodeURIComponent(message)}`);
      }
      if (statePayload.email === "__google_login_desktop__") {
        const htmlMessage = message
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
        reply.type("text/html");
        return reply.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Klorn Login</title>
<style>body{font-family:system-ui;background:#0a0a0a;color:#e5e7eb;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{text-align:center;padding:40px}.err{font-size:48px;margin-bottom:16px;color:#ef4444}.t{font-size:14px;color:#9ca3af;margin-top:12px}</style>
</head><body><div class="box"><div class="err">✕</div><h2>Login Failed</h2>
<p class="t">${htmlMessage}<br>Please try again in Klorn Desktop.</p>
</div></body></html>`);
      }
      return reply.code(500).send({ error: message });
    }
  });

  // DELETE /api/auth/google — Disconnect Google account
  app.delete("/google", async (request, reply) => {
    const userId = getUserId(request);
    await prisma.userToken.deleteMany({
      where: { userId, provider: "google" },
    });
    return reply.code(204).send();
  });

  // GET /api/auth/google/status — Check if Gmail is connected and token is valid
  app.get("/google/status", async (request, reply) => {
    const userId = getUserId(request);
    return reply.send(await getGoogleConnectionStatus(userId));
  });

  // POST /api/auth/forgot-password — Request password reset
  app.post(
    "/forgot-password",
    {
      schema: { body: forgotPasswordBodySchema },
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
      const { email } = request.body as { email: string };
      const normalizedEmail = normalizeEmail(email);
      if (!hasMeaningfulText(normalizedEmail))
        return reply.code(400).send({ error: "Email required" });

      const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
      // Always return success to prevent email enumeration
      if (!user) return reply.send({ success: true });

      const resetToken = crypto.randomBytes(32).toString("hex");
      const resetTokenExp = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await prisma.user.update({
        where: { id: user.id },
        data: { resetToken, resetTokenExp },
      });

      await sendPasswordResetEmail(normalizedEmail, resetToken);

      return reply.send({ success: true });
    },
  );

  // POST /api/auth/reset-password — Reset password with token
  app.post(
    "/reset-password",
    { schema: { body: resetPasswordBodySchema } },
    async (request, reply) => {
      const { token, newPassword } = request.body as {
        token: string;
        newPassword: string;
      };

      if (!hasMeaningfulText(token) || !hasMeaningfulText(newPassword)) {
        return reply.code(400).send({ error: "Token and new password required" });
      }
      if (newPassword.length < 8) {
        return reply.code(400).send({ error: "Password must be at least 8 characters" });
      }

      const user = await prisma.user.findFirst({
        where: {
          resetToken: token,
          resetTokenExp: { gte: new Date() },
        },
        select: { id: true },
      });

      if (!user) {
        return reply.code(400).send({ error: "Invalid or expired reset token" });
      }

      // Atomic single-use: only succeed if resetToken still matches and is unexpired.
      // Two concurrent calls with the same token: one wins, the other affects 0 rows.
      const updated = await prisma.user.updateMany({
        where: {
          id: user.id,
          resetToken: token,
          resetTokenExp: { gte: new Date() },
        },
        data: {
          passwordHash: await hashPassword(newPassword),
          resetToken: null,
          resetTokenExp: null,
          // Stamp the session-revocation epoch atomically with the password
          // change. Any JWT issued before now is rejected at the auth gate
          // (auth.ts isTokenRevokedByEpoch), independently of the Device table.
          sessionsInvalidatedAt: new Date(),
        },
      });

      if (updated.count === 0) {
        return reply.code(400).send({ error: "Invalid or expired reset token" });
      }

      // Drop the device rows too (so the per-device list reflects the wipe).
      // The epoch above is the real revocation; this keeps the Device table
      // consistent rather than relying on it to invalidate stolen tokens.
      await prisma.device.deleteMany({ where: { userId: user.id } });

      return reply.send({ success: true });
    },
  );

  // GET /api/auth/verify-email — Verify email with token
  app.get(
    "/verify-email",
    { schema: { querystring: tokenQuerySchema } },
    async (request, reply) => {
      const { token } = request.query as { token?: string };

      if (!token) {
        return reply.code(400).send({ error: "Missing verification token" });
      }

      const user = await prisma.user.findFirst({
        where: {
          verifyToken: token,
          verifyTokenExp: { gte: new Date() },
        },
        select: { id: true },
      });

      if (!user) {
        return reply.code(400).send({ error: "Invalid or expired verification token" });
      }

      // Atomic single-use verification.
      const updated = await prisma.user.updateMany({
        where: {
          id: user.id,
          verifyToken: token,
          verifyTokenExp: { gte: new Date() },
        },
        data: {
          emailVerified: true,
          verifyToken: null,
          verifyTokenExp: null,
        },
      });

      if (updated.count === 0) {
        return reply.code(400).send({ error: "Invalid or expired verification token" });
      }

      // Validate WEB_URL to prevent open redirect — only allow http(s) origins
      const rawUrl = process.env.WEB_URL || "http://localhost:8001";
      let webOrigin: string;
      try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new Error("Invalid protocol");
        }
        webOrigin = parsed.origin;
      } catch {
        webOrigin = "http://localhost:8001";
      }
      return reply.redirect(`${webOrigin}/login?verified=true`);
    },
  );

  // POST /api/auth/resend-verification — Resend verification email
  app.post(
    "/resend-verification",
    { config: { rateLimit: { max: 3, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const userId = getUserId(request);
      if (isDemoUser(userId)) {
        return reply.code(403).send({ error: "Demo user" });
      }

      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return reply.code(404).send({ error: "User not found" });
      if (user.emailVerified) return reply.send({ success: true, alreadyVerified: true });

      const verifyToken = crypto.randomBytes(32).toString("hex");
      const verifyTokenExp = new Date(Date.now() + 24 * 60 * 60 * 1000);

      await prisma.user.update({
        where: { id: user.id },
        data: { verifyToken, verifyTokenExp },
      });

      await sendVerificationEmail(user.email, verifyToken);
      return reply.send({ success: true });
    },
  );

  // POST /api/auth/init-sync — Trigger initial sync after login (calendar + email contacts)
  app.post("/init-sync", async (request) => {
    const userId = getUserId(request);
    if (isDemoUser(userId)) {
      return { synced: false, reason: "demo-user" };
    }

    const results: { calendar: number; contacts: number; emails: number } = {
      calendar: 0,
      contacts: 0,
      emails: 0,
    };

    // Login/reload is the product's bootstrap moment: make sure the daily
    // briefing scheduler can see this user even if the account predates
    // AutomationConfig defaults.
    await prisma.automationConfig.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });

    // Check if Google is connected
    const auth = await getAuthedClient(userId);
    if (!auth) {
      triggerDueLoginBriefing(userId);
      return { synced: false, reason: "google_not_connected" };
    }

    // 1. Sync Google Calendar events (next 30 days)
    try {
      const { google } = await import("googleapis");
      const calendar = google.calendar({ version: "v3", auth });
      const now = new Date();
      const later = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

      // Parse event times against the user's timezone, exactly as the 60s
      // scheduler does — otherwise first-login writes land at a different UTC
      // instant than every subsequent scheduler write (off by the UTC offset).
      const userRow = (await prisma.user.findUnique({ where: { id: userId } })) as {
        timezone?: string | null;
      } | null;
      const userTimezone = normalizeTimeZone(userRow?.timezone);

      const response = await calendar.events.list({
        calendarId: "primary",
        timeMin: now.toISOString(),
        timeMax: later.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 100,
        // Ask Google to canonicalize against the user's zone; mapGoogleEventTimes
        // below still defends against any stray naive strings.
        timeZone: userTimezone,
      });

      for (const item of response.data.items || []) {
        const googleId = item.id || "";
        if (!googleId) continue;

        const times = mapGoogleEventTimes(item, userTimezone);
        if (!times) continue;
        const { startTime, endTime, allDay } = times;

        let meetingLink: string | null = null;
        if (item.conferenceData?.entryPoints) {
          const video = item.conferenceData.entryPoints.find((e) => e.entryPointType === "video");
          if (video) meetingLink = video.uri || null;
        }
        if (!meetingLink && item.hangoutLink) meetingLink = item.hangoutLink;

        await prisma.calendarEvent.upsert({
          where: { googleId },
          create: {
            userId,
            title: item.summary || "Untitled",
            description: item.description || null,
            startTime,
            endTime,
            location: item.location || null,
            meetingLink,
            allDay,
            googleId,
          },
          update: {
            title: item.summary || "Untitled",
            description: item.description || null,
            startTime,
            endTime,
            location: item.location || null,
            meetingLink,
            allDay,
          },
        });
        results.calendar++;
      }
    } catch (err) {
      if (isGoogleAuthError(err)) await markGoogleTokenForReconnect(userId);
      // Calendar sync failed — continue with other syncs
    }

    // 2. Auto-add contacts from recent Gmail senders
    try {
      const { google } = await import("googleapis");
      const gmail = google.gmail({ version: "v1", auth });
      const res = await gmail.users.messages.list({
        userId: "me",
        maxResults: 30,
        labelIds: ["INBOX"],
      });

      const seenEmails = new Set<string>();
      for (const msg of res.data.messages || []) {
        const detail = await gmail.users.messages.get({
          userId: "me",
          id: msg.id ?? "",
          format: "metadata",
          metadataHeaders: ["From"],
        });
        const fromHeader =
          detail.data.payload?.headers?.find((h) => h.name === "From")?.value || "";
        const match = fromHeader.match(/<([^>]+)>/) || [null, fromHeader.trim()];
        const email = (match[1] || "").toLowerCase().trim();
        if (!email || seenEmails.has(email)) continue;
        seenEmails.add(email);

        // Skip automated senders
        if (/noreply|no-reply|newsletter|mailer-daemon|notifications?@/i.test(email)) continue;

        // Extract name
        const namePart = fromHeader
          .replace(/<[^>]+>/, "")
          .replace(/"/g, "")
          .trim();
        const name = namePart || email.split("@")[0];

        // Only add if not already exists
        const exists = await prisma.contact.findFirst({
          where: { userId, email },
        });
        if (!exists) {
          try {
            await prisma.contact.create({
              data: { userId, name, email, tags: "auto-added" },
            });
            results.contacts++;
          } catch {
            // Race condition or duplicate — skip
          }
        }
      }
    } catch (err) {
      if (isGoogleAuthError(err)) await markGoogleTokenForReconnect(userId);
      // Gmail contact sync failed — skip
    }

    // 3. Sync emails from Gmail (latest 30)
    try {
      const { syncEmails } = await import("../email-sync.js");
      const emailResult = await syncEmails(userId, 30);
      results.emails = emailResult.newCount;
    } catch {
      // Email sync failed — skip
    }

    triggerDueLoginBriefing(userId);
    return { synced: true, ...results };
  });

  // POST /api/auth/logout — Invalidate device session
  app.post("/logout", async (request, reply) => {
    const auth = request.headers.authorization;
    if (auth?.startsWith("Bearer ")) {
      await removeDeviceSession(auth.slice(7));
    }
    return reply.send({ success: true });
  });
}

/** Parse a human-readable device name from User-Agent */
function parseDeviceName(ua: string): string {
  if (!ua) return "Unknown device";

  let browser = "Browser";
  if (ua.includes("Firefox")) browser = "Firefox";
  else if (ua.includes("Edg/")) browser = "Edge";
  else if (ua.includes("Chrome")) browser = "Chrome";
  else if (ua.includes("Safari")) browser = "Safari";

  let os = "";
  if (ua.includes("Windows")) os = "Windows";
  else if (ua.includes("Macintosh") || ua.includes("Mac OS")) os = "macOS";
  else if (ua.includes("Linux")) os = "Linux";
  else if (ua.includes("iPhone")) os = "iPhone";
  else if (ua.includes("iPad")) os = "iPad";
  else if (ua.includes("Android")) os = "Android";

  return os ? `${browser} on ${os}` : browser;
}

/** Parse device type from User-Agent */
function parseDeviceType(ua: string): string {
  if (!ua) return "web";
  if (/iPhone|iPad|Android|Mobile/i.test(ua)) return "mobile";
  if (/Electron/i.test(ua)) return "desktop";
  return "web";
}
