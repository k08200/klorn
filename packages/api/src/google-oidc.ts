/**
 * Google OIDC ID-token verification.
 *
 * Used by the Gmail Pub/Sub push endpoint: Pub/Sub authenticates by attaching
 * an OIDC token signed by Google. Decoding claims is NOT enough — anyone can
 * base64 a payload with the right iss/email/exp. The signature must be checked
 * against Google's published certs, which `verifyIdToken` does (it also
 * enforces exp and the accounts.google.com issuer).
 */

import { google } from "googleapis";

export interface GoogleOidcClaims {
  email?: string;
  email_verified?: boolean;
  aud?: string;
  iss?: string;
  exp?: number;
}

// OAuth2Client caches Google's certs between calls; keep one instance.
const oidcClient = new google.auth.OAuth2();

/**
 * Verify signature, expiry, and issuer of a Google-issued OIDC token.
 * Audience is checked only when GMAIL_PUSH_OIDC_AUDIENCE is configured
 * (Pub/Sub sets it to the push endpoint URL).
 * Returns the verified claims, or null when verification fails.
 */
export async function verifyGoogleOidcToken(token: string): Promise<GoogleOidcClaims | null> {
  try {
    const ticket = await oidcClient.verifyIdToken({
      idToken: token,
      audience: process.env.GMAIL_PUSH_OIDC_AUDIENCE,
    });
    return (ticket.getPayload() as GoogleOidcClaims | undefined) ?? null;
  } catch {
    return null;
  }
}
