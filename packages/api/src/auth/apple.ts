import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT } from "jose";

/**
 * Sign in with Apple. Dark until APPLE_LOGIN_ENABLED flips (config.ts); the
 * env below is only read at request time, so a deploy without it is inert.
 *
 * Required env once enabled:
 *   APPLE_CLIENT_ID    — the Services ID (e.g. ai.klorn.web)
 *   APPLE_TEAM_ID      — the developer team id
 *   APPLE_KEY_ID       — the Sign in with Apple key id
 *   APPLE_PRIVATE_KEY  — the .p8 key PEM ("\n" escapes accepted)
 *   APPLE_REDIRECT_URI — https://<api>/api/auth/apple/callback
 */
const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_AUTH_URL = "https://appleid.apple.com/auth/authorize";
const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";

export interface AppleClaims {
  sub: string;
  email: string;
  emailVerified: boolean;
}

/**
 * Why a sign-in stopped. The four causes need four different answers — a
 * broken deployment, a rejected client secret, a bad token and a user who
 * shared no email are not the same problem — but they all used to collapse
 * into one `apple_failed` that only server logs could disambiguate.
 */
export type AppleFailure = "config" | "exchange" | "token" | "claims";

export type AppleExchangeResult =
  | { ok: true; idToken: string }
  | { ok: false; reason: Extract<AppleFailure, "config" | "exchange">; detail: string };

export type AppleVerifyResult =
  | { ok: true; claims: AppleClaims }
  | { ok: false; reason: Extract<AppleFailure, "token" | "claims">; detail: string };

/** Env the client secret cannot be signed without. */
function missingAppleEnv(): string[] {
  return (
    [
      ["APPLE_CLIENT_ID", appleClientId()],
      ["APPLE_TEAM_ID", process.env.APPLE_TEAM_ID],
      ["APPLE_KEY_ID", process.env.APPLE_KEY_ID],
      ["APPLE_PRIVATE_KEY", process.env.APPLE_PRIVATE_KEY],
      ["APPLE_REDIRECT_URI", appleRedirectUri()],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);
}

function appleClientId(): string {
  return process.env.APPLE_CLIENT_ID ?? "";
}

function appleRedirectUri(): string {
  return process.env.APPLE_REDIRECT_URI ?? "";
}

export function buildAppleAuthUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    // form_post is REQUIRED by Apple whenever a scope is requested — the
    // callback therefore arrives as a POST with a urlencoded body, not a GET.
    response_mode: "form_post",
    client_id: appleClientId(),
    redirect_uri: appleRedirectUri(),
    scope: "email",
    state,
  });
  return `${APPLE_AUTH_URL}?${params}`;
}

/**
 * Apple has no static client secret — it is a short-lived ES256 JWT signed
 * with the developer's .p8 key (Apple docs: "Creating a client secret").
 */
export async function makeAppleClientSecret(now = Date.now()): Promise<string> {
  const pem = (process.env.APPLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
  const key = await importPKCS8(pem, "ES256");
  const iat = Math.floor(now / 1000);
  return await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: process.env.APPLE_KEY_ID ?? "" })
    .setIssuer(process.env.APPLE_TEAM_ID ?? "")
    .setIssuedAt(iat)
    .setExpirationTime(iat + 300)
    .setAudience(APPLE_ISSUER)
    .setSubject(appleClientId())
    .sign(key);
}

/** Exchange the authorization code for tokens; the identity is the id_token. */
export async function exchangeAppleCode(code: string): Promise<AppleExchangeResult> {
  const missing = missingAppleEnv();
  if (missing.length > 0) {
    // Caught before calling Apple: a half-set deployment would otherwise look
    // identical to a wrong key, and Apple's answer would be the same either way.
    console.warn(`[APPLE] not configured — missing ${missing.join(", ")}`);
    return { ok: false, reason: "config", detail: `missing ${missing.join(", ")}` };
  }

  let clientSecret: string;
  try {
    clientSecret = await makeAppleClientSecret();
  } catch (err) {
    // An unparseable .p8 — wrong file, truncated paste, or PEM newlines lost.
    console.warn("[APPLE] client secret could not be signed:", err);
    return { ok: false, reason: "config", detail: "APPLE_PRIVATE_KEY is not a usable ES256 key" };
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: appleClientId(),
    client_secret: clientSecret,
    redirect_uri: appleRedirectUri(),
  });
  const res = await fetch(APPLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    // Apple's slug is the whole diagnosis: invalid_client means the secret was
    // refused (wrong Team ID / Key ID / key / Services ID), invalid_grant means
    // the secret was fine and the code was not.
    const detail = await appleErrorSlug(res);
    console.warn(`[APPLE] token exchange failed: ${res.status} ${detail}`);
    return { ok: false, reason: "exchange", detail };
  }
  const json = (await res.json()) as { id_token?: string };
  if (typeof json.id_token !== "string") {
    console.warn("[APPLE] token exchange returned no id_token");
    return { ok: false, reason: "exchange", detail: "no id_token in response" };
  }
  return { ok: true, idToken: json.id_token };
}

/** Apple's error body is `{error, error_description}`; fall back to raw text. */
async function appleErrorSlug(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (typeof parsed.error === "string" && parsed.error) return parsed.error;
  } catch {
    // Not JSON — the raw prefix is still the best lead we have.
  }
  return text.slice(0, 120) || `HTTP ${res.status}`;
}

// Module-level so the JWKS response is cached across logins (jose refreshes on
// unknown kid), instead of refetched per callback.
const appleJwks = createRemoteJWKSet(new URL(APPLE_JWKS_URL));

/** Verify the id_token's signature + iss/aud, then extract the claims. */
export async function verifyAppleIdToken(idToken: string): Promise<AppleVerifyResult> {
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(idToken, appleJwks, {
      issuer: APPLE_ISSUER,
      audience: appleClientId(),
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (err) {
    // Signature, issuer or audience — audience being the one a misconfigured
    // Services ID trips, since `aud` must equal APPLE_CLIENT_ID exactly.
    console.warn("[APPLE] id_token verification failed:", err);
    return { ok: false, reason: "token", detail: (err as Error).message };
  }
  const claims = parseAppleClaims(payload);
  if (!claims) {
    // A valid token that carries no usable email: the sign-in was real, the
    // account cannot be. Worth its own answer — the user can retry and choose
    // to share an address, which no amount of retrying a broken key fixes.
    console.warn("[APPLE] id_token carried no usable email claim");
    return { ok: false, reason: "claims", detail: "no email claim" };
  }
  return { ok: true, claims };
}

/**
 * Pure claim extraction (exported for tests). `sub` + `email` are required;
 * Apple serializes email_verified as a boolean OR the string "true" depending
 * on the flow, so both spellings count.
 */
export function parseAppleClaims(payload: Record<string, unknown>): AppleClaims | null {
  const sub = typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : null;
  const email =
    typeof payload.email === "string" && payload.email.includes("@") ? payload.email : null;
  if (!sub || !email) return null;
  const verified = payload.email_verified;
  return { sub, email, emailVerified: verified === true || verified === "true" };
}
