/**
 * Desktop login, browser leg. The callback used to end the flow with a bare
 * 302 to `klorn://oauth-callback?code=…`. The browser hands the custom scheme
 * to the OS (so sign-in DID succeed) but never commits a document, so the tab
 * is left showing the last committed page — Google's account chooser — with a
 * spinner that never stops. Dogfood 2026-08-10: "로그인 누르면 무한로딩,
 * 탭을 직접 끄면 로그인이 되어 있다".
 *
 * The browser leg must therefore terminate in a real page: it fires the deep
 * link from a loaded document, offers a click fallback for browsers that only
 * honor an external-protocol launch on a user gesture, and tells the user the
 * tab can be closed. The nonce must ALSO stay pollable so a blocked handoff is
 * recoverable instead of fatal — while still never parking the JWT, which is
 * what keeps active login-CSRF structurally impossible.
 */

import crypto from "node:crypto";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

vi.mock("../mail/gmail.js", () => ({
  getAuthUrl: vi.fn(() => "https://example.com/oauth"),
  getLoginAuthUrl: vi.fn(() => "https://example.com/oauth-login"),
  getLinkInboxAuthUrl: vi.fn(() => "https://example.com/oauth-link-inbox"),
  getLinkCalendarAuthUrl: vi.fn(() => "https://example.com/oauth-link-calendar"),
  getAuthedClient: vi.fn(),
  getGoogleConnectionStatus: vi.fn(async () => ({ connected: false })),
  isGoogleAuthError: vi.fn(() => false),
  markGoogleTokenForReconnect: vi.fn(async () => {}),
  getGoogleUserInfo: vi.fn(async () => ({
    email: "desktop@example.com",
    verified_email: true,
    name: "Desktop User",
    picture: "",
  })),
  getOAuth2Client: vi.fn(() => ({
    getToken: vi.fn(async () => ({
      tokens: { access_token: "at", refresh_token: "rt", expiry_date: Date.now() + 3600_000 },
    })),
  })),
  registerGmailWatch: vi.fn(async () => ({})),
}));

vi.mock("../mail/email.js", () => ({
  sendVerificationEmail: vi.fn(async () => true),
  sendPasswordResetEmail: vi.fn(async () => true),
  sendBetaInviteEmail: vi.fn(async () => true),
}));

vi.mock("../mail/email-sync.js", () => ({
  syncLinkedInboxesForUser: vi.fn(async () => ({ newCount: 0 })),
  syncEmails: vi.fn(async () => ({ synced: 0, newCount: 0, source: "gmail" })),
  summarizeUnsummarizedEmails: vi.fn(async () => 0),
}));

vi.mock("../notify/welcome-email.js", () => ({
  maybeSendWelcomeEmail: vi.fn(async () => {}),
}));

vi.mock("../crypto-tokens.js", () => ({
  encryptToken: (t: string) => `enc:${t}`,
  encryptOptional: (t?: string | null) => (t ? `enc:${t}` : null),
}));

vi.mock("../db.js", () => {
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({
        id: "u-desktop",
        email: "desktop@example.com",
        name: "Desktop User",
        emailVerified: true,
        passwordHash: null,
        plan: "PRO",
        role: "USER",
      })),
      update: vi.fn(async () => ({})),
      count: vi.fn(async () => 1),
    },
    userToken: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({})) },
    automationConfig: { upsert: vi.fn(async () => ({})) },
    device: {
      create: vi.fn(async () => ({ id: "d1" })),
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    waitlist: { findUnique: vi.fn(async () => null) },
  };
  return { prisma, db: prisma };
});

import { pairingCode } from "../auth/desktop-confirm.js";
import { authRoutes } from "../routes/auth.js";

const VERIFIER = "desktop-handoff-verifier";
const CHALLENGE = crypto.createHash("sha256").update(VERIFIER).digest("base64url");

async function buildApp() {
  const app = Fastify();
  await app.register(authRoutes, { prefix: "/api/auth" });
  return app;
}

async function mintNonce(app: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  const res = await app.inject({
    method: "GET",
    url: `/api/auth/desktop-nonce?challenge=${encodeURIComponent(CHALLENGE)}`,
  });
  return res.json().nonce as string;
}

/** Drive the callback exactly as Google does after the user picks an account. */
async function completeOAuth(app: Awaited<ReturnType<typeof buildApp>>, nonce: string) {
  const state = signToken({
    userId: nonce,
    email: "__google_login_desktop__",
    appScheme: "klorn",
  });
  return app.inject({
    method: "GET",
    url: `/api/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`,
  });
}

function pollToken(app: Awaited<ReturnType<typeof buildApp>>, nonce: string) {
  return app.inject({
    method: "GET",
    url: `/api/auth/desktop-token/${nonce}`,
    headers: { "x-desktop-verifier": VERIFIER },
  });
}

describe("desktop login — browser handoff page", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    app = await buildApp();
  });

  it("renders a page instead of a bare custom-scheme redirect, so the tab never hangs", async () => {
    const nonce = await mintNonce(app);
    const res = await completeOAuth(app, nonce);

    // A 302 whose Location is `klorn://…` commits no document: the tab keeps
    // showing Google's account chooser and spins forever. That is the bug.
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers.location).toBeUndefined();
  });

  it("fires the deep link from the loaded document AND offers a click fallback", async () => {
    const nonce = await mintNonce(app);
    const body = (await completeOAuth(app, nonce)).body;

    const link = body.match(/klorn:\/\/oauth-callback\?code=[a-f0-9]{40}/)?.[0];
    expect(link).toBeTruthy();
    const escaped = link?.replace(/\?/g, "\\?") ?? "";
    // Automatic handoff…
    expect(body).toMatch(new RegExp(`<meta http-equiv="refresh" content="0;url=${escaped}"`));
    // …plus a real anchor, because Chrome/Safari only honor an external
    // protocol launch on a user gesture when the automatic one is blocked.
    expect(body).toMatch(new RegExp(`<a[^>]+href="${escaped}"`));
  });

  it("carries no script — every HTML response is served under script-src 'none'", async () => {
    const nonce = await mintNonce(app);
    const body = (await completeOAuth(app, nonce)).body;

    // index.ts's onSend hook pins HTML to `default-src 'none'; style-src
    // 'unsafe-inline'`. An inline <script> here would silently never run in
    // production, so the handoff must not depend on one.
    expect(body).not.toContain("<script");
  });

  it("never caches the page — it carries a live one-time exchange code", async () => {
    const nonce = await mintNonce(app);
    const res = await completeOAuth(app, nonce);
    expect(res.headers["cache-control"]).toContain("no-store");
  });

  it("hands out a code the app can exchange for the JWT", async () => {
    const nonce = await mintNonce(app);
    const body = (await completeOAuth(app, nonce)).body;
    const code = body.match(/klorn:\/\/oauth-callback\?code=([a-f0-9]{40})/)?.[1];

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/exchange-code",
      payload: { code },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBeTruthy();
  });

  it("keeps the nonce pollable so a blocked handoff stays recoverable", async () => {
    const nonce = await mintNonce(app);
    await completeOAuth(app, nonce);

    // Was 404 "nonce not recognized": deleting the entry killed the very
    // fallback that exists for a browser which refuses the scheme launch, and
    // turned a recoverable state into a hard sign-in failure.
    const res = await pollToken(app, nonce);
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("pending");
  });

  it("still never parks the JWT for polling — the token only reaches the app via the relay", async () => {
    const nonce = await mintNonce(app);
    await completeOAuth(app, nonce);

    // The anti-login-CSRF property: an attacker who minted the nonce (and so
    // holds the verifier) must not be able to poll out the victim's session.
    const res = await pollToken(app, nonce);
    expect(res.json().token).toBeUndefined();
    expect(res.json().status).not.toBe("ok");
  });
});

describe("desktop login — the poll flow asks the browser first", () => {
  // No app scheme: the session would be parked for the poller. Whoever minted
  // the nonce holds its verifier, so a victim lured into the login link must
  // confirm in the browser, against the pairing code, before anything parks.
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    app = await buildApp();
  });

  function completePollOAuth(nonce: string) {
    const state = signToken({ userId: nonce, email: "__google_login_desktop__" });
    return app.inject({
      method: "GET",
      url: `/api/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`,
    });
  }

  function confirmIdOf(html: string): string {
    return /name="confirm" value="([a-f0-9]{40})"/.exec(html)?.[1] ?? "";
  }

  function confirm(id: string) {
    return app.inject({
      method: "POST",
      url: "/api/auth/desktop-confirm",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `confirm=${encodeURIComponent(id)}`,
    });
  }

  it("shows the pairing code and parks nothing until the browser confirms", async () => {
    const nonce = await mintNonce(app);
    const res = await completePollOAuth(nonce);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(pairingCode(nonce));
    expect(res.body).toContain('action="/api/auth/desktop-confirm"');
    expect(res.headers["cache-control"]).toBe("no-store");

    const polled = await pollToken(app, nonce);
    expect(polled.json().token).toBeUndefined();
  });

  it("hands the session to the app's poller once the browser confirms", async () => {
    const nonce = await mintNonce(app);
    const id = confirmIdOf((await completePollOAuth(nonce)).body);
    const confirmed = await confirm(id);
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.body).toContain("Return to the Klorn desktop app.");

    const polled = await pollToken(app, nonce);
    expect(typeof polled.json().token).toBe("string");
  });

  it("confirms once: a second submit, or an unknown id, gets the expired page", async () => {
    const nonce = await mintNonce(app);
    const id = confirmIdOf((await completePollOAuth(nonce)).body);
    expect((await confirm(id)).statusCode).toBe(200);
    expect((await confirm(id)).statusCode).toBe(400);
    expect((await confirm("f".repeat(40))).statusCode).toBe(400);
  });
});
