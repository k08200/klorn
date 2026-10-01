/**
 * Microsoft (Outlook) OAuth via the v2.0 endpoints + Microsoft Graph /me —
 * Phase 3 of docs/providers/multi-provider-plan.md.
 *
 * Plain fetch against login.microsoftonline.com instead of @azure/msal-node:
 * msal's token cache wants to own token storage, but Klorn stores tokens
 * encrypted in LinkedInboxAccount rows (same as Google) — the auth-code and
 * refresh-token grants are two POSTs, not worth a new dependency.
 *
 * Env (all read at call time, so tests can vary them and a flag-off boot
 * needs none):
 *   MS_CLIENT_ID / MS_CLIENT_SECRET — Azure app registration (founder
 *     action; supported account types must include personal Microsoft
 *     accounts for outlook.com users)
 *   MS_REDIRECT_URI — defaults to the localhost dev callback
 *   MS_TENANT — "common" (default) = personal + work/school accounts
 *
 * Scopes are delegated Mail.Read / Mail.ReadWrite / Mail.Send. Klorn only
 * marks read, flags, and moves messages — the 2026-12-31 change requiring
 * Mail-Advanced.ReadWrite covers subject/body/recipient edits on delivered
 * mail, which Klorn never does (re-verified 2026-08-06). Note: some org
 * tenants block user consent for Mail.ReadWrite (admin consent needed);
 * personal outlook.com accounts consent directly.
 *
 * Two scope sets, chosen by the link being made (step C4 of
 * docs/providers/unified-platform-plan.md). The INBOX set is the one above and is
 * the default everywhere, so every existing inbox link asks for, and was granted,
 * exactly what it always did. The CALENDAR set is requested only for a calendar
 * link and for refreshing a calendar account's token: identity, offline access,
 * User.Read (so Graph /me can name the account) and Calendars.Read, read-only,
 * with no mail access. Calendars.Read is the permission the calendarView and
 * getSchedule docs list for delegated work/school and personal accounts
 * (https://learn.microsoft.com/graph/api/calendar-list-calendarview).
 */

const INBOX_SCOPES = [
  "openid",
  "email",
  "offline_access",
  "https://graph.microsoft.com/Mail.Read",
  "https://graph.microsoft.com/Mail.ReadWrite",
  "https://graph.microsoft.com/Mail.Send",
];

const CALENDAR_SCOPES = [
  "openid",
  "email",
  "offline_access",
  "https://graph.microsoft.com/User.Read",
  "https://graph.microsoft.com/Calendars.Read",
];

/** Which scope set a flow asks for: an inbox link (the default) or a calendar link. */
export type OutlookScopeSet = "inbox" | "calendar";

function scopeParam(scopeSet: OutlookScopeSet): string {
  return (scopeSet === "calendar" ? CALENDAR_SCOPES : INBOX_SCOPES).join(" ");
}

function msClientId(): string {
  return process.env.MS_CLIENT_ID ?? "";
}
function msClientSecret(): string {
  return process.env.MS_CLIENT_SECRET ?? "";
}
function msRedirectUri(): string {
  return process.env.MS_REDIRECT_URI ?? "http://localhost:3001/api/auth/outlook/callback";
}
function msTenant(): string {
  return process.env.MS_TENANT?.trim() || "common";
}
function authorityBase(): string {
  return `https://login.microsoftonline.com/${msTenant()}/oauth2/v2.0`;
}

/** True once the Azure app registration's credentials are in the env. */
export function outlookConfigured(): boolean {
  return Boolean(msClientId() && msClientSecret());
}

export function getOutlookAuthUrl(state: string, scopeSet: OutlookScopeSet = "inbox"): string {
  const params = new URLSearchParams({
    client_id: msClientId(),
    response_type: "code",
    redirect_uri: msRedirectUri(),
    response_mode: "query",
    scope: scopeParam(scopeSet),
    state,
    // select_account (not consent): offline_access already yields a refresh
    // token on first consent, and forcing re-consent on every link is hostile.
    prompt: "select_account",
  });
  return `${authorityBase()}/authorize?${params.toString()}`;
}

export interface OutlookTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
}

export interface OutlookTokenError {
  error: string;
}

export async function exchangeOutlookCode(
  code: string,
  scopeSet: OutlookScopeSet = "inbox",
): Promise<OutlookTokens | OutlookTokenError> {
  const res = await fetch(`${authorityBase()}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    // Never follow a redirect: fetch would resend this body (the client secret, the
    // code or refresh token) to wherever it points. A refused redirect rejects like
    // any network failure, which every caller already handles.
    redirect: "error",
    // Fail fast — a hung token call stalls whichever flow is waiting on it.
    signal: AbortSignal.timeout(15_000),
    body: new URLSearchParams({
      client_id: msClientId(),
      client_secret: msClientSecret(),
      grant_type: "authorization_code",
      code,
      redirect_uri: msRedirectUri(),
      scope: scopeParam(scopeSet),
    }),
  });
  if (!res.ok) {
    // The failure body can echo request material (the code rides the user's
    // redirect), so log only the status and MS's short error CODE — never the
    // body verbatim.
    let errorCode = "token_exchange_failed";
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error.length <= 64) errorCode = body.error;
    } catch {
      // non-JSON error body — keep the generic code
    }
    console.warn(`[outlook-oauth] token exchange failed: http ${res.status} error=${errorCode}`);
    return { error: errorCode };
  }
  const body = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!body.access_token) {
    return { error: "no_access_token" };
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt:
      typeof body.expires_in === "number" ? new Date(Date.now() + body.expires_in * 1000) : null,
  };
}

/**
 * Refresh-token grant. Microsoft ROTATES refresh tokens — the response
 * carries a new one that must replace the stored cipher, or the chain dies
 * at the old token's expiry. An `invalid_grant` error code means the user
 * revoked access (or the token aged out): callers must flag the row for
 * reconnect rather than retrying.
 */
export async function refreshOutlookTokens(
  refreshToken: string,
  scopeSet: OutlookScopeSet = "inbox",
): Promise<OutlookTokens | OutlookTokenError> {
  const res = await fetch(`${authorityBase()}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    // Never follow a redirect: fetch would resend this body (the client secret, the
    // code or refresh token) to wherever it points. A refused redirect rejects like
    // any network failure, which every caller already handles.
    redirect: "error",
    // Fail fast — a hung token call stalls whichever flow is waiting on it.
    signal: AbortSignal.timeout(15_000),
    body: new URLSearchParams({
      client_id: msClientId(),
      client_secret: msClientSecret(),
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: scopeParam(scopeSet),
    }),
  });
  if (!res.ok) {
    // Same non-reflection rule as the code exchange: status + short code only.
    let errorCode = "token_refresh_failed";
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error.length <= 64) errorCode = body.error;
    } catch {
      // non-JSON error body — keep the generic code
    }
    console.warn(`[outlook-oauth] token refresh failed: http ${res.status} error=${errorCode}`);
    return { error: errorCode };
  }
  const body = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!body.access_token) {
    return { error: "no_access_token" };
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt:
      typeof body.expires_in === "number" ? new Date(Date.now() + body.expires_in * 1000) : null,
  };
}

/**
 * The signed-in account's address via Graph /me. Personal accounts can have
 * `mail` null — userPrincipalName is the login address there. Unlike Google
 * there is no verified_email flag to check: Microsoft verifies the address
 * at the account level, so a token for the account proves the mailbox.
 */
export async function fetchOutlookAccountEmail(accessToken: string): Promise<string | null> {
  const res = await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", {
    headers: { authorization: `Bearer ${accessToken}` },
    // Never follow a redirect: fetch would resend the bearer token to wherever it points.
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    console.warn(`[outlook-oauth] /me failed: http ${res.status}`);
    return null;
  }
  const body = (await res.json()) as { mail?: string | null; userPrincipalName?: string | null };
  const email = body.mail || body.userPrincipalName || "";
  return email.includes("@") ? email : null;
}
