import crypto from "node:crypto";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken, verifyToken } from "../auth.js";
import { getLoginAuthUrl, getOAuth2Client } from "../gmail.js";
import { isAllowedNativeScheme } from "../routes/auth.js";

// Stub email sender — auth register fires it non-blocking and swallows errors,
// but we want to assert it was called with the right token.
const sendVerificationEmailSpy = vi.fn(async () => true);
const sendPasswordResetEmailSpy = vi.fn(async () => true);
const sendBetaInviteEmailSpy = vi.fn(async () => true);
vi.mock("../email.js", () => ({
  sendVerificationEmail: (...args: unknown[]) => sendVerificationEmailSpy(...args),
  sendPasswordResetEmail: (...args: unknown[]) => sendPasswordResetEmailSpy(...args),
  sendBetaInviteEmail: (...args: unknown[]) => sendBetaInviteEmailSpy(...args),
}));

// Stub email-sync so init-sync's linked-inbox fan-out is a no-op in tests
// (and its transitive gmail.js imports don't need mocking here).
vi.mock("../email-sync.js", () => ({
  syncLinkedInboxesForUser: vi.fn(async () => ({ newCount: 0 })),
  syncEmails: vi.fn(async () => ({ synced: 0, newCount: 0, source: "gmail" })),
  summarizeUnsummarizedEmails: vi.fn(async () => 0),
}));

// Stub gmail OAuth helpers so we don't hit googleapis in tests.
vi.mock("../gmail.js", () => ({
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
};
const userStore = new Map<string, StoredUser>();
const userByEmail = new Map<string, string>();
let nextUserId = 1;

type StoredWaitlist = { email: string; status: string };
const waitlistByEmail = new Map<string, StoredWaitlist>();

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
            resetToken?: string;
            verifyToken?: string;
            resetTokenExp?: { gte: Date };
            verifyTokenExp?: { gte: Date };
          };
          data: Record<string, unknown>;
        }) => {
          let count = 0;
          for (const [id, user] of userStore.entries()) {
            if (where.id && id !== where.id) continue;
            if (where.resetToken && user.resetToken !== where.resetToken) continue;
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
      count: vi.fn(async ({ where }: { where?: { betaProGrantedAt?: { not: null } } } = {}) => {
        if (where?.betaProGrantedAt?.not === null) {
          let n = 0;
          for (const u of userStore.values()) if (u.betaProGrantedAt) n += 1;
          return n;
        }
        return userStore.size;
      }),
    },
    userToken: { findFirst: vi.fn(async () => null) },
    automationConfig: { create: vi.fn(async () => ({})), upsert: vi.fn(async () => ({})) },
    device: {
      create: vi.fn(async () => ({ id: "device-1" })),
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => ({ id: "device-1" })),
      // requireAuth → isDeviceSessionValid() looks the token's device up by
      // tokenHash. Return a valid device so authed routes (now gated by
      // requireAuth, not bare getUserId) see an active session in tests.
      findUnique: vi.fn(async () => ({ id: "device-1" })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      update: vi.fn(async () => ({})),
      count: vi.fn(async () => 1),
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
    const state = signToken({ userId: "n1", email: "__google_login__" });
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

  it("stays backward-compatible: a nonce with no challenge needs no verifier (202)", async () => {
    const app = await buildApp();
    const nonce = await getNonce(app, false);
    const res = await app.inject({ method: "GET", url: `/api/auth/desktop-token/${nonce}` });
    expect(res.statusCode).toBe(202);
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
    const res = await app.inject({ method: "GET", url: "/api/auth/desktop-nonce" });
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

  it("creates a PRO account when BETA_GATE_ENABLED and waitlist entry is APPROVED", async () => {
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
    expect(res.json().user.plan).toBe("PRO");
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

describe("POST /api/auth/register — beta auto pro", () => {
  beforeEach(resetStores);

  it("grants PRO and stamps betaProGrantedAt for the first signup under the cap", async () => {
    process.env.BETA_AUTO_PRO_ENABLED = "true";
    process.env.BETA_AUTO_PRO_LIMIT = "2";
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "first@example.com", password: "correcthorsebatterystaple" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().user.plan).toBe("PRO");
    const stored = userStore.get(res.json().user.id);
    expect(stored?.betaProGrantedAt).toBeInstanceOf(Date);
    await app.close();
  });

  it("silently falls back to FREE once the cap is reached", async () => {
    process.env.BETA_AUTO_PRO_ENABLED = "true";
    process.env.BETA_AUTO_PRO_LIMIT = "1";
    const app = await buildApp();
    const a = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "early@example.com", password: "correcthorsebatterystaple" },
    });
    expect(a.statusCode).toBe(201);
    expect(a.json().user.plan).toBe("PRO");

    const b = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "late@example.com", password: "correcthorsebatterystaple" },
    });
    expect(b.statusCode).toBe(201);
    expect(b.json().user.plan).toBe("FREE");
    const lateUser = userStore.get(b.json().user.id);
    expect(lateUser?.betaProGrantedAt ?? null).toBeNull();
    await app.close();
  });

  it("defaults the cap to 50 when BETA_AUTO_PRO_LIMIT is unset", async () => {
    process.env.BETA_AUTO_PRO_ENABLED = "true";
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "default@example.com", password: "correcthorsebatterystaple" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().user.plan).toBe("PRO");
    await app.close();
  });

  it("does not grant when BETA_AUTO_PRO_ENABLED is unset (regression check)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "plain@example.com", password: "correcthorsebatterystaple" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().user.plan).toBe("FREE");
    const stored = userStore.get(res.json().user.id);
    expect(stored?.betaProGrantedAt ?? null).toBeNull();
    await app.close();
  });

  it("does not consume the auto-pro cap when BETA_GATE_ENABLED takes priority", async () => {
    // Both flags on: gate path should win, auto-pro path must not even count.
    process.env.BETA_GATE_ENABLED = "true";
    process.env.BETA_AUTO_PRO_ENABLED = "true";
    process.env.BETA_AUTO_PRO_LIMIT = "1";
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
    expect(res.json().user.plan).toBe("PRO");
    // Gate-path PRO should NOT stamp betaProGrantedAt — that column is the
    // auto-pro cap counter.
    const stored = userStore.get(res.json().user.id);
    expect(stored?.betaProGrantedAt ?? null).toBeNull();
    await app.close();
  });

  it("treats BETA_AUTO_PRO_LIMIT=0 as effectively disabled", async () => {
    process.env.BETA_AUTO_PRO_ENABLED = "true";
    process.env.BETA_AUTO_PRO_LIMIT = "0";
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "zero@example.com", password: "correcthorsebatterystaple" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().user.plan).toBe("FREE");
    await app.close();
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
