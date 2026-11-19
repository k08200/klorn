import crypto from "node:crypto";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { signToken, verifyToken } from "../auth.js";
import { getLoginAuthUrl, getOAuth2Client } from "../mail/gmail.js";
import { isAllowedNativeScheme } from "../routes/auth.js";
import {
  _resetPasswordResetThrottleForTests,
  PASSWORD_RESET_MAX_REQUESTS,
  PASSWORD_RESET_REUSE_MS,
  PASSWORD_RESET_WINDOW_MS,
} from "../security/password-reset-throttle.js";
import {
  _resetRegisterThrottleForTests,
  REGISTER_THROTTLE_MAX_ATTEMPTS,
  recordRegisterAttempt,
} from "../security/register-throttle.js";
import { deleteUserAndAllData } from "../user-deletion.js";

// The per-address register and reset-mail throttles are process-wide: without
// a reset, the tests that use the same address would add up across the file.
beforeEach(() => {
  _resetRegisterThrottleForTests();
  _resetPasswordResetThrottleForTests();
});

// Stub email sender — auth register fires it non-blocking and swallows errors,
// but we want to assert it was called with the right token.
const sendVerificationEmailSpy = vi.fn(async () => true);
const sendPasswordResetEmailSpy = vi.fn(async () => true);
const sendBetaInviteEmailSpy = vi.fn(async () => true);
vi.mock("../user-deletion.js", () => ({ deleteUserAndAllData: vi.fn(async () => {}) }));
vi.mock("../mail/email.js", () => ({
  sendVerificationEmail: (...args: unknown[]) => sendVerificationEmailSpy(...args),
  sendPasswordResetEmail: (...args: unknown[]) => sendPasswordResetEmailSpy(...args),
  sendBetaInviteEmail: (...args: unknown[]) => sendBetaInviteEmailSpy(...args),
}));

// Stub email-sync so init-sync's linked-inbox fan-out is a no-op in tests
// (and its transitive gmail.js imports don't need mocking here).
vi.mock("../mail/email-sync.js", () => ({
  syncLinkedInboxesForUser: vi.fn(async () => ({ newCount: 0 })),
  syncEmails: vi.fn(async () => ({ synced: 0, newCount: 0, source: "gmail" })),
  summarizeUnsummarizedEmails: vi.fn(async () => 0),
}));

// Stub gmail OAuth helpers so we don't hit googleapis in tests.
vi.mock("../mail/gmail.js", () => ({
  getAuthUrl: vi.fn(() => "https://example.com/oauth"),
  getLoginAuthUrl: vi.fn(() => "https://example.com/oauth-login"),
  getAuthedClient: vi.fn(),
  isGoogleAuthError: vi.fn(() => false),
  markGoogleTokenForReconnect: vi.fn(async () => {}),
  getGoogleConnectionStatus: vi.fn(async () => ({
    connected: false,
    hasRefreshToken: false,
    expired: false,
    needsReconnect: false,
    reason: "not_connected",
    gmailPushConfigured: false,
    gmailPushEnabled: false,
    gmailPushExpiresAt: null,
  })),
  getGoogleUserInfo: vi.fn(),
  getOAuth2Client: vi.fn(),
}));

// In-memory user / userToken / deviceSession stores.
type StoredUser = {
  id: string;
  email: string;
  passwordHash?: string | null;
  name?: string | null;
  plan: string;
  role: string;
  verifyToken?: string | null;
  verifyTokenExp?: Date | null;
  emailVerified?: boolean;
  resetToken?: string | null;
  resetTokenExp?: Date | null;
  sessionsInvalidatedAt?: Date | null;
  betaProGrantedAt?: Date | null;
  // Stands in for the `include: { automationConfig }` relation on /me.
  automationConfig?: { timezone: string } | null;
};
const userStore = new Map<string, StoredUser>();
const userByEmail = new Map<string, string>();
let nextUserId = 1;

// The background rehash is a cost-12 bcryptjs hash (pure JS): ~250 ms idle,
// over vi.waitFor's 1 s default when the full suite runs in parallel.
const REHASH_WAIT = { timeout: 15_000, interval: 50 };

type StoredWaitlist = { email: string; status: string };
const waitlistByEmail = new Map<string, StoredWaitlist>();
/** Users who own a KakaoTalk import (prisma.kakaoImport.findFirst below). */
const kakaoOwners = new Set<string>();

vi.mock("../db.js", () => {
  const prisma = {
    waitlist: {
      findUnique: vi.fn(async ({ where }: { where: { email?: string } }) => {
        if (!where.email) return null;
        return waitlistByEmail.get(where.email) ?? null;
      }),
    },
    user: {
      findUnique: vi.fn(async ({ where }: { where: { email?: string; id?: string } }) => {
        if (where.email) return userStore.get(userByEmail.get(where.email) || "") ?? null;
        if (where.id) return userStore.get(where.id) ?? null;
        return null;
      }),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: {
            resetToken?: string;
            verifyToken?: string;
            resetTokenExp?: unknown;
            verifyTokenExp?: unknown;
          };
        }) => {
          for (const user of userStore.values()) {
            if (where.resetToken && user.resetToken === where.resetToken) {
              if (user.resetTokenExp && user.resetTokenExp.getTime() >= Date.now()) return user;
              return null;
            }
            if (where.verifyToken && user.verifyToken === where.verifyToken) {
              if (user.verifyTokenExp && user.verifyTokenExp.getTime() >= Date.now()) return user;
              return null;
            }
          }
          return null;
        },
      ),
      create: vi.fn(async ({ data }: { data: Omit<StoredUser, "id" | "role"> }) => {
        const id = `user-${nextUserId++}`;
        const user: StoredUser = { id, plan: "FREE", role: "USER", ...data };
        userStore.set(id, user);
        userByEmail.set(data.email, id);
        return user;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const user = userStore.get(where.id);
          if (!user) throw new Error("User not found");
          const updated = { ...user, ...data };
          userStore.set(where.id, updated as StoredUser);
          return updated;
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: {
            id?: string;
            resetToken?: string | null;
            verifyToken?: string;
            resetTokenExp?: { gte: Date };
            verifyTokenExp?: { gte: Date };
          };
          data: Record<string, unknown>;
        }) => {
          let count = 0;
          for (const [id, user] of userStore.entries()) {
            if (where.id && id !== where.id) continue;
            // Prisma: undefined filters nothing, null matches IS NULL.
            if (where.resetToken !== undefined && (user.resetToken ?? null) !== where.resetToken) {
              continue;
            }
            if (where.verifyToken && user.verifyToken !== where.verifyToken) continue;
            if (where.resetTokenExp && (!user.resetTokenExp || user.resetTokenExp < new Date())) {
              continue;
            }
            if (
              where.verifyTokenExp &&
              (!user.verifyTokenExp || user.verifyTokenExp < new Date())
            ) {
              continue;
            }
            userStore.set(id, { ...user, ...data } as StoredUser);
            count += 1;
          }
          return { count };
        },
      ),
      count: vi.fn(async () => userStore.size),
    },
    userToken: { findFirst: vi.fn(async () => null) },
    // /me's hasAnyMailSource counts linked/IMAP inboxes alongside the Google
    // grant; none exist in these tests.
    linkedInboxAccount: { count: vi.fn(async () => 0) },
    automationConfig: { create: vi.fn(async () => ({})), upsert: vi.fn(async () => ({})) },
    device: {
      create: vi.fn(async () => ({ id: "device-1" })),
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => ({ id: "device-1" })),
      // requireAuth → isDeviceSessionValid() looks the token's device up by
      // tokenHash. Return a valid device so authed routes (now gated by
      // requireAuth, not bare getUserId) see an active session in tests.
      findUnique: vi.fn(async () => ({
        id: "device-1",
        lastActiveAt: new Date(),
        createdAt: new Date(),
      })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      update: vi.fn(async () => ({})),
      count: vi.fn(async () => 1),
    },
    // /me's kakaoImportWayOut asks whether a user owns a KakaoTalk import.
    kakaoImport: {
      findFirst: vi.fn(async ({ where }: { where: { userId: string } }) =>
        kakaoOwners.has(where.userId) ? { id: "import-1" } : null,
      ),
    },
  };
  return { prisma, db: prisma };
});

async function buildApp() {
  const { authRoutes } = await import("../routes/auth.js");
  const app = Fastify();
  await app.register(authRoutes, { prefix: "/api/auth" });
  return app;
}

function resetStores() {
  userStore.clear();
  userByEmail.clear();
  waitlistByEmail.clear();
  nextUserId = 1;
  sendVerificationEmailSpy.mockClear();
  sendPasswordResetEmailSpy.mockClear();
  sendBetaInviteEmailSpy.mockClear();
  delete process.env.BETA_GATE_ENABLED;
  delete process.env.BETA_AUTO_PRO_ENABLED;
  delete process.env.BETA_AUTO_PRO_LIMIT;
  delete process.env.ENABLE_DEMO_USER;
}

/** Register a user via the route and return the JWT token. */
async function registerAndGetToken(
  app: ReturnType<typeof Fastify>,
  email = "test@example.com",
  password = "testpassword123",
) {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email, password },
  });
  return res.json().token as string;
}

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("GET /api/auth/google/callback — error handling", () => {
  beforeEach(resetStores);

  // A provider/library error that must NEVER reach the client.
  const SECRET = "ENOTFOUND internal-oauth-host.acme.local";
  const GENERIC = "Google authorization failed. Please try again.";
  const makeTokenExchangeThrow = () =>
    vi.mocked(getOAuth2Client).mockReturnValueOnce({
      getToken: vi.fn(async () => {
        throw new Error(SECRET);
      }),
    } as never);

  it("redirects social login with a generic error, never the raw provider error", async () => {
    makeTokenExchangeThrow();
    const state = signToken({
      userId: "n1",
      email: "__google_login__",
      lb: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`,
    });
    expect(res.statusCode).toBe(302);
    const location = res.headers.location as string;
    expect(location).toContain("/login?error=");
    expect(location).toContain(encodeURIComponent(GENERIC));
    expect(location).not.toContain("ENOTFOUND");
    expect(location).not.toContain("internal-oauth-host");
    await app.close();
  });

  it("redirects consent denial (?error=access_denied) to /login?error=google_denied", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/google/callback?error=access_denied",
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("http://localhost:8001/login?error=google_denied");
    await app.close();
  });

  it("never reflects the provider error value — any ?error maps to the fixed marker", async () => {
    const app = await buildApp();
    const hostile = encodeURIComponent("<script>alert(1)</script>");
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/google/callback?error=${hostile}&code=abc`,
    });
    expect(res.statusCode).toBe(302);
    const location = res.headers.location as string;
    expect(location).toBe("http://localhost:8001/login?error=google_denied");
    expect(location).not.toContain("script");
    await app.close();
  });

  it("returns a generic error on the integration 500, never the raw provider error", async () => {
    makeTokenExchangeThrow();
    const state = signToken({ userId: "u-int", email: "user@example.com" });
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`,
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe(GENERIC);
    expect(JSON.stringify(res.json())).not.toContain("ENOTFOUND");
    await app.close();
  });
});

describe("desktop-token PKCE verifier gate", () => {
  beforeEach(resetStores);

  const verifier = "on-device-verifier-abc123";
  // Matches the server's crypto.createHash("sha256").update(v).digest("base64url").
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

  async function getNonce(app: ReturnType<typeof Fastify>, withChallenge: boolean) {
    const url = withChallenge
      ? `/api/auth/desktop-nonce?challenge=${encodeURIComponent(challenge)}`
      : "/api/auth/desktop-nonce";
    const res = await app.inject({ method: "GET", url });
    return res.json().nonce as string;
  }

  it("returns 403 when a challenge was registered but no verifier is presented", async () => {
    const app = await buildApp();
    const nonce = await getNonce(app, true);
    const res = await app.inject({ method: "GET", url: `/api/auth/desktop-token/${nonce}` });
    expect(res.statusCode).toBe(403);
  });

  it("returns 403 for a wrong verifier — an observer of the nonce cannot retrieve the token", async () => {
    const app = await buildApp();
    const nonce = await getNonce(app, true);
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/desktop-token/${nonce}`,
      headers: { "x-desktop-verifier": "attacker-guess" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("accepts the correct verifier and falls through to pending (202) until the JWT is issued", async () => {
    const app = await buildApp();
    const nonce = await getNonce(app, true);
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/desktop-token/${nonce}`,
      headers: { "x-desktop-verifier": verifier },
    });
    expect(res.statusCode).toBe(202);
  });

  it("rejects a challenge-less nonce mint with 400 (PKCE now required)", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/auth/desktop-nonce" });
    expect(res.statusCode).toBe(400);
  });
});

describe("isAllowedNativeScheme — OAuth relay allowlist", () => {
  it("accepts the fixed native app schemes", () => {
    expect(isAllowedNativeScheme("ai.klorn.app")).toBe(true);
    expect(isAllowedNativeScheme("klorn")).toBe(true);
  });

  it("rejects attacker-controlled schemes and non-strings", () => {
    // The token is deep-linked to `<scheme>://oauth-callback` — only fixed Klorn
    // schemes may be a target, so an attacker cannot redirect it to their own app.
    expect(isAllowedNativeScheme("evil.app")).toBe(false);
    expect(isAllowedNativeScheme("https://evil.com")).toBe(false);
    expect(isAllowedNativeScheme("")).toBe(false);
    expect(isAllowedNativeScheme(undefined)).toBe(false);
    expect(isAllowedNativeScheme(42)).toBe(false);
  });
});

describe("desktop /google/login — appScheme relay binding", () => {
  beforeEach(resetStores);

  async function issueNonce(app: ReturnType<typeof Fastify>): Promise<string> {
    const challenge = crypto.createHash("sha256").update("relay-test-verifier").digest("base64url");
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/desktop-nonce?challenge=${encodeURIComponent(challenge)}`,
    });
    return res.json().nonce as string;
  }

  it("carries an allowlisted appScheme into the signed OAuth state", async () => {
    const app = await buildApp();
    const nonce = await issueNonce(app);
    vi.mocked(getLoginAuthUrl).mockClear();
    await app.inject({
      method: "GET",
      url: `/api/auth/google/login?source=desktop&nonce=${nonce}&appScheme=ai.klorn.app`,
    });
    const state = vi.mocked(getLoginAuthUrl).mock.calls[0]?.[0] as string;
    expect(verifyToken(state).appScheme).toBe("ai.klorn.app");
  });

  it("drops a non-allowlisted appScheme so it can never become a relay target", async () => {
    const app = await buildApp();
    const nonce = await issueNonce(app);
    vi.mocked(getLoginAuthUrl).mockClear();
    await app.inject({
      method: "GET",
      url: `/api/auth/google/login?source=desktop&nonce=${nonce}&appScheme=evil.app`,
    });
    const state = vi.mocked(getLoginAuthUrl).mock.calls[0]?.[0] as string;
    expect(verifyToken(state).appScheme).toBeUndefined();
  });
});

describe("inflow attribution", () => {
  it("stores the attribution the client captured at first touch", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "attr@example.com",
        password: "password123",
        attribution: "utm_source=hn utm_medium=post lp=/",
      },
    });

    expect(res.statusCode).toBe(201);
    const { prisma } = (await import("../db.js")) as unknown as {
      prisma: { user: { create: ReturnType<typeof vi.fn> } };
    };
    const created = prisma.user.create.mock.calls.at(-1)?.[0] as { data: { attribution?: string } };
    expect(created.data.attribution).toBe("utm_source=hn utm_medium=post lp=/");
    await app.close();
  });

  it("registers fine with no attribution at all", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "noattr@example.com", password: "password123" },
    });

    expect(res.statusCode).toBe(201);
    const { prisma } = (await import("../db.js")) as unknown as {
      prisma: { user: { create: ReturnType<typeof vi.fn> } };
    };
    const created = prisma.user.create.mock.calls.at(-1)?.[0] as { data: { attribution?: string } };
    expect(created.data.attribution).toBeUndefined();
    await app.close();
  });

  it("caps a hand-forged attribution string instead of storing it whole", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "longattr@example.com",
        password: "password123",
        // The value is client-supplied, so the column must not inherit whatever
        // length an attacker feels like sending.
        attribution: "x".repeat(5000),
      },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("POST /api/auth/register", () => {
  beforeEach(resetStores);

  it("stores only a SHA-256 hash of the verification token at register", async () => {
    const app = await buildApp();
    await registerAndGetToken(app, "vhash@example.com");

    const rawToken = sendVerificationEmailSpy.mock.calls[0]?.[1] as string;
    const stored = userStore.get("user-1")?.verifyToken;
    expect(rawToken).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).toBe(crypto.createHash("sha256").update(rawToken).digest("hex"));
    expect(stored).not.toBe(rawToken);
    await app.close();
  });

  it("creates a user, returns a valid JWT, and fires a verification email", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "alice@example.com",
        password: "correcthorsebatterystaple",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user.email).toBe("alice@example.com");
    expect(body.user.id).toBe("user-1");

    // Token must decode to the new user.
    const payload = verifyToken(body.token);
    expect(payload.userId).toBe("user-1");
    expect(payload.email).toBe("alice@example.com");

    // Password must not be stored as plaintext.
    const stored = userStore.get("user-1");
    expect(stored?.passwordHash).toBeTruthy();
    expect(stored?.passwordHash).not.toBe("correcthorsebatterystaple");

    // Verification email is non-blocking — give the microtask queue one tick.
    await new Promise((resolve) => setImmediate(resolve));
    expect(sendVerificationEmailSpy).toHaveBeenCalledWith("alice@example.com", expect.any(String));

    await app.close();
  });

  it("rejects missing email or password", async () => {
    const app = await buildApp();
    const res1 = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "a@b.com" },
    });
    expect(res1.statusCode).toBe(400);

    const res2 = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { password: "longenough" },
    });
    expect(res2.statusCode).toBe(400);

    await app.close();
  });

  it("rejects passwords shorter than 8 characters", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "short@example.com", password: "short" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/8 characters/);
    await app.close();
  });

  it("rejects duplicate emails with 409", async () => {
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "dup@example.com", password: "longenoughpw" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "dup@example.com", password: "differentpw" },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  // Register answers 409 for a taken address and hands a session back at once
  // (no verification step), so it stays an existence oracle by design
  // (docs/security/account-enumeration.md). The per-IP limit prices a sweep of
  // many addresses; this per-address window prices hammering one from many IPs.
  describe("per-address throttle", () => {
    async function attempt(app: Awaited<ReturnType<typeof buildApp>>, email: string, ip: string) {
      return app.inject({
        method: "POST",
        url: "/api/auth/register",
        remoteAddress: ip,
        payload: { email, password: "longenoughpw" },
      });
    }

    it("locks one address after the window's attempts, from any source, with the per-IP limiter's body", async () => {
      const app = await buildApp();
      const statuses: number[] = [];
      for (let i = 0; i < REGISTER_THROTTLE_MAX_ATTEMPTS; i++) {
        statuses.push((await attempt(app, "Target@Example.com", `10.0.0.${i + 1}`)).statusCode);
      }
      expect(statuses[0]).toBe(201);
      expect(new Set(statuses.slice(1))).toEqual(new Set([409]));

      const locked = await attempt(app, "  target@example.com ", "10.0.1.1");
      expect(locked.statusCode).toBe(429);
      expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
      expect(locked.json()).toEqual({
        error: expect.stringMatching(/^Rate limit exceeded, retry in \d+ minutes?$/),
      });
      await app.close();
    });

    it("answers a locked attempt before any lookup, alike for a taken and a fresh address", async () => {
      const app = await buildApp();
      for (let i = 0; i < REGISTER_THROTTLE_MAX_ATTEMPTS; i++) {
        await attempt(app, "taken@example.com", `10.0.0.${i + 1}`);
      }
      // A window full of attempts on an address that never got an account
      // (each one lost to a refusal or a race): the route cannot tell.
      for (let i = 0; i < REGISTER_THROTTLE_MAX_ATTEMPTS; i++) {
        recordRegisterAttempt("fresh@example.com");
      }
      sendVerificationEmailSpy.mockClear();
      const { prisma } = await import("../db.js");
      const lookups = vi.mocked(prisma.user.findUnique).mock.calls.length;

      const taken = await attempt(app, "taken@example.com", "10.0.3.1");
      const fresh = await attempt(app, "fresh@example.com", "10.0.3.2");

      expect([taken.statusCode, fresh.statusCode]).toEqual([429, 429]);
      expect(fresh.json()).toEqual(taken.json());
      expect(vi.mocked(prisma.user.findUnique).mock.calls.length).toBe(lookups);
      expect(userByEmail.has("fresh@example.com")).toBe(false);
      await new Promise((resolve) => setImmediate(resolve));
      expect(sendVerificationEmailSpy).not.toHaveBeenCalled();
      await app.close();
    });

    it("does not count an attempt the beta gate refuses", async () => {
      const app = await buildApp();
      process.env.BETA_GATE_ENABLED = "true";
      for (let i = 0; i < REGISTER_THROTTLE_MAX_ATTEMPTS + 2; i++) {
        expect((await attempt(app, "invitee@example.com", `10.0.2.${i + 1}`)).statusCode).toBe(403);
      }
      delete process.env.BETA_GATE_ENABLED;
      expect((await attempt(app, "invitee@example.com", "10.0.3.1")).statusCode).toBe(201);
      await app.close();
    });

    it("leaves every other address alone", async () => {
      const app = await buildApp();
      for (let i = 0; i < REGISTER_THROTTLE_MAX_ATTEMPTS + 1; i++) {
        await attempt(app, "busy@example.com", `10.0.0.${i + 1}`);
      }
      expect((await attempt(app, "other@example.com", "10.0.0.1")).statusCode).toBe(201);
      await app.close();
    });

    it("does not count a request refused for its input", async () => {
      const app = await buildApp();
      for (let i = 0; i < REGISTER_THROTTLE_MAX_ATTEMPTS + 2; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/api/auth/register",
          payload: { email: "typo@example.com", password: "short" },
        });
        expect(res.statusCode).toBe(400);
      }
      expect((await attempt(app, "typo@example.com", "10.0.0.1")).statusCode).toBe(201);
      await app.close();
    });
  });

  it("normalizes email and trims name on register", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "  Alice@Example.COM  ",
        password: "correcthorsebatterystaple",
        name: "  Alice  ",
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().user.email).toBe("alice@example.com");
    expect(res.json().user.name).toBe("Alice");
    await app.close();
  });

  it("rejects register with empty name", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "alice@example.com",
        password: "correcthorsebatterystaple",
        name: "   ",
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("POST /api/auth/register — beta gate", () => {
  beforeEach(resetStores);

  it("rejects with 403 when BETA_GATE_ENABLED and email is not on the waitlist", async () => {
    process.env.BETA_GATE_ENABLED = "true";
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "stranger@example.com", password: "correcthorsebatterystaple" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/invite-only/i);
    await app.close();
  });

  it("rejects with 403 when waitlist entry is PENDING", async () => {
    process.env.BETA_GATE_ENABLED = "true";
    waitlistByEmail.set("waiting@example.com", { email: "waiting@example.com", status: "PENDING" });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "waiting@example.com", password: "correcthorsebatterystaple" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("rejects with 403 when waitlist entry is REJECTED", async () => {
    process.env.BETA_GATE_ENABLED = "true";
    waitlistByEmail.set("nope@example.com", { email: "nope@example.com", status: "REJECTED" });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "nope@example.com", password: "correcthorsebatterystaple" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("lets an APPROVED waitlist entry register — on FREE, like everyone else", async () => {
    // Approval opens the door; it does not comp the account. Pro is paid.
    process.env.BETA_GATE_ENABLED = "true";
    waitlistByEmail.set("approved@example.com", {
      email: "approved@example.com",
      status: "APPROVED",
    });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "approved@example.com", password: "correcthorsebatterystaple" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().user.plan).toBe("FREE");
    expect(userStore.get(res.json().user.id)?.betaProGrantedAt ?? null).toBeNull();
    await app.close();
  });

  it("does not check waitlist when BETA_GATE_ENABLED is unset (preserves old behavior)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "open@example.com", password: "correcthorsebatterystaple" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().user.plan).toBe("FREE");
    await app.close();
  });
});

describe("POST /api/auth/register — a new account starts on FREE", () => {
  // Founder decision 2026-10-24: no signup is comped. Pro comes only from a
  // paid (or card-backed trial) subscription, or an admin setting the plan.
  // The retired BETA_AUTO_PRO_* flags must have no effect even if still set.
  beforeEach(resetStores);

  async function register(email: string) {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email, password: "correcthorsebatterystaple" },
    });
    await app.close();
    expect(res.statusCode).toBe(201);
    return { body: res.json(), stored: userStore.get(res.json().user.id) };
  }

  it("ignores BETA_AUTO_PRO_ENABLED=true while under its old cap", async () => {
    process.env.BETA_AUTO_PRO_ENABLED = "true";
    process.env.BETA_AUTO_PRO_LIMIT = "50";
    const { body, stored } = await register("first@example.com");
    expect(body.user.plan).toBe("FREE");
    expect(stored?.plan).toBe("FREE");
    expect(stored?.betaProGrantedAt ?? null).toBeNull();
  });

  it("ignores BETA_AUTO_PRO_ENABLED=true with the cap unset", async () => {
    process.env.BETA_AUTO_PRO_ENABLED = "true";
    const { body, stored } = await register("default@example.com");
    expect(body.user.plan).toBe("FREE");
    expect(stored?.betaProGrantedAt ?? null).toBeNull();
  });

  it("stays FREE with both the gate and auto-pro on and an APPROVED entry", async () => {
    process.env.BETA_GATE_ENABLED = "true";
    process.env.BETA_AUTO_PRO_ENABLED = "true";
    process.env.BETA_AUTO_PRO_LIMIT = "50";
    waitlistByEmail.set("approved@example.com", {
      email: "approved@example.com",
      status: "APPROVED",
    });
    const { body, stored } = await register("approved@example.com");
    expect(body.user.plan).toBe("FREE");
    expect(stored?.betaProGrantedAt ?? null).toBeNull();
  });

  it("does not count existing beta-PRO accounts to decide a new signup's plan", async () => {
    process.env.BETA_AUTO_PRO_ENABLED = "true";
    const { prisma } = await import("../db.js");
    const countSpy = vi.mocked(prisma.user.count);
    countSpy.mockClear();
    await register("plain@example.com");
    expect(countSpy).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/login", () => {
  beforeEach(resetStores);

  async function registerUser(app: ReturnType<typeof Fastify>, email: string, password: string) {
    return app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email, password },
    });
  }

  it("accepts the correct password and returns a valid token", async () => {
    const app = await buildApp();
    await registerUser(app, "bob@example.com", "correcthorsebattery");

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "bob@example.com", password: "correcthorsebattery" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.email).toBe("bob@example.com");
    expect(verifyToken(body.token).email).toBe("bob@example.com");
    await app.close();
  });

  it("records the device session's address from the trusted source, not a client-sent X-Forwarded-For", async () => {
    // trustProxy as in index.ts, so request.ip is the forgeable value it is in prod.
    const { authRoutes } = await import("../routes/auth.js");
    const app = Fastify({ trustProxy: true });
    await app.register(authRoutes, { prefix: "/api/auth" });
    await registerUser(app, "dave@example.com", "correcthorsebattery");
    const { prisma } = await import("../db.js");
    vi.mocked(prisma.device.create).mockClear();

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "dave@example.com", password: "correcthorsebattery" },
      headers: { "x-forwarded-for": "198.51.100.66" },
      remoteAddress: "192.0.2.20",
    });

    expect(res.statusCode).toBe(200);
    const created = vi.mocked(prisma.device.create).mock.calls.at(-1)?.[0] as {
      data: { ipAddress: string | null };
    };
    expect(created.data.ipAddress).toBe("192.0.2.20");
    await app.close();
  });

  it("rejects the wrong password with 401 and a generic message", async () => {
    const app = await buildApp();
    await registerUser(app, "carol@example.com", "correctpassword");

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "carol@example.com", password: "wrongpassword" },
    });
    expect(res.statusCode).toBe(401);
    // Message must not leak whether the account exists.
    expect(res.json().error).toBe("Invalid email or password");
    await app.close();
  });

  it("rejects an unknown email with the same generic 401", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "ghost@example.com", password: "doesntmatter" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Invalid email or password");
    await app.close();
  });

  it("rejects missing fields with 400", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "x@y.com" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("normalizes login email before lookup", async () => {
    const app = await buildApp();
    await registerUser(app, "login@example.com", "correcthorsebattery");

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "  LOGIN@example.com ", password: "correcthorsebattery" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe("login@example.com");
    await app.close();
  });
});

// ── Per-account lockout (distributed brute force across IPs) ─────
// The per-IP rate limit cannot see a botnet rotating source addresses
// against one account; this window is keyed on the normalized email.
describe("POST /api/auth/login — per-account lockout", () => {
  // The throttle is under test here, not bcrypt. Up to 32 real cost-12 compares
  // per test (bcryptjs is pure JS, ~250 ms each) took ~9 s idle and passed the
  // 60 s timeout at load average ~30. The stand-in still holds each request on
  // a timer, as the real compare holds it for its rounds: resolved at once, the
  // wave's requests ran one after another and a check-then-record gap after
  // the compare went unseen. Every account here registers with
  // REGISTERED_PASSWORD.
  const REGISTERED_PASSWORD = "correcthorsebattery";
  const COMPARE_HOLD_MS = 10;
  let compareSpy: MockInstance | undefined;

  beforeEach(async () => {
    resetStores();
    const { _resetLoginThrottleForTests } = await import("../security/login-throttle.js");
    _resetLoginThrottleForTests();
    const bcrypt = (await import("bcryptjs")).default;
    compareSpy = vi.spyOn(bcrypt, "compare").mockImplementation(async (password: string) => {
      await new Promise((resolve) => setTimeout(resolve, COMPARE_HOLD_MS));
      return password === REGISTERED_PASSWORD;
    });
  });

  afterEach(() => {
    compareSpy?.mockRestore();
  });

  async function failLogin(app: Awaited<ReturnType<typeof buildApp>>, email: string) {
    return app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password: "definitely-wrong" },
    });
  }

  it("locks the account after repeated failures, even with the correct password", async () => {
    const { LOGIN_THROTTLE_MAX_FAILURES } = await import("../security/login-throttle.js");
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "victim@example.com", password: REGISTERED_PASSWORD },
    });

    for (let i = 0; i < LOGIN_THROTTLE_MAX_FAILURES; i++) {
      const res = await failLogin(app, "victim@example.com");
      expect(res.statusCode).toBe(401);
    }

    const locked = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "victim@example.com", password: REGISTERED_PASSWORD },
    });
    expect(locked.statusCode).toBe(429);
    // Mirrors the per-IP limiter's shape — no account-existence oracle.
    expect(locked.json().error).toBe("Rate limit exceeded, retry in 15 minutes");
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
    await app.close();
  });

  it("logs a locked account as a keyed tag, never the address or its plain hash", async () => {
    const { LOGIN_THROTTLE_MAX_FAILURES } = await import("../security/login-throttle.js");
    const { addressLogTag } = await import("../security/address-log-tag.js");
    const { authRoutes } = await import("../routes/auth.js");
    const lines: string[] = [];
    const app = Fastify({
      logger: { level: "warn", stream: { write: (line: string) => lines.push(line) } },
    });
    await app.register(authRoutes, { prefix: "/api/auth" });
    const address = "tagged.account@example.com";

    for (let i = 0; i < LOGIN_THROTTLE_MAX_FAILURES; i++) {
      expect((await failLogin(app, address)).statusCode).toBe(401);
    }
    expect((await failLogin(app, address)).statusCode).toBe(429);
    await app.close();

    const tripped = lines.filter((line) => line.includes("per-account login throttle tripped"));
    expect(tripped).toHaveLength(1);
    expect(JSON.parse(tripped[0] as string).account).toBe(addressLogTag(address));
    const plainHash = crypto.createHash("sha256").update(address).digest("hex").slice(0, 12);
    for (const line of lines) {
      expect(line).not.toContain("tagged.account");
      expect(line).not.toContain(plainHash);
    }
  });

  it("counts unknown-email failures the same way (no existence oracle via lockout)", async () => {
    const { LOGIN_THROTTLE_MAX_FAILURES } = await import("../security/login-throttle.js");
    const app = await buildApp();

    for (let i = 0; i < LOGIN_THROTTLE_MAX_FAILURES; i++) {
      const res = await failLogin(app, "ghost@example.com");
      expect(res.statusCode).toBe(401);
    }
    const locked = await failLogin(app, "ghost@example.com");
    expect(locked.statusCode).toBe(429);
    await app.close();
  });

  it("does not lock other accounts", async () => {
    const { LOGIN_THROTTLE_MAX_FAILURES } = await import("../security/login-throttle.js");
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "bystander@example.com", password: REGISTERED_PASSWORD },
    });

    for (let i = 0; i < LOGIN_THROTTLE_MAX_FAILURES; i++) {
      await failLogin(app, "victim@example.com");
    }
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "bystander@example.com", password: REGISTERED_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("a successful login resets the failure count", async () => {
    const { LOGIN_THROTTLE_MAX_FAILURES } = await import("../security/login-throttle.js");
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "resetme@example.com", password: REGISTERED_PASSWORD },
    });

    for (let i = 0; i < LOGIN_THROTTLE_MAX_FAILURES - 1; i++) {
      await failLogin(app, "resetme@example.com");
    }
    const ok = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "resetme@example.com", password: REGISTERED_PASSWORD },
    });
    expect(ok.statusCode).toBe(200);

    // The window restarted: the next single failure must not lock.
    const failAgain = await failLogin(app, "resetme@example.com");
    expect(failAgain.statusCode).toBe(401);
    const okAgain = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "resetme@example.com", password: REGISTERED_PASSWORD },
    });
    expect(okAgain.statusCode).toBe(200);
    await app.close();
  });

  it("normalizes the email key — case variants hit the same window", async () => {
    const { LOGIN_THROTTLE_MAX_FAILURES } = await import("../security/login-throttle.js");
    const app = await buildApp();

    for (let i = 0; i < LOGIN_THROTTLE_MAX_FAILURES; i++) {
      await failLogin(app, i % 2 === 0 ? "Victim@Example.com" : "victim@example.com");
    }
    const locked = await failLogin(app, "VICTIM@example.com  ");
    expect(locked.statusCode).toBe(429);
    await app.close();
  });

  it("a concurrent wave cannot slip past the threshold (no TOCTOU window)", async () => {
    const { LOGIN_THROTTLE_MAX_FAILURES } = await import("../security/login-throttle.js");
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "victim@example.com", password: REGISTERED_PASSWORD },
    });

    const WAVE_OVERSHOOT = 20;
    const results = await Promise.all(
      Array.from({ length: LOGIN_THROTTLE_MAX_FAILURES + WAVE_OVERSHOOT }, () =>
        failLogin(app, "victim@example.com"),
      ),
    );
    const unauthorized = results.filter((r) => r.statusCode === 401).length;
    const throttled = results.filter((r) => r.statusCode === 429).length;
    // The attempt is recorded in the same synchronous section as the check,
    // so exactly MAX guesses reach verification — never more.
    expect(unauthorized).toBe(LOGIN_THROTTLE_MAX_FAILURES);
    expect(throttled).toBe(WAVE_OVERSHOOT);
    expect(compareSpy).toHaveBeenCalledTimes(LOGIN_THROTTLE_MAX_FAILURES);
    await app.close();
  });
});

// ── bcrypt cost migration-on-login ─────
describe("POST /api/auth/login — legacy hash upgrade", () => {
  beforeEach(async () => {
    resetStores();
    const { _resetLoginThrottleForTests } = await import("../security/login-throttle.js");
    _resetLoginThrottleForTests();
  });

  it("rehashes a legacy cost-10 hash to cost 12 on successful login (CAS-guarded)", async () => {
    const bcrypt = (await import("bcryptjs")).default;
    const legacyHash = await bcrypt.hash("correcthorsebattery", 10);
    userStore.set("user-1", {
      id: "user-1",
      email: "legacy@example.com",
      passwordHash: legacyHash,
      name: null,
      plan: "FREE",
      role: "USER",
    });
    userByEmail.set("legacy@example.com", "user-1");

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "legacy@example.com", password: "correcthorsebattery" },
    });
    expect(res.statusCode).toBe(200);

    // The rehash is fire-and-forget — wait for the guarded write to land.
    const { prisma } = await import("../db.js");
    await vi.waitFor(() => {
      expect(prisma.user.updateMany).toHaveBeenCalled();
    }, REHASH_WAIT);
    const call = vi.mocked(prisma.user.updateMany).mock.calls.at(-1)?.[0] as {
      where: { id: string; passwordHash: string };
      data: { passwordHash: string };
    };
    // CAS guard: only replace the exact hash we verified, so a concurrent
    // password change is never clobbered.
    expect(call.where).toEqual({ id: "user-1", passwordHash: legacyHash });
    expect(bcrypt.getRounds(call.data.passwordHash)).toBe(12);
    expect(await bcrypt.compare("correcthorsebattery", call.data.passwordHash)).toBe(true);
    await app.close();
  });

  it("does not rehash when the hash is already at the current cost", async () => {
    const { prisma } = await import("../db.js");
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "fresh@example.com", password: "correcthorsebattery" },
    });
    vi.mocked(prisma.user.updateMany).mockClear();

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "fresh@example.com", password: "correcthorsebattery" },
    });
    expect(res.statusCode).toBe(200);
    // Give any stray fire-and-forget a tick to surface, then assert none.
    await new Promise((r) => setTimeout(r, 50));
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("caps the background rehash at one per user under concurrent logins", async () => {
    const bcrypt = (await import("bcryptjs")).default;
    const { prisma } = await import("../db.js");
    const legacyHash = await bcrypt.hash("correcthorsebattery", 10);
    userStore.set("user-1", {
      id: "user-1",
      email: "legacy@example.com",
      passwordHash: legacyHash,
      name: null,
      plan: "FREE",
      role: "USER",
    });
    userByEmail.set("legacy@example.com", "user-1");
    vi.mocked(prisma.user.updateMany).mockClear();

    const app = await buildApp();
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { email: "legacy@example.com", password: "correcthorsebattery" },
        }),
      ),
    );
    for (const res of results) expect(res.statusCode).toBe(200);

    await vi.waitFor(() => {
      expect(prisma.user.updateMany).toHaveBeenCalled();
    }, REHASH_WAIT);
    // The in-flight guard admits exactly one background hash; the two other
    // logins must skip instead of stacking additional cost-12 work.
    await new Promise((r) => setTimeout(r, 100));
    expect(vi.mocked(prisma.user.updateMany).mock.calls.length).toBe(1);
    await app.close();
  });

  it("does not rehash on a failed login", async () => {
    const bcrypt = (await import("bcryptjs")).default;
    const { prisma } = await import("../db.js");
    const legacyHash = await bcrypt.hash("correcthorsebattery", 10);
    userStore.set("user-1", {
      id: "user-1",
      email: "legacy@example.com",
      passwordHash: legacyHash,
      name: null,
      plan: "FREE",
      role: "USER",
    });
    userByEmail.set("legacy@example.com", "user-1");
    vi.mocked(prisma.user.updateMany).mockClear();

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "legacy@example.com", password: "wrong" },
    });
    expect(res.statusCode).toBe(401);
    await new Promise((r) => setTimeout(r, 50));
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    await app.close();
  });
});

// ── Demo account lockout (public fixed-credential auth bypass) ─────
// The seeded demo-user (demo@klorn.ai / "demo") must not be a login target
// unless demo access is explicitly enabled in a non-prod environment.
describe("POST /api/auth/login — demo account lockout", () => {
  beforeEach(resetStores);

  async function seedDemoUser() {
    // Mirror ensureDemoUser's seeded row: fixed id/email + bcrypt("demo").
    const { hashPassword } = await import("../auth.js");
    userStore.set("demo-user", {
      id: "demo-user",
      email: "demo@klorn.ai",
      passwordHash: await hashPassword("demo"),
      name: "Demo User",
      plan: "FREE",
      role: "USER",
    });
    userByEmail.set("demo@klorn.ai", "demo-user");
  }

  it("rejects demo@klorn.ai/demo with a generic 401 when demo access is disabled", async () => {
    // ENABLE_DEMO_USER unset (resetStores) → disabled. This is the prod default
    // and the exact public-credential exploit that must be closed.
    await seedDemoUser();
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "demo@klorn.ai", password: "demo" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Invalid email or password");
    await app.close();
  });

  it("allows the demo login only when ENABLE_DEMO_USER=true in a non-prod env", async () => {
    // vitest runs with NODE_ENV=test (≠ production), so the opt-in flag is the
    // only remaining gate here.
    process.env.ENABLE_DEMO_USER = "true";
    await seedDemoUser();
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "demo@klorn.ai", password: "demo" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

// ── GET /api/auth/me ──────────────────────────────────────────────

describe("GET /api/auth/me", () => {
  beforeEach(resetStores);

  it("returns the authenticated user profile", async () => {
    const app = await buildApp();
    const token = await registerAndGetToken(app, "me@example.com");

    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.email).toBe("me@example.com");
    expect(body.user.id).toBe("user-1");
    expect(body.user).toHaveProperty("googleConnected");
    await app.close();
  });

  it("reports the user's stored timezone (AutomationConfig.timezone), not a constant", async () => {
    const app = await buildApp();
    const token = await registerAndGetToken(app, "tz@example.com");
    const me = async () =>
      (await app.inject({ method: "GET", url: "/api/auth/me", headers: authHeader(token) })).json()
        .user.timezone;

    // No config row yet: the product default.
    expect(await me()).toBe("Asia/Seoul");

    const stored = userStore.get("user-1");
    if (!stored) throw new Error("registered user missing");
    userStore.set("user-1", { ...stored, automationConfig: { timezone: "America/Los_Angeles" } });
    expect(await me()).toBe("America/Los_Angeles");

    // A garbage stored value never reaches the client's Intl calls.
    userStore.set("user-1", { ...stored, automationConfig: { timezone: "Not/AZone" } });
    expect(await me()).toBe("Asia/Seoul");
    await app.close();
  });

  it("reports UNIFIED_HOME as user.unifiedHome, false unless the flag is on", async () => {
    const app = await buildApp();
    const token = await registerAndGetToken(app, "home@example.com");
    const me = async () =>
      (await app.inject({ method: "GET", url: "/api/auth/me", headers: authHeader(token) })).json()
        .user.unifiedHome;

    delete process.env.UNIFIED_HOME;
    expect(await me()).toBe(false);
    process.env.UNIFIED_HOME = "true";
    try {
      expect(await me()).toBe(true);
    } finally {
      delete process.env.UNIFIED_HOME;
    }
    await app.close();
  });

  it("reports user.files only while the drive and one of its sources are on (FD-7)", async () => {
    const app = await buildApp();
    const token = await registerAndGetToken(app, "files@example.com");
    const me = async () =>
      (await app.inject({ method: "GET", url: "/api/auth/me", headers: authHeader(token) })).json()
        .user.files;
    const flags = ["DRIVE_ENABLED", "KLORN_DRIVE_ENABLED", "OBJECT_STORAGE_ENABLED"] as const;
    const clear = () => {
      for (const flag of flags) delete process.env[flag];
    };

    clear();
    try {
      expect(await me()).toBe(false);
      // The drive alone has no source to show: Files stays hidden.
      process.env.DRIVE_ENABLED = "true";
      expect(await me()).toBe(false);
      // A source's flag without the drive's: still hidden.
      delete process.env.DRIVE_ENABLED;
      process.env.KLORN_DRIVE_ENABLED = "true";
      process.env.OBJECT_STORAGE_ENABLED = "true";
      expect(await me()).toBe(false);
      process.env.DRIVE_ENABLED = "true";
      expect(await me()).toBe(true);
    } finally {
      clear();
    }
    await app.close();
  });

  it("reports TEAM_MODE_ENABLED as user.teamMode, false unless the flag is on", async () => {
    const app = await buildApp();
    const token = await registerAndGetToken(app, "team-mode@example.com");
    const me = async () =>
      (await app.inject({ method: "GET", url: "/api/auth/me", headers: authHeader(token) })).json()
        .user.teamMode;

    delete process.env.TEAM_MODE_ENABLED;
    expect(await me()).toBe(false);
    process.env.TEAM_MODE_ENABLED = "true";
    try {
      expect(await me()).toBe(true);
    } finally {
      delete process.env.TEAM_MODE_ENABLED;
    }
    await app.close();
  });

  it("reports SMART_ACTIONS_ENABLED as user.smartActions, cohort-aware, false unless open", async () => {
    const app = await buildApp();
    const token = await registerAndGetToken(app, "smart-actions@example.com");
    const me = async () =>
      (await app.inject({ method: "GET", url: "/api/auth/me", headers: authHeader(token) })).json()
        .user as { id: string; smartActions: boolean };

    delete process.env.SMART_ACTIONS_ENABLED;
    const { id, smartActions } = await me();
    expect(smartActions).toBe(false);
    try {
      process.env.SMART_ACTIONS_ENABLED = "cohort";
      process.env.ROLLOUT_COHORT_USER_IDS = "someone-else";
      expect((await me()).smartActions).toBe(false);
      process.env.ROLLOUT_COHORT_USER_IDS = `someone-else,${id}`;
      expect((await me()).smartActions).toBe(true);
      process.env.SMART_ACTIONS_ENABLED = "true";
      process.env.ROLLOUT_COHORT_USER_IDS = "";
      expect((await me()).smartActions).toBe(true);
    } finally {
      delete process.env.SMART_ACTIONS_ENABLED;
      delete process.env.ROLLOUT_COHORT_USER_IDS;
    }
    await app.close();
  });

  it("reports VAULT_EXPORT_ENABLED as user.vaultExport, cohort-aware, false unless open", async () => {
    const app = await buildApp();
    const token = await registerAndGetToken(app, "vault-export@example.com");
    const me = async () =>
      (await app.inject({ method: "GET", url: "/api/auth/me", headers: authHeader(token) })).json()
        .user as { id: string; vaultExport: boolean };

    delete process.env.VAULT_EXPORT_ENABLED;
    const { id, vaultExport } = await me();
    expect(vaultExport).toBe(false);
    try {
      process.env.VAULT_EXPORT_ENABLED = "cohort";
      process.env.ROLLOUT_COHORT_USER_IDS = "someone-else";
      expect((await me()).vaultExport).toBe(false);
      process.env.ROLLOUT_COHORT_USER_IDS = `someone-else,${id}`;
      expect((await me()).vaultExport).toBe(true);
      process.env.VAULT_EXPORT_ENABLED = "true";
      process.env.ROLLOUT_COHORT_USER_IDS = "";
      expect((await me()).vaultExport).toBe(true);
    } finally {
      delete process.env.VAULT_EXPORT_ENABLED;
      delete process.env.ROLLOUT_COHORT_USER_IDS;
    }
    await app.close();
  });

  it("reports RULES_DSL_ENABLED as user.rulesDsl, cohort-aware, false unless open", async () => {
    const app = await buildApp();
    const token = await registerAndGetToken(app, "rules-dsl@example.com");
    const me = async () =>
      (await app.inject({ method: "GET", url: "/api/auth/me", headers: authHeader(token) })).json()
        .user as { id: string; rulesDsl: boolean };

    delete process.env.RULES_DSL_ENABLED;
    const { id, rulesDsl } = await me();
    expect(rulesDsl).toBe(false);
    try {
      process.env.RULES_DSL_ENABLED = "cohort";
      process.env.ROLLOUT_COHORT_USER_IDS = "someone-else";
      expect((await me()).rulesDsl).toBe(false);
      process.env.ROLLOUT_COHORT_USER_IDS = `someone-else,${id}`;
      expect((await me()).rulesDsl).toBe(true);
      process.env.RULES_DSL_ENABLED = "true";
      process.env.ROLLOUT_COHORT_USER_IDS = "";
      expect((await me()).rulesDsl).toBe(true);
    } finally {
      delete process.env.RULES_DSL_ENABLED;
      delete process.env.ROLLOUT_COHORT_USER_IDS;
    }
    await app.close();
  });

  it("reports SLACK_ENABLED as user.slack, cohort-aware, false unless open", async () => {
    const app = await buildApp();
    const token = await registerAndGetToken(app, "slack-flag@example.com");
    const me = async () =>
      (await app.inject({ method: "GET", url: "/api/auth/me", headers: authHeader(token) })).json()
        .user as { id: string; slack: boolean };

    delete process.env.SLACK_ENABLED;
    const { id, slack } = await me();
    expect(slack).toBe(false);
    try {
      process.env.SLACK_ENABLED = "cohort";
      process.env.ROLLOUT_COHORT_USER_IDS = "someone-else";
      expect((await me()).slack).toBe(false);
      process.env.ROLLOUT_COHORT_USER_IDS = `someone-else,${id}`;
      expect((await me()).slack).toBe(true);
      process.env.SLACK_ENABLED = "true";
      process.env.ROLLOUT_COHORT_USER_IDS = "";
      expect((await me()).slack).toBe(true);
    } finally {
      delete process.env.SLACK_ENABLED;
      delete process.env.ROLLOUT_COHORT_USER_IDS;
    }
    await app.close();
  });

  it("reports KAKAO_IMPORT_ENABLED as user.kakaoImport, cohort-aware, false unless open", async () => {
    const app = await buildApp();
    const token = await registerAndGetToken(app, "kakao-flag@example.com");
    const me = async () =>
      (await app.inject({ method: "GET", url: "/api/auth/me", headers: authHeader(token) })).json()
        .user as { id: string; kakaoImport: boolean };

    delete process.env.KAKAO_IMPORT_ENABLED;
    const { id, kakaoImport } = await me();
    expect(kakaoImport).toBe(false);
    try {
      process.env.KAKAO_IMPORT_ENABLED = "cohort";
      process.env.ROLLOUT_COHORT_USER_IDS = "someone-else";
      expect((await me()).kakaoImport).toBe(false);
      process.env.ROLLOUT_COHORT_USER_IDS = `someone-else,${id}`;
      expect((await me()).kakaoImport).toBe(true);
      process.env.KAKAO_IMPORT_ENABLED = "true";
      process.env.ROLLOUT_COHORT_USER_IDS = "";
      expect((await me()).kakaoImport).toBe(true);
    } finally {
      delete process.env.KAKAO_IMPORT_ENABLED;
      delete process.env.ROLLOUT_COHORT_USER_IDS;
    }
    await app.close();
  });

  it("reports user.kakaoImportWayOut: closed to this user, but they own an import", async () => {
    const app = await buildApp();
    const token = await registerAndGetToken(app, "kakao-way-out@example.com");
    const me = async () =>
      (await app.inject({ method: "GET", url: "/api/auth/me", headers: authHeader(token) })).json()
        .user as { id: string; kakaoImport: boolean; kakaoImportWayOut: boolean };
    const { prisma } = await import("../db.js");
    const ownership = vi.mocked(prisma.kakaoImport.findFirst);

    delete process.env.KAKAO_IMPORT_ENABLED;
    const { id, kakaoImportWayOut } = await me();
    expect(kakaoImportWayOut).toBe(false);
    try {
      kakaoOwners.add(id);
      expect(await me()).toMatchObject({ kakaoImport: false, kakaoImportWayOut: true });
      expect(ownership).toHaveBeenLastCalledWith({ where: { userId: id }, select: { id: true } });
      // Open to the user: the whole panel, no way-out mode and no lookup.
      process.env.KAKAO_IMPORT_ENABLED = "true";
      ownership.mockClear();
      expect(await me()).toMatchObject({ kakaoImport: true, kakaoImportWayOut: false });
      expect(ownership).not.toHaveBeenCalled();
      // Closed again by a narrowed cohort: the way out again.
      process.env.KAKAO_IMPORT_ENABLED = "cohort";
      process.env.ROLLOUT_COHORT_USER_IDS = "someone-else";
      expect(await me()).toMatchObject({ kakaoImport: false, kakaoImportWayOut: true });
    } finally {
      kakaoOwners.delete(id);
      delete process.env.KAKAO_IMPORT_ENABLED;
      delete process.env.ROLLOUT_COHORT_USER_IDS;
    }
    await app.close();
  });

  it("a failed ownership lookup leaves /me answering, with no way out shown", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = await buildApp();
    const token = await registerAndGetToken(app, "kakao-way-out-db@example.com");
    const { prisma } = await import("../db.js");
    vi.mocked(prisma.kakaoImport.findFirst).mockRejectedValueOnce(new Error("pool timeout"));
    delete process.env.KAKAO_IMPORT_ENABLED;
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: authHeader(token),
    });
    // Not the 401 /me answers for anything that throws: the client would sign out.
    expect(res.statusCode).toBe(200);
    expect(res.json().user.kakaoImportWayOut).toBe(false);
    await app.close();
  });

  it("reports ONBOARDING_V2 as user.onboardingV2 on /me, login and register, false unless on", async () => {
    const app = await buildApp();
    const register = async (email: string) =>
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/register",
          payload: { email, password: "testpassword123" },
        })
      ).json();
    const login = async () =>
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { email: "first-run@example.com", password: "testpassword123" },
        })
      ).json();

    delete process.env.ONBOARDING_V2;
    const registered = await register("first-run@example.com");
    const me = async () =>
      (
        await app.inject({
          method: "GET",
          url: "/api/auth/me",
          headers: authHeader(registered.token),
        })
      ).json().user.onboardingV2;
    expect(registered.user.onboardingV2).toBe(false);
    expect((await login()).user.onboardingV2).toBe(false);
    expect(await me()).toBe(false);

    process.env.ONBOARDING_V2 = "true";
    try {
      expect((await register("first-run-2@example.com")).user.onboardingV2).toBe(true);
      expect((await login()).user.onboardingV2).toBe(true);
      expect(await me()).toBe(true);
    } finally {
      delete process.env.ONBOARDING_V2;
    }
    await app.close();
  });

  it("login carries user.unifiedHome so the first landing is the right home", async () => {
    const app = await buildApp();
    await registerAndGetToken(app, "landing@example.com");
    const login = async () =>
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { email: "landing@example.com", password: "testpassword123" },
        })
      ).json();

    delete process.env.UNIFIED_HOME;
    expect((await login()).user.unifiedHome).toBe(false);
    process.env.UNIFIED_HOME = "true";
    try {
      expect((await login()).user.unifiedHome).toBe(true);
    } finally {
      delete process.env.UNIFIED_HOME;
    }
    await app.close();
  });

  it("rejects requests without Authorization header", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects an invalid token", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: authHeader("invalid.jwt.token"),
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

// ── PATCH /api/auth/me ────────────────────────────────────────────

describe("PATCH /api/auth/me", () => {
  beforeEach(resetStores);

  it("updates the user name", async () => {
    const app = await buildApp();
    const token = await registerAndGetToken(app);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/auth/me",
      headers: authHeader(token),
      payload: { name: "New Name" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().user.name).toBe("New Name");
    await app.close();
  });

  it("rejects updating profile with empty name", async () => {
    const app = await buildApp();
    const token = await registerAndGetToken(app);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/auth/me",
      headers: authHeader(token),
      payload: { name: "   " },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

// ── POST /api/auth/change-password ────────────────────────────────

describe("POST /api/auth/change-password", () => {
  beforeEach(resetStores);

  it("changes password with correct current password", async () => {
    const app = await buildApp();
    const token = await registerAndGetToken(app, "cp@example.com", "oldpassword1");

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: authHeader(token),
      payload: { currentPassword: "oldpassword1", newPassword: "newpassword1" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);

    // Verify login works with new password
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "cp@example.com", password: "newpassword1" },
    });
    expect(login.statusCode).toBe(200);
    await app.close();
  });

  it("rejects wrong current password", async () => {
    const app = await buildApp();
    const token = await registerAndGetToken(app, "cp2@example.com", "correctpw1");

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: authHeader(token),
      payload: {
        currentPassword: "wrongpassword",
        newPassword: "newpassword1",
      },
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects missing fields", async () => {
    const app = await buildApp();
    const token = await registerAndGetToken(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: authHeader(token),
      payload: { currentPassword: "oldpw" },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects new password shorter than 8 characters", async () => {
    const app = await buildApp();
    const token = await registerAndGetToken(app, "short@example.com", "oldpassword1");

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: authHeader(token),
      payload: { currentPassword: "oldpassword1", newPassword: "short" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/8 characters/);
    await app.close();
  });
});

// ── POST /api/auth/set-password ───────────────────────────────────

describe("POST /api/auth/set-password", () => {
  beforeEach(resetStores);

  it("sets password for a user without one", async () => {
    // Simulate an OAuth user (no password) by inserting directly into the store
    const oauthUser: StoredUser = {
      id: "oauth-user",
      email: "oauth@example.com",
      passwordHash: null,
      name: "OAuth User",
      plan: "FREE",
      role: "USER",
    };
    userStore.set("oauth-user", oauthUser);
    userByEmail.set("oauth@example.com", "oauth-user");

    const app = await buildApp();
    const token = signToken({
      userId: "oauth-user",
      email: "oauth@example.com",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/set-password",
      headers: authHeader(token),
      payload: { newPassword: "mynewpassword" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(userStore.get("oauth-user")?.passwordHash).toBeTruthy();
    await app.close();
  });

  it("rejects if password is already set", async () => {
    const app = await buildApp();
    const token = await registerAndGetToken(app, "has-pw@example.com", "existingpw1");

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/set-password",
      headers: authHeader(token),
      payload: { newPassword: "anotherpw123" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/already set/i);
    await app.close();
  });

  it("rejects password shorter than 6 characters", async () => {
    userStore.set("oauth-2", {
      id: "oauth-2",
      email: "o2@example.com",
      passwordHash: null,
      name: "O2",
      plan: "FREE",
      role: "USER",
    });
    const app = await buildApp();
    const token = signToken({ userId: "oauth-2", email: "o2@example.com" });

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/set-password",
      headers: authHeader(token),
      payload: { newPassword: "short" },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

// ── GET /api/auth/has-password ────────────────────────────────────

describe("GET /api/auth/has-password", () => {
  beforeEach(resetStores);

  it("returns true for users with a password", async () => {
    const app = await buildApp();
    const token = await registerAndGetToken(app);

    const res = await app.inject({
      method: "GET",
      url: "/api/auth/has-password",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().hasPassword).toBe(true);
    await app.close();
  });

  it("returns false for OAuth-only users", async () => {
    userStore.set("no-pw", {
      id: "no-pw",
      email: "nopw@example.com",
      passwordHash: null,
      plan: "FREE",
      role: "USER",
    });
    const app = await buildApp();
    const token = signToken({ userId: "no-pw", email: "nopw@example.com" });

    const res = await app.inject({
      method: "GET",
      url: "/api/auth/has-password",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().hasPassword).toBe(false);
    await app.close();
  });
});

// ── POST /api/auth/forgot-password ────────────────────────────────

describe("POST /api/auth/forgot-password", () => {
  beforeEach(resetStores);

  it("sends reset email for existing user and always returns success", async () => {
    const app = await buildApp();
    await registerAndGetToken(app, "forgot@example.com");

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/forgot-password",
      payload: { email: "forgot@example.com" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(sendPasswordResetEmailSpy).toHaveBeenCalledWith(
      "forgot@example.com",
      expect.any(String),
    );

    // Verify resetToken was stored
    const user = userStore.get("user-1");
    expect(user?.resetToken).toBeTruthy();
    expect(user?.resetTokenExp).toBeInstanceOf(Date);
    await app.close();
  });

  it("stores only a SHA-256 hash of the reset token, never the raw token", async () => {
    // Same standard as Device.tokenHash: a DB read (backup leak, replica,
    // SQLi elsewhere) must never yield a directly usable reset link.
    const app = await buildApp();
    await registerAndGetToken(app, "hash@example.com");

    await app.inject({
      method: "POST",
      url: "/api/auth/forgot-password",
      payload: { email: "hash@example.com" },
    });

    const rawToken = sendPasswordResetEmailSpy.mock.calls[0]?.[1] as string;
    const stored = userStore.get("user-1")?.resetToken;
    expect(rawToken).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).toBe(crypto.createHash("sha256").update(rawToken).digest("hex"));
    expect(stored).not.toBe(rawToken);
    await app.close();
  });

  it("returns success even for non-existent email (prevents enumeration)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/forgot-password",
      payload: { email: "ghost@example.com" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(sendPasswordResetEmailSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects missing email", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/forgot-password",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("normalizes forgot-password email before sending", async () => {
    const app = await buildApp();
    await registerAndGetToken(app, "forgot2@example.com");
    sendPasswordResetEmailSpy.mockClear();

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/forgot-password",
      payload: { email: "  FORGOT2@example.com " },
    });

    expect(res.statusCode).toBe(200);
    expect(sendPasswordResetEmailSpy).toHaveBeenCalledWith(
      "forgot2@example.com",
      expect.any(String),
    );
    await app.close();
  });
});

// Fastify's default ajv runs with coerceTypes: "array", so `type: "string"`
// alone turned `{"email":123}` into "123" and let it through.
describe("auth email fields take an address string, never a coerced scalar", () => {
  beforeEach(resetStores);

  const CASES: ReadonlyArray<{ route: string; body: (email: unknown) => Record<string, unknown> }> =
    [
      { route: "/api/auth/register", body: (email) => ({ email, password: "testpassword123" }) },
      { route: "/api/auth/login", body: (email) => ({ email, password: "testpassword123" }) },
      { route: "/api/auth/forgot-password", body: (email) => ({ email }) },
    ];

  for (const { route, body } of CASES) {
    it.each([
      ["a number", 12345],
      ["a boolean", true],
      ["a string with no @", "not-an-address"],
      ["a string with two @", "a@b@example.com"],
      ["a string with inner whitespace", "a b@example.com"],
    ])(`${route} answers 400 for %s`, async (_label, email) => {
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: route, payload: body(email) });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/^body\/email /);
      expect(userStore.size).toBe(0);
      expect(sendPasswordResetEmailSpy).not.toHaveBeenCalled();
      await app.close();
    });
  }

  it("still takes an address with surrounding whitespace and capitals (the handler normalizes)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "  Mixed.Case+tag@Example.com ", password: "testpassword123" },
    });
    expect(res.statusCode).toBe(201);
    expect(userByEmail.has("mixed.case+tag@example.com")).toBe(true);
    await app.close();
  });
});

describe("POST /api/auth/forgot-password — per-address window and link reuse", () => {
  const T0 = new Date("2026-11-18T09:00:00.000Z").getTime();
  const MINUTE = 60 * 1000;
  // Past the reuse window, well inside the per-address window.
  const STEP = PASSWORD_RESET_REUSE_MS + MINUTE;

  beforeEach(() => {
    resetStores();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  const forgot = (app: ReturnType<typeof Fastify>, email: string) =>
    app.inject({ method: "POST", url: "/api/auth/forgot-password", payload: { email } });
  const reset = (app: ReturnType<typeof Fastify>, token: string, newPassword = "newpassword1") =>
    app.inject({
      method: "POST",
      url: "/api/auth/reset-password",
      payload: { token, newPassword },
    });
  const mailedToken = (index: number) => sendPasswordResetEmailSpy.mock.calls[index]?.[1] as string;
  const hashOf = (raw: string) => crypto.createHash("sha256").update(raw).digest("hex");

  it("mails at most PASSWORD_RESET_MAX_REQUESTS links per address per window, then answers the same 200 and mails nothing", async () => {
    const app = await buildApp();
    await registerAndGetToken(app, "victim@example.com");

    for (let i = 0; i < PASSWORD_RESET_MAX_REQUESTS; i++) {
      vi.setSystemTime(T0 + i * STEP);
      const res = await forgot(app, "victim@example.com");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    }
    expect(sendPasswordResetEmailSpy).toHaveBeenCalledTimes(PASSWORD_RESET_MAX_REQUESTS);
    const lastToken = mailedToken(PASSWORD_RESET_MAX_REQUESTS - 1);
    const storedBeforeLock = userStore.get("user-1")?.resetToken;
    expect(storedBeforeLock).toBe(hashOf(lastToken));

    // Locked: the same body as any request, no mail, and the stored link is
    // untouched — the newest mailed link still works.
    vi.setSystemTime(T0 + PASSWORD_RESET_MAX_REQUESTS * STEP);
    const locked = await forgot(app, "victim@example.com");
    expect(locked.statusCode).toBe(200);
    expect(locked.json()).toEqual({ success: true });
    expect(sendPasswordResetEmailSpy).toHaveBeenCalledTimes(PASSWORD_RESET_MAX_REQUESTS);
    expect(userStore.get("user-1")?.resetToken).toBe(storedBeforeLock);
    expect((await reset(app, lastToken)).statusCode).toBe(200);
    await app.close();
  });

  it("counts a differently written form of the address in the same window", async () => {
    const app = await buildApp();
    await registerAndGetToken(app, "case@example.com");
    for (let i = 0; i < PASSWORD_RESET_MAX_REQUESTS; i++) {
      vi.setSystemTime(T0 + i * STEP);
      await forgot(app, i % 2 === 0 ? "case@example.com" : "  CASE@Example.com ");
    }
    vi.setSystemTime(T0 + PASSWORD_RESET_MAX_REQUESTS * STEP);
    await forgot(app, "Case@example.com");
    expect(sendPasswordResetEmailSpy).toHaveBeenCalledTimes(PASSWORD_RESET_MAX_REQUESTS);
    await app.close();
  });

  it("mails again once the window has passed", async () => {
    const app = await buildApp();
    await registerAndGetToken(app, "later@example.com");
    for (let i = 0; i <= PASSWORD_RESET_MAX_REQUESTS; i++) {
      vi.setSystemTime(T0 + i * STEP);
      await forgot(app, "later@example.com");
    }
    expect(sendPasswordResetEmailSpy).toHaveBeenCalledTimes(PASSWORD_RESET_MAX_REQUESTS);

    vi.setSystemTime(T0 + PASSWORD_RESET_WINDOW_MS);
    await forgot(app, "later@example.com");
    expect(sendPasswordResetEmailSpy).toHaveBeenCalledTimes(PASSWORD_RESET_MAX_REQUESTS + 1);
    await app.close();
  });

  it("locks an address with no account the same way, before any account lookup", async () => {
    const app = await buildApp();
    const { prisma } = await import("../db.js");
    const lookups = () =>
      vi
        .mocked(prisma.user.findUnique)
        .mock.calls.filter(
          ([args]) =>
            (args as { where: { email?: string } }).where.email === "ghost-lock@example.com",
        ).length;
    for (let i = 0; i < PASSWORD_RESET_MAX_REQUESTS; i++) {
      const res = await forgot(app, "ghost-lock@example.com");
      expect(res.json()).toEqual({ success: true });
    }
    expect(lookups()).toBe(PASSWORD_RESET_MAX_REQUESTS);

    const locked = await forgot(app, "ghost-lock@example.com");
    expect(locked.statusCode).toBe(200);
    expect(locked.json()).toEqual({ success: true });
    expect(lookups()).toBe(PASSWORD_RESET_MAX_REQUESTS);
    expect(sendPasswordResetEmailSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("keeps a link mailed moments ago live instead of retiring it with a second mail", async () => {
    const app = await buildApp();
    await registerAndGetToken(app, "twice@example.com");

    await forgot(app, "twice@example.com");
    const first = mailedToken(0);
    vi.setSystemTime(T0 + PASSWORD_RESET_REUSE_MS - MINUTE);
    const again = await forgot(app, "twice@example.com");

    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ success: true });
    expect(sendPasswordResetEmailSpy).toHaveBeenCalledTimes(1);
    expect(userStore.get("user-1")?.resetToken).toBe(hashOf(first));
    expect((await reset(app, first)).statusCode).toBe(200);
    await app.close();
  });

  it("mails a fresh link and retires the old one once the reuse window has passed", async () => {
    const app = await buildApp();
    await registerAndGetToken(app, "rotate@example.com");

    await forgot(app, "rotate@example.com");
    const first = mailedToken(0);
    vi.setSystemTime(T0 + PASSWORD_RESET_REUSE_MS);
    await forgot(app, "rotate@example.com");
    const second = mailedToken(1);

    expect(sendPasswordResetEmailSpy).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
    expect((await reset(app, first)).statusCode).toBe(400);
    expect((await reset(app, second)).statusCode).toBe(200);
    await app.close();
  });

  it("does not replace or mail when another request replaced the link it read", async () => {
    const app = await buildApp();
    const { prisma } = await import("../db.js");
    await registerAndGetToken(app, "race@example.com");

    await forgot(app, "race@example.com");
    const first = mailedToken(0);
    vi.setSystemTime(T0 + STEP);
    // This request read the row before a concurrent one replaced the link.
    const stored = userStore.get("user-1");
    vi.mocked(prisma.user.findUnique).mockImplementationOnce((async () => ({
      ...stored,
      resetToken: "f".repeat(64),
    })) as never);
    const raced = await forgot(app, "race@example.com");

    expect(raced.json()).toEqual({ success: true });
    expect(sendPasswordResetEmailSpy).toHaveBeenCalledTimes(1);
    expect(userStore.get("user-1")?.resetToken).toBe(hashOf(first));
    await app.close();
  });

  it("does not mail when it read no link but a concurrent request has since stored one", async () => {
    const app = await buildApp();
    const { prisma } = await import("../db.js");
    await registerAndGetToken(app, "race-null@example.com");

    await forgot(app, "race-null@example.com");
    const first = mailedToken(0);
    vi.setSystemTime(T0 + STEP);
    const stored = userStore.get("user-1");
    vi.mocked(prisma.user.findUnique).mockImplementationOnce((async () => ({
      ...stored,
      resetToken: null,
      resetTokenExp: null,
    })) as never);
    await forgot(app, "race-null@example.com");

    expect(sendPasswordResetEmailSpy).toHaveBeenCalledTimes(1);
    expect(userStore.get("user-1")?.resetToken).toBe(hashOf(first));
    await app.close();
  });

  it("does not bring back the previous link when the new one was replaced or used meanwhile", async () => {
    const app = await buildApp();
    await registerAndGetToken(app, "replaced@example.com");

    await forgot(app, "replaced@example.com");
    vi.setSystemTime(T0 + STEP);
    // The send reports failure, but the new link was used before that answer.
    sendPasswordResetEmailSpy.mockImplementationOnce(async (...args: unknown[]) => {
      await reset(app, args[1] as string);
      return false;
    });
    await forgot(app, "replaced@example.com");

    expect(userStore.get("user-1")?.resetToken).toBeNull();
    expect(userStore.get("user-1")?.resetTokenExp).toBeNull();
    await app.close();
  });

  it("issues a new link at once after the previous one was used", async () => {
    const app = await buildApp();
    await registerAndGetToken(app, "used@example.com");

    await forgot(app, "used@example.com");
    expect((await reset(app, mailedToken(0))).statusCode).toBe(200);
    await forgot(app, "used@example.com");

    expect(sendPasswordResetEmailSpy).toHaveBeenCalledTimes(2);
    expect((await reset(app, mailedToken(1), "newpassword2")).statusCode).toBe(200);
    await app.close();
  });

  it("puts the previous link back when the new mail fails, and does not hold off a retry", async () => {
    const app = await buildApp();
    await registerAndGetToken(app, "flaky@example.com");

    await forgot(app, "flaky@example.com");
    const first = mailedToken(0);
    const firstExp = userStore.get("user-1")?.resetTokenExp;

    vi.setSystemTime(T0 + STEP);
    sendPasswordResetEmailSpy.mockResolvedValueOnce(false);
    const failed = await forgot(app, "flaky@example.com");
    expect(failed.json()).toEqual({ success: true });
    expect(userStore.get("user-1")?.resetToken).toBe(hashOf(first));
    expect(userStore.get("user-1")?.resetTokenExp).toEqual(firstExp);

    // The failed attempt did not count as a fresh link: a retry right away mails.
    await forgot(app, "flaky@example.com");
    expect(sendPasswordResetEmailSpy).toHaveBeenCalledTimes(3);
    expect((await reset(app, mailedToken(2))).statusCode).toBe(200);
    await app.close();
  });

  it("leaves no link behind when the first mail fails", async () => {
    const app = await buildApp();
    await registerAndGetToken(app, "nomail@example.com");

    sendPasswordResetEmailSpy.mockResolvedValueOnce(false);
    await forgot(app, "nomail@example.com");
    // The store's user never had a link (Prisma reads that column as null).
    expect(userStore.get("user-1")?.resetToken ?? null).toBeNull();
    expect(userStore.get("user-1")?.resetTokenExp ?? null).toBeNull();

    await forgot(app, "nomail@example.com");
    expect(sendPasswordResetEmailSpy).toHaveBeenCalledTimes(2);
    await app.close();
  });
});

// ── POST /api/auth/reset-password ─────────────────────────────────

describe("POST /api/auth/reset-password", () => {
  beforeEach(resetStores);

  it("resets password with valid token", async () => {
    const app = await buildApp();
    await registerAndGetToken(app, "reset@example.com", "oldpassword1");

    // Trigger forgot-password to set resetToken. Use the token from the
    // email (the raw secret) — the DB row only holds its SHA-256 hash.
    await app.inject({
      method: "POST",
      url: "/api/auth/forgot-password",
      payload: { email: "reset@example.com" },
    });
    const resetToken = sendPasswordResetEmailSpy.mock.calls[0]?.[1] as string;

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/reset-password",
      payload: { token: resetToken, newPassword: "newpassword1" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);

    // resetToken should be cleared
    expect(userStore.get("user-1")?.resetToken).toBeNull();

    // Session-revocation epoch must be stamped so every JWT issued before the
    // reset is rejected at the auth gate (closes the device-wipe bypass).
    expect(userStore.get("user-1")?.sessionsInvalidatedAt).toBeInstanceOf(Date);

    // Login with new password should work
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "reset@example.com", password: "newpassword1" },
    });
    expect(login.statusCode).toBe(200);
    await app.close();
  });

  it("rejects invalid reset token", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/reset-password",
      payload: { token: "bogus-token", newPassword: "newpassword1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/invalid or expired/i);
    await app.close();
  });

  it("rejects missing fields", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/reset-password",
      payload: { token: "abc" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects short new password", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/reset-password",
      payload: { token: "abc", newPassword: "short" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/8 characters/);
    await app.close();
  });

  it("rejects reset-password with invalid token type", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/reset-password",
      payload: { token: { bad: true }, newPassword: "newpassword1" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

// ── GET /api/auth/verify-email ────────────────────────────────────

describe("GET /api/auth/verify-email", () => {
  beforeEach(resetStores);

  it("verifies email with valid token and redirects", async () => {
    const app = await buildApp();
    await registerAndGetToken(app, "verify@example.com");

    // Use the token from the verification email (the raw secret) — the DB
    // row only holds its SHA-256 hash.
    const vToken = sendVerificationEmailSpy.mock.calls[0]?.[1] as string;

    const res = await app.inject({
      method: "GET",
      url: `/api/auth/verify-email?token=${vToken}`,
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("verified=true");

    // verifyToken should be cleared
    expect(userStore.get("user-1")?.verifyToken).toBeNull();
    expect(userStore.get("user-1")?.emailVerified).toBe(true);
    await app.close();
  });

  it("rejects missing token", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/verify-email",
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects invalid token", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/verify-email?token=bogus",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/invalid or expired/i);
    await app.close();
  });

  it("rate limits token probing per IP (1.3.4 symmetry with the other token routes)", async () => {
    // buildApp() skips the rate-limit plugin, so register it here the way
    // index.ts does — the route-level config only takes effect with the
    // plugin present.
    const rateLimit = (await import("@fastify/rate-limit")).default;
    const { authRoutes } = await import("../routes/auth.js");
    const app = Fastify();
    await app.register(rateLimit, { max: 1000, timeWindow: "1 minute", global: false });
    await app.register(authRoutes, { prefix: "/api/auth" });

    for (let i = 0; i < 30; i++) {
      const res = await app.inject({
        method: "GET",
        url: `/api/auth/verify-email?token=probe-${i}`,
      });
      expect(res.statusCode).toBe(400);
    }
    const overLimit = await app.inject({
      method: "GET",
      url: "/api/auth/verify-email?token=probe-31",
    });
    expect(overLimit.statusCode).toBe(429);
    await app.close();
  });
});

// ── POST /api/auth/resend-verification ────────────────────────────

describe("POST /api/auth/resend-verification", () => {
  beforeEach(resetStores);

  it("resends verification email for unverified user", async () => {
    const app = await buildApp();
    const token = await registerAndGetToken(app, "unver@example.com");
    sendVerificationEmailSpy.mockClear();

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/resend-verification",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(sendVerificationEmailSpy).toHaveBeenCalledWith("unver@example.com", expect.any(String));
    await app.close();
  });

  it("answers 502 and keeps the previous link when the mail did not go out", async () => {
    const app = await buildApp();
    const token = await registerAndGetToken(app, "unsent@example.com");
    const before = userStore.get("user-1")!;
    expect(before.verifyToken).toBeTruthy();
    sendVerificationEmailSpy.mockResolvedValueOnce(false);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/resend-verification",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      error: "The verification email could not be sent. Try again.",
    });
    const after = userStore.get("user-1")!;
    expect(after.verifyToken).toBe(before.verifyToken);
    expect(after.verifyTokenExp).toEqual(before.verifyTokenExp);
    await app.close();
  });

  it("returns alreadyVerified for verified users", async () => {
    const app = await buildApp();
    const token = await registerAndGetToken(app, "ver@example.com");
    // Mark as verified
    const user = userStore.get("user-1")!;
    userStore.set("user-1", { ...user, emailVerified: true });

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/resend-verification",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().alreadyVerified).toBe(true);
    await app.close();
  });
});

// ── POST /api/auth/logout ─────────────────────────────────────────

describe("POST /api/auth/logout", () => {
  beforeEach(resetStores);

  it("returns success with a valid token", async () => {
    const app = await buildApp();
    const token = await registerAndGetToken(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    await app.close();
  });

  it("returns success even without a token", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    await app.close();
  });
});

describe("DELETE /api/auth/account — self-service deletion", () => {
  beforeEach(() => {
    resetStores();
    vi.mocked(deleteUserAndAllData).mockClear();
  });

  it("requires authentication (401 without a token)", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: "/api/auth/account" });
    expect(res.statusCode).toBe(401);
    expect(deleteUserAndAllData).not.toHaveBeenCalled();
    await app.close();
  });

  it("deletes the authenticated user's data and returns 204", async () => {
    const app = await buildApp();
    const token = await registerAndGetToken(app);
    const res = await app.inject({
      method: "DELETE",
      url: "/api/auth/account",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(204);
    expect(deleteUserAndAllData).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
