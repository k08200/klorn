import formbody from "@fastify/formbody";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { buildAppleAuthUrl, exchangeAppleCode, verifyAppleIdToken } from "../auth/apple.js";
import {
  beginDesktopConfirmation,
  desktopConfirmExpiredPage,
  desktopConfirmPage,
  pairingCode,
} from "../auth/desktop-confirm.js";
import { isLoginBinding, mintExchangeCode } from "../auth/exchange-codes.js";
import {
  buildNaverAuthUrl,
  exchangeNaverCode,
  fetchNaverProfile,
  isNaverVerifiedEmail,
} from "../auth/naver.js";
import type { SocialIdentity, SocialProviderId } from "../auth/social-identity.js";
import { completeSocialLogin } from "../auth/social-login.js";
import { signToken, verifyToken } from "../auth.js";
import { appleLoginEnabled, naverLoginEnabled } from "../config.js";
import { desktopHandoffPage, desktopLoginTokens, isAllowedNativeScheme } from "./auth.js";

export interface SocialAuthProvider {
  id: SocialProviderId;
  gate: () => boolean;
  buildAuthUrl: (state: string) => string;
  /** Apple mandates response_mode=form_post for scoped requests → POST callback. */
  callbackMethod: "GET" | "POST";
  resolveIdentity: (params: { code: string; state: string }) => Promise<SocialResolution>;
}

/**
 * The outcome of turning a provider's callback into an identity. A failure
 * names its stage so the redirect can say WHERE it broke — one `_failed` for
 * a misconfigured deployment, a refused client secret, a bad token and a
 * missing email meant only server logs could tell them apart.
 */
export type SocialResolution =
  | { ok: true; identity: SocialIdentity }
  | { ok: false; reason: string };

export const appleAuthProvider: SocialAuthProvider = {
  id: "apple",
  gate: appleLoginEnabled,
  buildAuthUrl: buildAppleAuthUrl,
  callbackMethod: "POST",
  resolveIdentity: async ({ code }) => {
    const exchanged = await exchangeAppleCode(code);
    if (!exchanged.ok) return { ok: false, reason: exchanged.reason };
    const verified = await verifyAppleIdToken(exchanged.idToken);
    if (!verified.ok) return { ok: false, reason: verified.reason };
    return {
      ok: true,
      identity: {
        provider: "apple",
        subject: verified.claims.sub,
        email: verified.claims.email,
        emailVerified: verified.claims.emailVerified,
      },
    };
  },
};

export const naverAuthProvider: SocialAuthProvider = {
  id: "naver",
  gate: naverLoginEnabled,
  buildAuthUrl: buildNaverAuthUrl,
  callbackMethod: "GET",
  resolveIdentity: async ({ code, state }) => {
    const accessToken = await exchangeNaverCode(code, state);
    if (!accessToken) return { ok: false, reason: "exchange" };
    const profile = await fetchNaverProfile(accessToken);
    if (!profile) return { ok: false, reason: "claims" };
    return {
      ok: true,
      identity: {
        provider: "naver",
        subject: profile.id,
        email: profile.email,
        emailVerified: isNaverVerifiedEmail(profile.email),
        name: profile.name,
      },
    };
  },
};

/**
 * Login + callback for one social provider, mounted per provider in index.ts
 * (/api/auth/apple, /api/auth/naver). The provider's OFF-by-default flag
 * cloaks every route as Fastify's default 404 while dark — same doctrine and
 * byte-for-byte body as routes/imap-connect.ts, so a scanner cannot tell a
 * dark provider from a route that doesn't exist.
 */
// Only the GET (Naver) callback reads request.query — the POST (Apple)
// callback reads request.body instead (see handleCallback below), so this
// schema is attached to the GET registration only.
// OAuth authorization codes routinely exceed 500 chars (Azure AD ~800), so the
// callback params get 2048 instead of the blanket 500 used elsewhere.
const socialCallbackQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    code: { type: "string", maxLength: 2048 },
    state: { type: "string", maxLength: 2048 },
    error: { type: "string", maxLength: 2048 },
  },
} as const;

export function socialAuthRoutes(
  provider: SocialAuthProvider,
): (app: FastifyInstance) => Promise<void> {
  return async function routes(app: FastifyInstance) {
    app.addHook("onRequest", async (request, reply) => {
      if (!provider.gate()) {
        const { url, method } = request.raw;
        reply.code(404);
        return reply.send({
          message: `Route ${method}:${url} not found`,
          error: "Not Found",
          statusCode: 404,
        });
      }
    });
    if (provider.callbackMethod === "POST") {
      // Apple posts the callback as application/x-www-form-urlencoded.
      // Registered inside this encapsulated plugin so the parser exists only
      // for this provider's scope, not app-wide.
      await app.register(formbody);
    }

    // GET /login — mint the short-lived signed state and bounce to consent.
    // Same state shape as the Google flow: marker in the email field, 10 min.
    // Desktop (2026-08-19): ?source=desktop&nonce=…&appScheme=… mirrors the
    // Google desktop leg — the nonce (minted by /desktop-nonce, PKCE-bound)
    // rides in the userId slot and the callback relays/parks the JWT.
    app.get(
      "/login",
      {
        schema: {
          querystring: {
            type: "object",
            additionalProperties: false,
            properties: {
              source: { type: "string", maxLength: 20 },
              nonce: { type: "string", maxLength: 128 },
              appScheme: { type: "string", maxLength: 64 },
              // Web sign-in only: the browser's login binding (auth/exchange-codes.ts).
              lb: { type: "string", maxLength: 64 },
            },
          },
        },
        config: { rateLimit: { max: 20, timeWindow: "15 minutes" } },
      },
      async (request, reply) => {
        const { source, nonce, appScheme, lb } = request.query as {
          source?: string;
          nonce?: string;
          appScheme?: string;
          lb?: string;
        };
        const isDesktop = source === "desktop" && !!nonce;
        // Same rule as the Google flow: a web sign-in names its browser.
        if (!isDesktop && !isLoginBinding(lb)) {
          const webUrl = process.env.WEB_URL || "http://localhost:8001";
          return reply.redirect(`${webUrl}/login?error=session_expired`);
        }
        if (isDesktop) {
          const entry = desktopLoginTokens.get(nonce as string);
          if (!entry || entry.jwt !== undefined || entry.relayed || entry.expiresAt < Date.now()) {
            return reply
              .code(400)
              .send({ error: "Invalid or expired nonce. Call /api/auth/desktop-nonce first." });
          }
        }
        const state = signToken(
          {
            userId: isDesktop ? (nonce as string) : "__login__",
            email: isDesktop ? `__${provider.id}_login_desktop__` : `__${provider.id}_login__`,
            ...(isDesktop && isAllowedNativeScheme(appScheme) ? { appScheme } : {}),
            ...(!isDesktop ? { lb } : {}),
          },
          "10m",
        );
        return reply.redirect(provider.buildAuthUrl(state));
      },
    );

    const handleCallback = async (request: FastifyRequest, reply: FastifyReply) => {
      const webUrl = process.env.WEB_URL || "http://localhost:8001";
      const params = (provider.callbackMethod === "POST" ? request.body : request.query) as {
        code?: string;
        state?: string;
        error?: string;
      } | null;
      // Consent denied / provider error / missing code: land on the login page
      // with a friendly toast, never a raw JSON error (Google-flow precedent).
      if (!params?.code || !params.state || params.error) {
        return reply.redirect(`${webUrl}/login?error=${provider.id}_denied`);
      }
      let statePayload: { userId: string; email: string; appScheme?: string; lb?: string };
      try {
        statePayload = verifyToken(params.state);
      } catch {
        return reply.redirect(`${webUrl}/login?error=${provider.id}_failed`);
      }
      // Both halves of the state must match: the provider marker AND the
      // placeholder userId. Checking the marker alone would let any signed
      // JWT whose email happens to equal the marker (registration does not
      // enforce email format) stand in as a state (security review
      // 2026-08-06); the Google branch predates this check and keeps its own
      // shape untouched. The DESKTOP marker carries the /desktop-nonce value
      // in the userId slot instead — validated against the live nonce map,
      // so a forged userId still cannot park a token anywhere an attacker
      // can read (the poller is PKCE-bound and the relay targets the device
      // that completed OAuth).
      const isDesktopLogin = statePayload.email === `__${provider.id}_login_desktop__`;
      if (isDesktopLogin) {
        const entry = desktopLoginTokens.get(statePayload.userId);
        // jwt/relayed check: defense-in-depth against callback replay beyond
        // the provider's own single-use authorization code.
        if (!entry || entry.expiresAt < Date.now() || entry.jwt !== undefined || entry.relayed) {
          return reply.redirect(`${webUrl}/login?error=${provider.id}_failed`);
        }
      } else if (
        statePayload.email !== `__${provider.id}_login__` ||
        statePayload.userId !== "__login__"
      ) {
        return reply.redirect(`${webUrl}/login?error=${provider.id}_failed`);
      } else if (!isLoginBinding(statePayload.lb)) {
        // A web sign-in without a login binding (login CSRF), refused before
        // the provider's code is spent or any account touched.
        return reply.redirect(`${webUrl}/login?error=session_expired`);
      }

      const ip =
        (request.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || request.ip;
      const userAgent = (request.headers["user-agent"] as string) || "";
      // One net for the whole tail — resolveIdentity (Apple's client-secret
      // signing throws if the key env is broken) AND the DB writes inside
      // completeSocialLogin (withDbRetry re-throws once its budget is spent).
      // A browser navigation must land back on /login with a retryable toast,
      // never Fastify's raw JSON 500 — same degradation as the Google callback.
      try {
        const resolved = await provider.resolveIdentity({
          code: params.code,
          state: params.state,
        });
        if (!resolved.ok) {
          // The stage rides in the URL so a failure is diagnosable without
          // server-log access — `apple_config` is an operator's problem,
          // `apple_claims` is the visitor's, and they used to look identical.
          return reply.redirect(`${webUrl}/login?error=${provider.id}_${resolved.reason}`);
        }
        const identity = resolved.identity;
        const { redirect, token } = await completeSocialLogin(identity, {
          ip,
          userAgent,
          ...(isDesktopLogin ? {} : { binding: statePayload.lb }),
        });
        if (isDesktopLogin) {
          if (!token) {
            // completeSocialLogin only omits the token on its error redirects;
            // a desktop leg cannot proceed without one.
            return reply.redirect(`${webUrl}/login?error=${provider.id}_failed`);
          }
          const nonce = statePayload.userId;
          // Mirror of the Google desktop branch (routes/auth.ts): relay via a
          // one-time exchange code deep-linked to the allowlisted scheme,
          // keeping the nonce un-parked (relayed=true burns it for reuse);
          // no scheme -> park for the PKCE-bound poller.
          if (isAllowedNativeScheme(statePayload.appScheme)) {
            const relayCode = mintExchangeCode(token);
            const entry = desktopLoginTokens.get(nonce);
            if (entry) desktopLoginTokens.set(nonce, { ...entry, relayed: true });
            reply.header("Cache-Control", "no-store");
            reply.type("text/html");
            return reply.send(
              desktopHandoffPage(`${statePayload.appScheme}://oauth-callback?code=${relayCode}`),
            );
          }
          // Same confirmation step as the Google poll path
          // (auth/desktop-confirm.ts): parked only once this browser confirms.
          // A nonce that expired or was used meanwhile gets the expired page now,
          // not after the person clicks confirm.
          const live = desktopLoginTokens.get(nonce);
          if (!live || live.expiresAt < Date.now() || live.jwt !== undefined || live.relayed) {
            reply.header("Cache-Control", "no-store");
            reply.type("text/html");
            return reply.code(400).send(desktopConfirmExpiredPage());
          }
          const confirmId = beginDesktopConfirmation(nonce, token);
          reply.header("Cache-Control", "no-store");
          reply.type("text/html");
          return reply.send(desktopConfirmPage(confirmId, pairingCode(nonce)));
        }
        return reply.redirect(redirect);
      } catch (err) {
        console.error(`[SOCIAL] ${provider.id} login completion failed:`, err);
        return reply.redirect(`${webUrl}/login?error=${provider.id}_failed`);
      }
    };

    // Same ceiling as /login: every callback costs a provider token-exchange
    // round trip, so it must not ride the looser app-wide default limiter.
    const callbackOpts = { config: { rateLimit: { max: 20, timeWindow: "15 minutes" } } };
    if (provider.callbackMethod === "POST") {
      // Apple's callback reads request.body (form_post), never request.query,
      // so no querystring schema is attached here — see rule 6 in the
      // querystring-schemas hardening audit for why this route is exempt.
      app.post("/callback", callbackOpts, handleCallback);
    } else {
      app.get(
        "/callback",
        { ...callbackOpts, schema: { querystring: socialCallbackQuerySchema } },
        handleCallback,
      );
    }
  };
}
