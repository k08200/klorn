import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { exchangeCodes } from "../auth/exchange-codes.js";
import {
  comparePassword,
  getUserId,
  hashPassword,
  isAdminEmail,
  isDemoAccessEnabled,
  passwordHashNeedsUpgrade,
  registerDevice,
  removeDeviceSession,
  requireAuth,
  signToken,
  verifyToken,
} from "../auth.js";
import { requireEntitled } from "../billing/entitlement-guard.js";
import { isEntitled, isHardPaywalled, isWebCheckoutAvailable } from "../billing/stripe.js";
import { appleLoginEnabled, INIT_SYNC_EMAIL_COUNT, naverLoginEnabled } from "../config.js";
import { encryptOptional, encryptToken } from "../crypto-tokens.js";
import { prisma } from "../db.js";
import { withDbRetry } from "../db-retry.js";
import { sendPasswordResetEmail, sendVerificationEmail } from "../mail/email.js";
import { syncLinkedInboxesForUser } from "../mail/email-sync.js";
import {
  getAuthedClient,
  getAuthUrl,
  getGoogleConnectionStatus,
  getGoogleUserInfo,
  getLinkCalendarAuthUrl,
  getLinkInboxAuthUrl,
  getLoginAuthUrl,
  getOAuth2Client,
  isGoogleAuthError,
  markGoogleTokenForReconnect,
  registerGmailWatch,
} from "../mail/gmail.js";
import { maybeSendWelcomeEmail } from "../notify/welcome-email.js";
import { hashOneTimeToken, mintOneTimeToken } from "../one-time-token.js";
import { googleSessionFromClient } from "../pim/calendar-providers/google.js";
import { readSyncTimezone, syncPrimaryCalendarWindow } from "../pim/calendar-sync.js";
import { unlinkCalendarAccount } from "../pim/linked-calendar-unlink.js";
import {
  clearLoginAttempts,
  loginThrottleRemainingMs,
  recordLoginAttempt,
} from "../security/login-throttle.js";
import { captureError } from "../sentry.js";
import { localMinuteOfDay, normalizeTimeZone } from "../time-zone.js";
import { deleteUserAndAllData } from "../user-deletion.js";

// Allowlisted native app URL schemes for the OAuth deep-link relay. The token is
// delivered by redirecting the browser to `<scheme>://oauth-callback?code=…`,
// which the OS routes to the app holding that scheme on the user's OWN device —
// so an attacker who merely knows a login nonce cannot receive the token (it is
// never parked in a pollable server slot). Only these fixed schemes are valid
// targets, so an attacker cannot redirect the token to a scheme they control.
// Configurable so a new build's scheme can be added without a code change.
const NATIVE_OAUTH_SCHEMES = (process.env.NATIVE_OAUTH_SCHEMES ?? "ai.klorn.app,klorn")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function isAllowedNativeScheme(scheme: unknown): scheme is string {
  return typeof scheme === "string" && NATIVE_OAUTH_SCHEMES.includes(scheme);
}

// The desktop browser leg must END IN A DOCUMENT. A bare 302 whose Location is
// a custom scheme hands the URL to the OS (the app does launch and sign-in DOES
// succeed) but commits nothing, so the tab keeps rendering whatever was last
// committed — Google's account chooser — and spins forever. Dogfood 2026-08-10:
// "로그인 누르면 무한로딩, 탭을 직접 끄면 로그인이 되어 있다".
//
// Serving a page fixes both halves of that: the document commits (so the
// spinner ends no matter what the OS does with the scheme), and the launch is
// retried from that document.
//
// The automatic launch is a <meta http-equiv="refresh">, NOT a script: every
// HTML response from this API is served under `default-src 'none'; style-src
// 'unsafe-inline'` (see the onSend hook in index.ts), so script-src is 'none'
// and an inline <script> would silently never run. A meta refresh is not
// governed by CSP, so the handoff survives the policy instead of quietly
// depending on relaxing it. The anchor is the second half: browsers that only
// honor an external-protocol launch on a user gesture still get one click away.
//
// window.close() is deliberately absent — it is script (blocked) and would be a
// no-op regardless, since a tab the desktop app opened was not opened by
// script. The "you can close this tab" copy is the real guarantee.
//
// The deep link is escaped for the attribute even though it cannot currently
// carry a metacharacter (its scheme passed isAllowedNativeScheme and its code
// is hex from crypto.randomBytes): NATIVE_OAUTH_SCHEMES is env-configurable, so
// a self-hoster's typo must not be able to become markup.
/// Desktop sign-in nonce state, shared with routes/social-auth.ts so the
/// Apple/Naver desktop legs park/relay into the same map the
/// /desktop-token/:nonce poller reads. Module-level: single registration.
export const desktopLoginTokens = new Map<
  string,
  { jwt?: string; expiresAt: number; challenge?: string; relayed?: boolean }
>();

export function desktopHandoffPage(deepLink: string): string {
  const href = deepLink
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Klorn Login</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0;url=${href}">
<style>body{font-family:system-ui;background:#0a0a0a;color:#e5e7eb;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{text-align:center;padding:40px;max-width:420px}.ok{font-size:48px;margin-bottom:16px}
.t{font-size:14px;color:#9ca3af;margin-top:12px;line-height:1.6}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;margin-top:24px;padding:0 20px;border-radius:8px;background:#e5e7eb;color:#0a0a0a;font-size:14px;font-weight:600;text-decoration:none}
.btn:focus-visible{outline:3px solid #60a5fa;outline-offset:2px}</style>
</head><body><div class="box"><div class="ok" aria-hidden="true">✓</div>
<h2>Login Successful</h2>
<p class="t">Klorn Desktop is finishing sign-in.<br>You can close this tab.</p>
<a class="btn" href="${href}">Open Klorn</a>
</div></body></html>`;
}

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

/** Ceiling on linked secondary inboxes per user (unbounded-growth guard). */
const MAX_LINKED_INBOXES = 10;

// Exported for the Apple/Naver social-login path (auth/social-login.ts),
// which must mirror this guard exactly.
export function isDemoUser(userId: string): boolean {
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
    // First-touch inflow attribution the login surface captured. 300 mirrors
    // the client's own cap (lib/attribution.ts TOTAL_MAX); the value is
    // client-supplied, so the column must not inherit an arbitrary length.
    attribution: { type: "string", minLength: 1, maxLength: 300 },
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

const desktopNonceQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    challenge: { type: "string", maxLength: 500 },
  },
} as const;

const googleLoginQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    source: { type: "string", maxLength: 500 },
    nonce: { type: "string", maxLength: 500 },
    appScheme: { type: "string", maxLength: 500 },
    // Rides the signed state to the callback — Google is the path most people
    // take, so attribution that skipped it would report almost nothing.
    attr: { type: "string", maxLength: 300 },
  },
} as const;

// OAuth authorization codes routinely exceed 500 chars (Azure AD ~800), so the
// callback params get 2048 instead of the blanket 500 used elsewhere.
const googleCallbackQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    code: { type: "string", maxLength: 2048 },
    state: { type: "string", maxLength: 2048 },
    error: { type: "string", maxLength: 2048 },
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

// Users whose legacy password hash is being upgraded in the background right
// now (login route). Caps the fire-and-forget cost-12 rehash at one per user
// so concurrent valid-credential logins can't stack bcrypt work on the loop.
const rehashInFlight = new Set<string>();

// Exported for auth/social-login.ts — the Apple/Naver path must normalize
// exactly like every email/password and Google path here.
export function normalizeEmail(email: string): string {
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

/**
 * Decide-and-run body of triggerDueLoginBriefing (exported for tests).
 *
 * Regular users only get the login catch-up once their configured briefing
 * time has passed. D0 exception: a user with ZERO briefings ever (no Note row
 * with a dayKey — the daily-briefing marker) gets their FIRST briefing
 * immediately instead of waiting for tomorrow's slot. Delivery itself stays
 * capped at once per local day by the (userId, dayKey) unique inside
 * createDailyBriefingDelivery, so this exception can never double-send.
 */
export async function runLoginBriefingCatchUp(userId: string): Promise<void> {
  const config = await prisma.automationConfig.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
  const configAny = config as unknown as { timezone?: string | null };
  if (!config.dailyBriefing) return;
  if (!isLoginBriefingDue(config.briefingTime, configAny.timezone)) {
    // Weekly signal reports also stamp dayKey ("YYYY-Www"), so the briefing
    // marker must be the title, not dayKey existence (briefing-status.ts idiom).
    const everBriefed = await prisma.note.findFirst({
      where: { userId, dayKey: { not: null }, title: { startsWith: "Daily Briefing" } },
      select: { id: true },
    });
    if (everBriefed) return; // not day zero — respect the schedule
  }
  const { createDailyBriefingDelivery } = await import("../pim/briefing.js");
  await createDailyBriefingDelivery(userId);
}

export function triggerDueLoginBriefing(userId: string, delayMs = 0): void {
  const timer = setTimeout(() => {
    runLoginBriefingCatchUp(userId).catch((err) => {
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
// Exported for auth/social-login.ts so the Apple/Naver signup path grants (or
// exhausts) the same beta-PRO pool instead of forking a third policy.
export async function evaluateBetaAutoPro(): Promise<{
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

  // GET /api/auth/providers — Public probe so the login UI renders exactly the
  // sign-in buttons this deployment supports (signup-status precedent: values
  // only, never raw env). Google is always on; Apple/Naver appear once their
  // OFF-by-default flags flip (config.ts) — while dark they are also absent
  // here, so the login page is unchanged and nothing advertises the cloaked
  // /api/auth/apple|naver routes. Contract: AuthProvidersResponse.
  app.get("/providers", async () => {
    const providers = [
      { id: "google" },
      ...(appleLoginEnabled() ? [{ id: "apple" }] : []),
      ...(naverLoginEnabled() ? [{ id: "naver" }] : []),
    ];
    return { providers };
  });

  // POST /api/auth/register — Create account
  app.post(
    "/register",
    {
      schema: { body: registerBodySchema },
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
      const { email, password, name, attribution } = request.body as {
        email: string;
        password: string;
        name?: string;
        attribution?: string;
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
      // auto-granted PRO for approved beta testers (avoids manual SQL per
      // signup).
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

      // Only the hash is stored (one-time-token.ts); the raw token exists
      // only in the verification email.
      const { token: rawVerifyToken, tokenHash: verifyTokenHash } = mintOneTimeToken();
      const verifyTokenExp = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

      const user = await prisma.user.create({
        data: {
          email: normalizedEmail,
          passwordHash: await hashPassword(password),
          name: normalizedName || normalizedEmail.split("@")[0],
          ...(betaGateEnabled && { plan: "PRO" }),
          ...(betaAutoProGrant ?? {}),
          ...(attribution ? { attribution } : {}),
          verifyToken: verifyTokenHash,
          verifyTokenExp,
        },
      });

      // Send verification email (non-blocking). Never silent: a swallowed
      // failure here strands the user unverified (and so never welcomed), so
      // leave a console signal even though the request still succeeds.
      sendVerificationEmail(normalizedEmail, rawVerifyToken).catch((err) =>
        console.error(`[AUTH] verification email failed for ${user.id}:`, err),
      );

      // Auto-create AutomationConfig with defaults. Fire-and-forget, but never
      // silent: without this row the scheduler never picks the user up, so a
      // failed create must leave a trace (login init-sync also self-heals it).
      prisma.automationConfig
        .create({ data: { userId: user.id } })
        .catch((err) => console.warn(`[AUTH] automationConfig create failed for ${user.id}`, err));

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
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          plan: user.plan,
          role: user.role,
          // Include entitled here too (not just /me) so the client paywall guard
          // never sees it undefined at session start and skips the check.
          entitled: isEntitled(user.plan, user.role),
          // Hard-wall only pure subscriber-only mode; with the usable free tier
          // this is always false so free users get into the app.
          paywalled: isHardPaywalled(user.plan, user.role),
          // Whether the web (Stripe) checkout can complete (key + PRO price
          // configured). The web paywall disables its subscribe button when
          // false so a native-IAP-only launch never shows a dead button.
          webCheckoutAvailable: isWebCheckoutAvailable(),
        },
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

      // Per-account window on top of the per-IP limit: a distributed brute
      // force rotating IPs still hits this. The check and the attempt record
      // run back-to-back with no await between them, so a concurrent wave
      // cannot slip past the threshold on a stale count. The 429 body matches
      // what the central error handler renders for the per-IP limiter
      // ({ error: <message> }) so the lockout is not an account-existence
      // oracle, and each locked attempt is logged for lockout-DoS detection
      // (email hashed — no PII in logs).
      const throttleRemainingMs = loginThrottleRemainingMs(normalizedEmail);
      if (throttleRemainingMs > 0) {
        const retryAfterSec = Math.ceil(throttleRemainingMs / 1000);
        const retryAfterMin = Math.ceil(retryAfterSec / 60);
        request.log.warn(
          {
            account: crypto.createHash("sha256").update(normalizedEmail).digest("hex").slice(0, 12),
          },
          "per-account login throttle tripped",
        );
        return reply
          .code(429)
          .header("retry-after", String(retryAfterSec))
          .send({
            error: `Rate limit exceeded, retry in ${retryAfterMin} minute${retryAfterMin === 1 ? "" : "s"}`,
          });
      }
      recordLoginAttempt(normalizedEmail);

      const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
      if (!user?.passwordHash) {
        return reply.code(401).send({ error: "Invalid email or password" });
      }

      // The seeded demo account has a public, fixed password ("demo"). Outside an
      // explicitly demo-enabled non-prod environment it must never be a login
      // target — treat it as invalid credentials (no existence oracle). Defense
      // in depth alongside ensureDemoUser no longer seeding it in prod: this also
      // closes any demo row left over from an earlier build.
      if (isDemoUser(user.id) && !isDemoAccessEnabled()) {
        return reply.code(401).send({ error: "Invalid email or password" });
      }

      const valid = await comparePassword(password, user.passwordHash);
      if (!valid) {
        return reply.code(401).send({ error: "Invalid email or password" });
      }

      clearLoginAttempts(normalizedEmail);

      // Transparent hash upgrade (legacy cost 10 → BCRYPT_COST): rehash with
      // the just-verified password. Fire-and-forget so sign-in never waits on
      // the ~4x-cost hash, and CAS-guarded on the exact verified hash so a
      // concurrent password change is never clobbered (same updateMany idiom
      // as change-password). No sessionsInvalidatedAt — the password itself
      // is unchanged, so nothing gets revoked. The in-flight set caps the
      // background hash at 1 per user, so concurrent valid-credential logins
      // across IPs can't stack cost-12 hashes on the event loop. Known edge,
      // accepted: a change-password racing the rehash window can lose its CAS
      // and see a spurious 409 "changed elsewhere" — retry succeeds.
      if (passwordHashNeedsUpgrade(user.passwordHash) && !rehashInFlight.has(user.id)) {
        rehashInFlight.add(user.id);
        const verifiedHash = user.passwordHash;
        hashPassword(password)
          .then((newHash) =>
            prisma.user.updateMany({
              where: { id: user.id, passwordHash: verifiedHash },
              data: { passwordHash: newHash },
            }),
          )
          .catch((err) =>
            captureError(err, { tags: { scope: "auth.rehash" }, extra: { userId: user.id } }),
          )
          .finally(() => rehashInFlight.delete(user.id));
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
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          plan: user.plan,
          role: user.role,
          // Include entitled here too (not just /me) so the client paywall guard
          // never sees it undefined at session start and skips the check.
          entitled: isEntitled(user.plan, user.role),
          // Hard-wall only pure subscriber-only mode; with the usable free tier
          // this is always false so free users get into the app.
          paywalled: isHardPaywalled(user.plan, user.role),
          // Whether the web (Stripe) checkout can complete (key + PRO price
          // configured). The web paywall disables its subscribe button when
          // false so a native-IAP-only launch never shows a dead button.
          webCheckoutAvailable: isWebCheckoutAvailable(),
        },
      });
    },
  );

  // GET /api/auth/me — Get current user
  app.get("/me", { preHandler: requireAuth }, async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "Not authenticated" });
    }

    try {
      const payload = verifyToken(auth.slice(7));
      const user = await prisma.user.findUnique({ where: { id: payload.userId } });
      if (!user) return reply.code(404).send({ error: "User not found" });

      // Keep an ADMIN_EMAILS operator's DB role in sync. Admin-ness was split:
      // ADMIN_EMAILS granted admin ROUTES, but feature gates (planHasFeature,
      // isEntitled) read User.role — which stayed "USER", so an env-admin was
      // silently gated as a free user (e.g. multi-inbox sync skipped). Promote
      // once on session bootstrap so User.role is the single source of truth.
      // Only promote a VERIFIED account: a self-serve unverified row on an
      // ADMIN_EMAILS address (pre-registration) must not auto-escalate to ADMIN
      // before the real owner proves ownership (security audit 2026-07-21).
      if (user.role !== "ADMIN" && user.emailVerified && isAdminEmail(user.email)) {
        await prisma.user
          .update({ where: { id: user.id }, data: { role: "ADMIN" } })
          .catch((err) => {
            console.error(
              `[AUTH] Failed to promote ADMIN_EMAILS user ${user.id} to role ADMIN:`,
              err,
            );
            captureError(err, { tags: { scope: "auth.admin-promote", userId: user.id } });
          });
        user.role = "ADMIN";
      }

      const googleStatus = await getGoogleConnectionStatus(user.id);
      // Any non-primary mail source (linked Google inbox, Naver/iCloud IMAP)
      // also counts as "has mail" — see hasAnyMailSource below. Retried so a
      // transient DB blip can't masquerade as "Invalid token" via the outer
      // catch (a real session must not read as a hard logout).
      const linkedInboxCount = await withDbRetry(
        () => prisma.linkedInboxAccount.count({ where: { userId: user.id } }),
        { label: "me.linked_inbox_count" },
      );

      return reply.send({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          plan: user.plan,
          role: user.role,
          // Whether the user may use paid features (active sub / trial / comped
          // / admin). Gates Pro-only capabilities. Always true while
          // PAYWALL_ENABLED is off, so nothing gates pre-launch.
          entitled: isEntitled(user.plan, user.role),
          // Whether to hard-wall the app on entry (pure subscriber-only mode).
          // Always false with the usable free tier — free users get in and are
          // bounded by the free daily cost cap instead.
          paywalled: isHardPaywalled(user.plan, user.role),
          // Whether the web (Stripe) checkout can complete (key + PRO price
          // configured). The web paywall disables its subscribe button when
          // false so a native-IAP-only launch never shows a dead button.
          webCheckoutAvailable: isWebCheckoutAvailable(),
          // Stored IANA timezone (User.timezone, default "Asia/Seoul").
          // Surfaced so the web client can render calendar/briefing times
          // in the user's intended zone instead of the browser default
          // (which can disagree — e.g., iOS PWA falling back to UTC).
          timezone: (user as unknown as { timezone?: string | null }).timezone ?? "Asia/Seoul",
          googleConnected: googleStatus.connected,
          googleNeedsReconnect: googleStatus.needsReconnect,
          // Whether ANY mail source is attached — the primary Google grant or
          // a linked/IMAP inbox. The web AuthGuard keys its onboarding
          // redirect on this instead of googleConnected alone, so an
          // Apple/Naver-login user who connected Naver IMAP is not bounced
          // out of the app forever.
          hasAnyMailSource: googleStatus.connected || linkedInboxCount > 0,
        },
      });
    } catch {
      return reply.code(401).send({ error: "Invalid token" });
    }
  });

  // PATCH /api/auth/me — Update profile
  app.patch(
    "/me",
    { preHandler: requireAuth, schema: { body: updateProfileBodySchema } },
    async (request, reply) => {
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
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          plan: user.plan,
          role: user.role,
          // Include entitled here too (not just /me) so the client paywall guard
          // never sees it undefined at session start and skips the check.
          entitled: isEntitled(user.plan, user.role),
          // Hard-wall only pure subscriber-only mode; with the usable free tier
          // this is always false so free users get into the app.
          paywalled: isHardPaywalled(user.plan, user.role),
          // Whether the web (Stripe) checkout can complete (key + PRO price
          // configured). The web paywall disables its subscribe button when
          // false so a native-IAP-only launch never shows a dead button.
          webCheckoutAvailable: isWebCheckoutAvailable(),
        },
      });
    },
  );

  // POST /api/auth/change-password — Change password
  app.post(
    "/change-password",
    {
      preHandler: requireAuth,
      schema: { headers: authHeaderSchema, body: changePasswordBodySchema },
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
    },
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
        // Stamp the session epoch so pre-change JWTs are revoked by the epoch
        // gate (not just the Device table) — same as the reset-password path.
        data: { passwordHash: await hashPassword(newPassword), sessionsInvalidatedAt: new Date() },
      });
      if (updated.count === 0) {
        return reply
          .code(409)
          .send({ error: "Password was changed elsewhere. Please log in again." });
      }

      // Password change revokes ALL sessions, including the current one. The
      // epoch stamp above already invalidates every pre-change JWT (current
      // token included — its iat predates the new epoch), so "keep the current
      // session" is no longer achievable without re-issuing a token; the safe,
      // standard posture is a full revocation + fresh login on every device.
      // Drop all device rows to match. The web's 401 handler redirects the
      // current session to login on its next request.
      await prisma.device.deleteMany({ where: { userId } });

      return reply.send({ success: true });
    },
  );

  // POST /api/auth/set-password — Set password for OAuth users who don't have one
  app.post(
    "/set-password",
    {
      preHandler: requireAuth,
      schema: { headers: authHeaderSchema, body: setPasswordBodySchema },
    },
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
  app.get("/has-password", { preHandler: requireAuth }, async (request, reply) => {
    const userId = getUserId(request);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });
    return reply.send({ hasPassword: !!user?.passwordHash });
  });

  // In-memory store for desktop login (server-generated nonce → { jwt, expiresAt }).
  // Only nonces generated by /desktop-nonce are accepted — prevents arbitrary polling.
  // `relayed` marks a nonce whose OAuth already completed and whose JWT went to
  // the app by deep link. The entry deliberately outlives that handoff (it just
  // never gains a `jwt`): polling it is the app's only recovery path when the
  // browser refuses the scheme launch, and the flag still burns the nonce for
  // starting a SECOND login.

  // OAuth exchange codes moved to auth/exchange-codes.ts (module-level) so the
  // Apple/Naver callbacks in routes/social-auth.ts mint codes this file's
  // POST /exchange-code endpoint can redeem. Same map, same semantics.

  // GET /api/auth/desktop-nonce — Desktop app must call this FIRST to obtain a
  // server-generated nonce before opening the browser for Google login. Calling
  // /desktop-token with a nonce that was never issued here returns 404, so
  // attackers cannot enumerate or poll for arbitrary nonces.
  app.get(
    "/desktop-nonce",
    { schema: { querystring: desktopNonceQuerySchema } },
    async (request, reply) => {
      // PKCE: the client sends a SHA-256 challenge of a locally-held verifier that
      // never transits the browser/OAuth redirect. Binding token retrieval to that
      // verifier stops anyone who merely observes the nonce (browser history,
      // Referer, or server logs) from stealing the freshly minted session JWT.
      const { challenge } = request.query as { challenge?: string };
      // PKCE is now REQUIRED: every shipped client (desktop 0.4.80015+, mobile
      // native-auth) sends a SHA-256 base64url challenge (43 chars). Refusing a
      // challenge-less mint removes the legacy "no challenge -> skip verifier"
      // path that left an observed nonce redeemable (security audit 2026-07-20,
      // G4 closed). An out-of-date client that omits it is told to update.
      if (typeof challenge !== "string" || challenge.length < 32) {
        return reply
          .code(400)
          .send({ error: "Missing PKCE challenge. Please update your Klorn app." });
      }
      const nonce = crypto.randomBytes(32).toString("hex");
      const expiresAt = Date.now() + 10 * 60 * 1000; // 10 min window for user to complete login
      desktopLoginTokens.set(nonce, { expiresAt, challenge });
      setTimeout(() => desktopLoginTokens.delete(nonce), 10 * 60 * 1000);
      return reply.send({ nonce });
    },
  );

  // GET /api/auth/google/login — Start Google social login flow
  // Desktop flow: call /desktop-nonce first, then open this URL with ?source=desktop&nonce=
  app.get(
    "/google/login",
    { schema: { querystring: googleLoginQuerySchema } },
    async (request, reply) => {
      const { source, nonce, appScheme, attr } = request.query as {
        source?: string;
        nonce?: string;
        appScheme?: string;
        attr?: string;
      };
      const isDesktop = source === "desktop" && nonce;
      if (isDesktop) {
        const entry = desktopLoginTokens.get(nonce as string);
        if (!entry || entry.jwt !== undefined || entry.relayed || entry.expiresAt < Date.now()) {
          return reply
            .code(400)
            .send({ error: "Invalid or expired nonce. Call /api/auth/desktop-nonce first." });
        }
      }
      const loginState = signToken(
        {
          userId: isDesktop ? nonce : "__login__",
          email: isDesktop ? "__google_login_desktop__" : "__google_login__",
          // Carry an allowlisted native scheme so the callback can deep-link the
          // token back to the user's own app instead of parking it for polling.
          ...(isDesktop && isAllowedNativeScheme(appScheme) ? { appScheme } : {}),
          ...(attr ? { attr } : {}),
        },
        // Same short replay window as every other OAuth-initiating route — an
        // intercepted state URL must not be honored for the default 7-day
        // token lifetime (security audit 2026-07-20, consistency with link flows).
        "10m",
      );
      const url = getLoginAuthUrl(loginState);
      return reply.redirect(url);
    },
  );

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
      // PKCE gate (always enforced — every nonce now carries a challenge, see
      // /desktop-nonce): the caller must present the matching verifier via a
      // header, so it never lands in a URL/access log. The verifier never went
      // through the browser, so an observer of the nonce cannot satisfy this.
      if (entry.challenge) {
        const header = request.headers["x-desktop-verifier"];
        const verifier = Array.isArray(header) ? header[0] : header;
        const ok =
          typeof verifier === "string" &&
          crypto.createHash("sha256").update(verifier).digest("base64url") === entry.challenge;
        if (!ok) return reply.code(403).send({ error: "Invalid verifier" });
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
  app.post("/google/start", { preHandler: requireAuth }, async (request, reply) => {
    const userId = getUserId(request);
    if (isDemoUser(userId)) {
      return reply.code(403).send({ error: "Authentication required to connect Google" });
    }
    // Short-lived (10m), matching link-calendar/link-inbox: the callback attaches
    // a credential-bearing Google token to this user's row, so an intercepted
    // state URL (access logs, Referer) must not be replayable for the default
    // 7-day token window.
    const signedState = signToken({ userId, email: "__oauth_state__" }, "10m");
    const url = getAuthUrl(signedState);
    return reply.send({ url });
  });

  // POST /api/auth/google/link-calendar — Start OAuth to link a SECONDARY Google
  // account for calendar free/busy ONLY (calendar.readonly, no Gmail). Pro-gated.
  // Returns {url} like /google/start so the session JWT never enters the redirect.
  app.post(
    "/google/link-calendar",
    {
      preHandler: [requireAuth, requireEntitled],
      config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
      const userId = getUserId(request);
      if (isDemoUser(userId)) {
        return reply.code(403).send({ error: "Authentication required to link a calendar" });
      }
      // Short-lived state (10 min): the link callback attaches a credential-
      // bearing row, so an intercepted state URL must not be replayable for the
      // default 7-day token window.
      const signedState = signToken({ userId, email: "__link_calendar__" }, "10m");
      return reply.send({ url: getLinkCalendarAuthUrl(signedState) });
    },
  );

  // POST /api/auth/google/link-inbox — Start OAuth to link a SECONDARY Google
  // account as a FULL INBOX (gmail read/send/modify) so the firewall runs across
  // it too. Pro-gated (multi_account). Mirrors /google/link-calendar exactly —
  // short-lived signed state so an intercepted URL can't be replayed for the
  // default 7-day token window; the session JWT never enters the redirect.
  app.post(
    "/google/link-inbox",
    {
      preHandler: [requireAuth, requireEntitled],
      // OAuth-start endpoint on a public repo: cap starts so a valid token
      // can't spam consent redirects. (Calendar link lacks this today — worth a
      // follow-up to add there too; adding it to the new surface regardless.)
      config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
      const userId = getUserId(request);
      if (isDemoUser(userId)) {
        return reply.code(403).send({ error: "Authentication required to link an inbox" });
      }
      const signedState = signToken({ userId, email: "__link_inbox__" }, "10m");
      return reply.send({ url: getLinkInboxAuthUrl(signedState) });
    },
  );

  // GET /api/auth/google/callback — OAuth callback (handles both login and integration)
  app.get(
    "/google/callback",
    { schema: { querystring: googleCallbackQuerySchema } },
    async (request, reply) => {
      const {
        code,
        state,
        error: oauthError,
      } = request.query as { code?: string; state?: string; error?: string };

      const webUrl = process.env.WEB_URL || "http://localhost:8001";

      // Consent denied (or any provider-side error): Google redirects back with
      // ?error=access_denied and no code. A raw JSON 400 here strands the user on
      // an API URL — send them to the login page instead, where a friendly toast
      // explains and retry is one click. The error value is attacker-influenced
      // (it rides the redirect), so it is never reflected or logged verbatim —
      // every variant maps to the fixed google_denied marker.
      if (oauthError) {
        console.warn(
          `[OAUTH] callback returned provider error (access_denied=${oauthError === "access_denied"})`,
        );
        return reply.redirect(`${webUrl}/login?error=google_denied`);
      }

      if (!code) {
        return reply.code(400).send({ error: "Missing authorization code" });
      }

      // Validate state parameter — must be a valid server-signed JWT
      if (!state) {
        return reply.code(400).send({ error: "Missing state parameter" });
      }
      let statePayload: { userId: string; email: string; appScheme?: string; attr?: string };
      try {
        statePayload = verifyToken(state);
      } catch {
        return reply.code(400).send({ error: "Invalid or expired OAuth state" });
      }

      try {
        const oauth2 = getOAuth2Client();
        const { tokens } = await oauth2.getToken(code);

        // --- Link secondary calendar flow (state marker __link_calendar__) ---
        // A DIFFERENT Google account is being attached to the ALREADY-logged-in
        // user (statePayload.userId) purely for calendar free/busy. We do NOT
        // resolve or switch the user by this Google email — the linked token only
        // ever feeds checkConflicts.
        if (statePayload.email === "__link_calendar__") {
          if (!tokens.access_token) {
            return reply.redirect(`${webUrl}/calendar?linked=failed`);
          }
          const profile = await getGoogleUserInfo(tokens.access_token);
          if (profile.verified_email !== true) {
            return reply.redirect(`${webUrl}/calendar?linked=unverified`);
          }
          // Re-verify entitlement at callback time. The initiate endpoint gates on
          // requireEntitled, but the user could downgrade during the 10-min OAuth
          // window — without this the lapsed user still links a Pro-only secondary
          // calendar (TOCTOU). Inert while PAYWALL is off (entitled always true),
          // load-bearing the moment it flips.
          const calLinker = await prisma.user.findUnique({
            where: { id: statePayload.userId },
            select: { plan: true, role: true },
          });
          if (!calLinker || !isEntitled(calLinker.plan, calLinker.role)) {
            return reply.redirect(`${webUrl}/calendar?linked=failed`);
          }
          const linkedEmail = normalizeEmail(profile.email);
          // Linking your own primary address duplicates the mailbox: the
          // selector shows it twice and every sync runs double. Refuse it.
          const linkOwner = await prisma.user.findUnique({
            where: { id: statePayload.userId },
            select: { email: true },
          });
          if (linkOwner?.email && normalizeEmail(linkOwner.email) === linkedEmail) {
            return reply.redirect(`${webUrl}/settings?inbox=self`);
          }
          const expiresAt = tokens.expiry_date ? new Date(tokens.expiry_date) : null;
          await prisma.linkedCalendarAccount.upsert({
            where: {
              userId_provider_email: {
                userId: statePayload.userId,
                provider: "GOOGLE",
                email: linkedEmail,
              },
            },
            update: {
              accessToken: encryptToken(tokens.access_token),
              refreshToken: encryptOptional(tokens.refresh_token),
              expiresAt,
              // Re-linking a previously-revoked calendar clears the reconnect prompt.
              needsReconnect: false,
            },
            create: {
              userId: statePayload.userId,
              provider: "GOOGLE",
              email: linkedEmail,
              accessToken: encryptToken(tokens.access_token),
              refreshToken: encryptOptional(tokens.refresh_token),
              expiresAt,
            },
          });
          return reply.redirect(`${webUrl}/calendar?linked=success`);
        }

        // --- Link secondary inbox flow (state marker __link_inbox__) ---
        // A DIFFERENT Google account is attached to the ALREADY-logged-in user
        // (statePayload.userId) as an additional mail source. We NEVER resolve or
        // switch the session user by this Google email — the linked token only
        // feeds this user's own firewall. verified_email is checked verbatim (as
        // the calendar flow does) to block the confused-deputy vector of linking
        // an unverified/spoofed address.
        if (statePayload.email === "__link_inbox__") {
          if (!tokens.access_token) {
            return reply.redirect(`${webUrl}/settings?inbox=failed`);
          }
          const profile = await getGoogleUserInfo(tokens.access_token);
          if (profile.verified_email !== true) {
            return reply.redirect(`${webUrl}/settings?inbox=unverified`);
          }
          // Re-verify entitlement at callback time (TOCTOU): a Pro user who
          // downgraded during the 10-min OAuth window must not complete a Pro-only
          // inbox link. Inert while PAYWALL is off; load-bearing once it flips.
          const inboxLinker = await prisma.user.findUnique({
            where: { id: statePayload.userId },
            select: { plan: true, role: true },
          });
          if (!inboxLinker || !isEntitled(inboxLinker.plan, inboxLinker.role)) {
            return reply.redirect(`${webUrl}/settings?inbox=failed`);
          }
          const linkedEmail = normalizeEmail(profile.email);
          const expiresAt = tokens.expiry_date ? new Date(tokens.expiry_date) : null;
          // Cap NEW links only: a re-link (existing row → update path) must always
          // be allowed so a user can never lock themselves out of reconnecting an
          // inbox they already have.
          const existingLink = await prisma.linkedInboxAccount.findUnique({
            // The dedup key gained provider (Phase 0a): this route links Google
            // accounts, so it addresses the GOOGLE slice of the key explicitly.
            where: {
              userId_provider_email: {
                userId: statePayload.userId,
                provider: "GOOGLE",
                email: linkedEmail,
              },
            },
            select: { id: true },
          });
          if (!existingLink) {
            const linkedCount = await prisma.linkedInboxAccount.count({
              // GOOGLE only: the cap governs Google links; Naver has its own
              // cap on its own route (MAX_NAVER_ACCOUNTS).
              where: { userId: statePayload.userId, provider: "GOOGLE" },
            });
            if (linkedCount >= MAX_LINKED_INBOXES) {
              return reply.redirect(`${webUrl}/settings?inbox=limit`);
            }
          }
          await prisma.linkedInboxAccount.upsert({
            where: {
              userId_provider_email: {
                userId: statePayload.userId,
                provider: "GOOGLE",
                email: linkedEmail,
              },
            },
            update: {
              accessToken: encryptToken(tokens.access_token),
              refreshToken: encryptOptional(tokens.refresh_token),
              expiresAt,
              // Re-linking a previously-revoked inbox clears the reconnect prompt.
              needsReconnect: false,
            },
            create: {
              userId: statePayload.userId,
              email: linkedEmail,
              accessToken: encryptToken(tokens.access_token),
              refreshToken: encryptOptional(tokens.refresh_token),
              expiresAt,
            },
          });
          return reply.redirect(`${webUrl}/settings?inbox=success`);
        }

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

          // Trust this Google identity to resolve/link an account ONLY when
          // Google itself verified the email. Without this, an OAuth token for an
          // account whose (unverified) email equals a victim's existing
          // password-based account would log straight in as the victim and stamp
          // emailVerified:true — the same check the OIDC push path already
          // enforces (gmail-push.ts). Consumer @gmail.com is always verified;
          // this closes the Workspace/custom-domain unverified-alias vector.
          if (profile.verified_email !== true) {
            return reply.redirect(`${webUrl}/login?error=google_unverified`);
          }

          // Normalize to trimmed-lowercase like every email/password path — else a
          // Workspace/custom-domain user whose Google email casing differs from
          // their password-account email resolves to a DIFFERENT (or duplicate)
          // row than the case-insensitive password lookups.
          const email = normalizeEmail(profile.email);

          // Find or create user by email. Wrapped with withDbRetry so a Neon
          // cold-start during sign-in (suspended compute waking up) does not
          // surface as a hard "Can't reach database server" failure to the
          // user — silent retry covers the wake-up window.
          let user = await withDbRetry(() => prisma.user.findUnique({ where: { email } }), {
            label: "oauth.find_user_by_email",
          });
          const isNewGoogleUser = !user;
          // Defense in depth: never let Google login resolve INTO the shared demo
          // account (a legacy demo-user row left from before the demo lockout
          // shipped). The password /login guard only covers its own path; the demo
          // email is on the operator's own domain, so this is belt-and-suspenders.
          if (user && isDemoUser(user.id) && !isDemoAccessEnabled()) {
            return reply.redirect(`${webUrl}/login?error=google_failed`);
          }
          if (!user) {
            // Beta gate: when BETA_GATE_ENABLED=true, the Google sign-in path
            // can only create a new user if they have an APPROVED waitlist
            // entry. This mirrors the email/password register endpoint so the
            // two paths cannot diverge. Existing users always pass through.
            const betaGateEnabled = process.env.BETA_GATE_ENABLED === "true";
            if (betaGateEnabled) {
              const waitlistEntry = await prisma.waitlist.findUnique({
                where: { email },
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
                    email,
                    name: profile.name || email.split("@")[0],
                    passwordHash: null, // Google-only user, no password
                    emailVerified: true, // Google accounts are pre-verified
                    ...(betaGateEnabled && { plan: "PRO" }),
                    ...(betaAutoProGrant ?? {}),
                    ...(statePayload.attr ? { attribution: statePayload.attr } : {}),
                  },
                }),
              { label: "oauth.create_user" },
            );
          } else if (!user.emailVerified) {
            // A Google login proves ownership of this address. If the existing row
            // was created via self-serve password registration but never verified,
            // it may be a pre-registration takeover — an attacker who set a
            // password on the victim's address before they signed in with Google
            // (security audit 2026-07-21). Invalidate that password AND all its
            // sessions so only the Google-verified owner keeps control; the
            // attacker can no longer log in with the password they set.
            const wasUnverifiedPassword = Boolean(user!.passwordHash);
            await withDbRetry(
              () =>
                prisma.user.update({
                  where: { id: user!.id },
                  data: {
                    emailVerified: true,
                    ...(wasUnverifiedPassword
                      ? { passwordHash: null, sessionsInvalidatedAt: new Date() }
                      : {}),
                  },
                }),
              { label: "oauth.verify_user" },
            );
            if (wasUnverifiedPassword) {
              await prisma.device.deleteMany({ where: { userId: user!.id } }).catch(() => {});
            }
          }

          // Incremental auth: login requests identity scopes only, so there is
          // no Gmail/Calendar grant to persist here. The primary Google token is
          // stored exclusively by the connect flow (__oauth_state__ branch
          // below) — saving the identity-only token would make every
          // "has a UserToken row ⇒ has Gmail" consumer (connection status,
          // watch renewal, sync schedulers) treat this user as connected and
          // 403 forever.

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

          // First Google sign-in for this address → founder welcome (once per
          // user, enforced inside the helper). Google profiles are pre-verified,
          // so the address is real. Fire-and-forget so it never delays the
          // redirect, but log on rejection — never silent.
          if (isNewGoogleUser) {
            void maybeSendWelcomeEmail({ id: user.id, email: user.email, name: user.name }).catch(
              (err) =>
                console.error(`[WELCOME] google sign-in welcome failed for ${user!.id}:`, err),
            );
          }

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
            // App-scheme relay (RFC 8252): when the client registered an
            // allowlisted native scheme, deliver the JWT via a one-time exchange
            // code deep-linked to THAT app on the user's device. This closes
            // login-CSRF — the token reaches whoever holds the app on the device
            // that completed OAuth, not whoever polls the nonce. No scheme → the
            // legacy poll flow (kept for clients that haven't adopted the relay).
            if (isAllowedNativeScheme(statePayload.appScheme)) {
              const relayCode = crypto.randomBytes(20).toString("hex");
              exchangeCodes.set(relayCode, { jwt: token, expiresAt: Date.now() + 60_000 });
              setTimeout(() => exchangeCodes.delete(relayCode), 60_000);
              // Keep the entry, still WITHOUT a jwt — deleting it made the app's
              // poll answer "nonce not recognized" (404) the moment the browser
              // blocked the scheme launch, turning a recoverable state into a
              // hard sign-in failure. `relayed` burns the nonce for starting
              // another login; the JWT is still never parked, so an attacker who
              // knows the nonce can never poll out the victim's session.
              const relayedEntry = desktopLoginTokens.get(nonce);
              if (relayedEntry) {
                desktopLoginTokens.set(nonce, { ...relayedEntry, relayed: true });
              }
              reply.header("Cache-Control", "no-store");
              reply.type("text/html");
              return reply.send(
                desktopHandoffPage(`${statePayload.appScheme}://oauth-callback?code=${relayCode}`),
              );
            }
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
          // No integration flag: login is identity-only now, so it has nothing
          // truthful to say about the Gmail/Calendar connection state.
          const xcode = crypto.randomBytes(20).toString("hex");
          exchangeCodes.set(xcode, { jwt: token, expiresAt: Date.now() + 60_000 });
          setTimeout(() => exchangeCodes.delete(xcode), 60_000);
          return reply.redirect(`${webUrl}/auth/callback?code=${xcode}`);
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
                ...(tokens.refresh_token
                  ? { refreshToken: encryptToken(tokens.refresh_token) }
                  : {}),
                expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
              },
            }),
          { label: "oauth.integration.upsert_user_token" },
        );

        // Register the Gmail Pub/Sub watch so new mail pushes in near-real-time
        // from the moment the account is connected. This used to live only on
        // the login path; now that connect is the sole place the primary grant
        // is stored, a fresh connect would otherwise have NO watch until the
        // hourly renewal sweep — the "why isn't mail instant?" gap. No-ops
        // cleanly when GMAIL_PUBSUB_TOPIC is unset; fire-and-forget so it never
        // delays the OAuth redirect.
        void registerGmailWatch(user.id).catch((err) => {
          // Connect is now the ONLY place a fresh watch is registered — a silent
          // failure here leaves a brand-new connection push-less until the next
          // renewal sweep, so alert like the sweep does instead of stdout-only.
          console.warn(`[GMAIL-WATCH] register on connect failed for ${user.id}:`, err);
          captureError(err, { tags: { scope: "auth.oauth.connect.watch" } });
        });

        return reply.redirect(`${webUrl}/settings?google=connected`);
      } catch (err) {
        // Never reflect the raw provider/library error to the client — it can leak
        // internal infrastructure detail (hostnames, library internals, stack
        // fragments). Log the real error server-side; show a generic message. The
        // message is now a constant, so the desktop HTML needs no escaping.
        console.error("[OAUTH] callback failed:", err instanceof Error ? err.message : String(err));
        captureError(err, { tags: { scope: "auth.oauth.callback" } });
        const message = "Google authorization failed. Please try again.";
        if (statePayload.email === "__google_login__") {
          return reply.redirect(`${webUrl}/login?error=${encodeURIComponent(message)}`);
        }
        if (statePayload.email === "__google_login_desktop__") {
          reply.type("text/html");
          return reply.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Klorn Login</title>
<style>body{font-family:system-ui;background:#0a0a0a;color:#e5e7eb;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{text-align:center;padding:40px}.err{font-size:48px;margin-bottom:16px;color:#ef4444}.t{font-size:14px;color:#9ca3af;margin-top:12px}</style>
</head><body><div class="box"><div class="err">✕</div><h2>Login Failed</h2>
<p class="t">${message}<br>Please try again in Klorn Desktop.</p>
</div></body></html>`);
        }
        return reply.code(500).send({ error: message });
      }
    },
  );

  // DELETE /api/auth/google — Disconnect Google account
  app.delete("/google", { preHandler: requireAuth }, async (request, reply) => {
    const userId = getUserId(request);
    await prisma.userToken.deleteMany({
      where: { userId, provider: "google" },
    });
    return reply.code(204).send();
  });

  // DELETE /api/auth/account — Self-service account deletion. Removes the user
  // and ALL their data (Google restricted-scope review requires a user-facing
  // way to request full deletion). Shares deleteUserAndAllData with the admin
  // route so the deletion is identical and complete. Irreversible.
  app.delete("/account", { preHandler: requireAuth }, async (request, reply) => {
    const userId = getUserId(request);
    await deleteUserAndAllData(userId);
    return reply.code(204).send();
  });

  // GET /api/auth/google/linked-calendars — list the user's linked secondary
  // calendar accounts (never returns tokens — id + email + connectedAt only).
  // Pro-gated to match the connect route, so a lapsed user can't read the paid
  // feature's data. DELETE below stays auth-only so off-boarding always works.
  app.get(
    "/google/linked-calendars",
    { preHandler: [requireAuth, requireEntitled] },
    async (request) => {
      const userId = getUserId(request);
      const accounts = await prisma.linkedCalendarAccount.findMany({
        // GOOGLE only: this is the Google linked-calendars surface.
        where: { userId, provider: "GOOGLE" },
        select: { id: true, email: true, createdAt: true, needsReconnect: true },
        orderBy: { createdAt: "asc" },
      });
      return { accounts };
    },
  );

  // DELETE /api/auth/google/linked-calendars/:id — unlink one secondary calendar.
  // Scoped by userId so a token can only remove its OWN linked accounts. Auth-only
  // (not Pro-gated) so a downgraded user can always disconnect. The events synced
  // from the account are deleted in the same transaction (C2): /api/calendar has
  // no source filter, so they would otherwise keep showing.
  app.delete(
    "/google/linked-calendars/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = getUserId(request);
      const { id } = request.params as { id: string };
      const removed = await unlinkCalendarAccount(userId, id);
      if (!removed) {
        return reply.code(404).send({ error: "Linked calendar not found" });
      }
      return { success: true };
    },
  );

  // GET /api/auth/google/linked-inboxes — list the user's linked secondary
  // inboxes (never returns tokens — id + email + connectedAt + last-sync only).
  // Pro-gated to match the connect route so a lapsed user can't read the paid
  // feature's data. lastSyncedAt lets the UI confirm an inbox is actually syncing
  // after MULTI_INBOX_SYNC_ENABLED flips (null until the first sync tick).
  app.get(
    "/google/linked-inboxes",
    { preHandler: [requireAuth, requireEntitled] },
    async (request) => {
      const userId = getUserId(request);
      const accounts = await prisma.linkedInboxAccount.findMany({
        // This is the GOOGLE linked-inboxes surface; NAVER rows share the
        // table since Phase 0b and list on /api/naver-imap/status instead.
        where: { userId, provider: "GOOGLE" },
        select: {
          id: true,
          email: true,
          createdAt: true,
          lastSyncedAt: true,
          needsReconnect: true,
        },
        orderBy: { createdAt: "asc" },
      });
      return { accounts };
    },
  );

  // DELETE /api/auth/google/linked-inboxes/:id — unlink one secondary inbox.
  // Scoped by userId so a token can only remove its OWN linked accounts. Auth-only
  // (not Pro-gated) so a downgraded user can always disconnect. Past synced mail
  // is intentionally kept (AttentionItem/DecisionLabel reference it) — mirrors how
  // disconnecting a calendar leaves past events intact.
  app.delete("/google/linked-inboxes/:id", { preHandler: requireAuth }, async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };
    const result = await prisma.linkedInboxAccount.deleteMany({
      // provider-scoped so this Google-surface endpoint can never remove a
      // NAVER row by id — Naver disconnects live on /api/naver-imap.
      where: { id, userId, provider: "GOOGLE" },
    });
    if (result.count === 0) {
      return reply.code(404).send({ error: "Linked inbox not found" });
    }
    return { success: true };
  });

  // GET /api/auth/google/status — Check if Gmail is connected and token is valid
  app.get("/google/status", { preHandler: requireAuth }, async (request, reply) => {
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

      // Only the hash is stored (one-time-token.ts); the raw token exists
      // only in the reset email.
      const { token: rawResetToken, tokenHash: resetTokenHash } = mintOneTimeToken();
      const resetTokenExp = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await prisma.user.update({
        where: { id: user.id },
        data: { resetToken: resetTokenHash, resetTokenExp },
      });

      await sendPasswordResetEmail(normalizedEmail, rawResetToken);

      return reply.send({ success: true });
    },
  );

  // POST /api/auth/reset-password — Reset password with token
  app.post(
    "/reset-password",
    {
      schema: { body: resetPasswordBodySchema },
      // Rate-limit token-grinding, matching /forgot-password and /resend-verification.
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
    },
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

      // The DB holds only the SHA-256 hash; hash the presented token to look it up.
      const presentedHash = hashOneTimeToken(token);
      const user = await prisma.user.findFirst({
        where: {
          resetToken: presentedHash,
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
          resetToken: presentedHash,
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
    {
      schema: { querystring: tokenQuerySchema },
      // 1.3.4: the last token-consuming route without its own limit. Looser
      // than the 5/15min of reset/forgot-password on purpose — this is a GET
      // that corporate mail scanners (Safe Links etc.) prefetch and that NAT'd
      // users hit from one egress IP, so 5 would trip legitimate flows.
      // Tokens are 256-bit; the limit prices probing, it isn't the defense.
      config: { rateLimit: { max: 30, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
      const { token } = request.query as { token?: string };

      if (!token) {
        return reply.code(400).send({ error: "Missing verification token" });
      }

      // The DB holds only the SHA-256 hash; hash the presented token to look it up.
      const presentedHash = hashOneTimeToken(token);
      const user = await prisma.user.findFirst({
        where: {
          verifyToken: presentedHash,
          verifyTokenExp: { gte: new Date() },
        },
        select: { id: true, email: true, name: true },
      });

      if (!user) {
        return reply.code(400).send({ error: "Invalid or expired verification token" });
      }

      // Atomic single-use verification.
      const updated = await prisma.user.updateMany({
        where: {
          id: user.id,
          verifyToken: presentedHash,
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

      // Email is now verified → the address is real and owned. Send the founder
      // welcome (once per user, enforced inside the helper). Fire-and-forget so
      // it never delays the redirect, but log on rejection — never silent.
      void maybeSendWelcomeEmail({ id: user.id, email: user.email, name: user.name }).catch((err) =>
        console.error(`[WELCOME] post-verify welcome failed for ${user.id}:`, err),
      );

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
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 3, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
      const userId = getUserId(request);
      if (isDemoUser(userId)) {
        return reply.code(403).send({ error: "Demo user" });
      }

      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return reply.code(404).send({ error: "User not found" });
      if (user.emailVerified) return reply.send({ success: true, alreadyVerified: true });

      // Only the hash is stored (one-time-token.ts); the raw token exists
      // only in the verification email.
      const { token: rawVerifyToken, tokenHash: verifyTokenHash } = mintOneTimeToken();
      const verifyTokenExp = new Date(Date.now() + 24 * 60 * 60 * 1000);

      await prisma.user.update({
        where: { id: user.id },
        data: { verifyToken: verifyTokenHash, verifyTokenExp },
      });

      await sendVerificationEmail(user.email, rawVerifyToken);
      return reply.send({ success: true });
    },
  );

  // POST /api/auth/init-sync — Trigger initial sync after login (calendar + email contacts)
  app.post("/init-sync", { preHandler: requireAuth }, async (request) => {
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

    // Sync the user's LINKED secondary inboxes on this bootstrap call. The app
    // hits init-sync on every login/reload but never POST /email/sync, and the
    // scheduler can lag on the free tier (the service hibernates), so this is the
    // reliable app-triggered path for linked mail to appear. Gated + per-account
    // isolated inside the helper; a failure is logged (and surfaces here), never fatal.
    await syncLinkedInboxesForUser(userId).catch((err) => {
      console.warn(`[INIT-SYNC] linked inbox fan-out failed for ${userId}:`, err);
      captureError(err, { tags: { scope: "auth.init-sync.linked" }, extra: { userId } });
    });

    // 1. Sync Google Calendar events (next 30 days)
    try {
      // Parse event times against the user's timezone, exactly as the 60s
      // scheduler does — otherwise first-login writes land at a different UTC
      // instant than every subsequent scheduler write (off by the UTC offset).
      const userTimezone = await readSyncTimezone(userId);
      results.calendar = await syncPrimaryCalendarWindow(
        googleSessionFromClient(auth),
        userId,
        userTimezone,
      );
    } catch (err) {
      if (isGoogleAuthError(err)) await markGoogleTokenForReconnect(userId);
      console.warn("[AUTH] init-sync calendar sync failed (non-auth):", err);
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
      console.warn("[AUTH] init-sync Gmail contact sync failed (non-auth):", err);
      // Gmail contact sync failed — skip
    }

    // 3. Sync emails from Gmail (latest INIT_SYNC_EMAIL_COUNT). This first-sync
    // snapshot is what the onboarding "review your classifications" step shows,
    // so the count doubles as the onboarding sample size (env-tunable).
    try {
      const { syncEmails, summarizeUnsummarizedEmails } = await import("../mail/email-sync.js");
      const emailResult = await syncEmails(userId, INIT_SYNC_EMAIL_COUNT);
      results.emails = emailResult.newCount;
      // Summarize in the background so freshly-synced mail doesn't sit as
      // "Klorn has not analyzed this email yet" until the user finds the manual
      // Sync button. Sweep a floor of 10 (not just newCount): mail ingested by
      // an earlier login that never got summarized must not be stranded forever.
      summarizeUnsummarizedEmails(userId, Math.max(emailResult.newCount, 10)).catch((err) => {
        console.warn("[AUTH] init-sync background summarize failed:", err);
        captureError(err, { tags: { scope: "auth.init-sync.summarize" }, extra: { userId } });
      });
    } catch (err) {
      console.warn("[AUTH] init-sync email sync failed:", err);
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
export function parseDeviceName(ua: string): string {
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
export function parseDeviceType(ua: string): string {
  if (!ua) return "web";
  if (/iPhone|iPad|Android|Mobile/i.test(ua)) return "mobile";
  if (/Electron/i.test(ua)) return "desktop";
  return "web";
}
