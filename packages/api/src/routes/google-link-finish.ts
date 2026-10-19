/**
 * The Google account-link completions: the primary Gmail/Calendar connect
 * (`__oauth_state__`), a secondary calendar (`__link_calendar__`) and a
 * secondary inbox (`__link_inbox__`).
 *
 * These are the callback branches of GET /api/auth/google/callback, moved here
 * unchanged except that each RETURNS where the browser goes (a relative path,
 * or a status and error) instead of redirecting. The callback no longer runs
 * them: it parks the authorization code (auth/pending-links.ts), and
 * POST /api/auth/link/complete exchanges it and calls these only for the
 * session of the user who started the flow. Every entitlement re-check, cap,
 * self-link check, verified-email check and refresh-token guard is the
 * callback's own; the paths are the ones it redirected to.
 */

import type { LinkFinish } from "../auth/pending-links.js";
import {
  findOwnedLinkedAccount,
  keepIfOnlyMailSource,
  keepPrimaryGoogleIfOnlyMailSource,
  mayConnectMailAccount,
  mayConnectPrimaryGoogle,
} from "../billing/mail-account-entitlement.js";
import { isEntitled } from "../billing/stripe.js";
import { encryptOptional, encryptToken } from "../crypto-tokens.js";
import { prisma } from "../db.js";
import { withDbRetry } from "../db-retry.js";
import { getGoogleUserInfo, getOAuth2Client, registerGmailWatch } from "../mail/gmail.js";
import { isDataWipeFenceError } from "../privacy/data-wipe-fence.js";
import { captureError } from "../sentry.js";

/** The Google markers whose callback parks the code instead of exchanging it. */
export const GOOGLE_LINK_MARKERS = [
  "__oauth_state__",
  "__link_calendar__",
  "__link_inbox__",
] as const;
export type GoogleLinkMarker = (typeof GOOGLE_LINK_MARKERS)[number];

export function isGoogleLinkMarker(marker: unknown): marker is GoogleLinkMarker {
  return (GOOGLE_LINK_MARKERS as readonly unknown[]).includes(marker);
}

/** What Google's token endpoint returned for the code. */
type GoogleTokens = ReturnType<typeof getOAuth2Client>["credentials"];

/** Ceiling on linked secondary inboxes per user (unbounded-growth guard). */
const MAX_LINKED_INBOXES = 10;

/** The same message the callback's catch answered with: never the raw provider error. */
const GOOGLE_LINK_FAILED = "Google authorization failed. Please try again.";

// Same normalisation as routes/auth.ts normalizeEmail (a per-module copy, as in
// routes/outlook-auth.ts): trimmed lower case.
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Callback branch __link_calendar__ (link a secondary calendar).
// A DIFFERENT Google account is being attached to the ALREADY-logged-in
// user (userId) purely for calendar free/busy. We do NOT
// resolve or switch the user by this Google email — the linked token only
// ever feeds checkConflicts.
export async function finishGoogleCalendarLink(
  userId: string,
  tokens: GoogleTokens,
): Promise<LinkFinish> {
  if (!tokens.access_token) {
    return { next: "/calendar?linked=failed" };
  }
  const profile = await getGoogleUserInfo(tokens.access_token);
  if (profile.verified_email !== true) {
    return { next: "/calendar?linked=unverified" };
  }
  // Re-verify entitlement at callback time. The initiate endpoint gates on
  // requireEntitled, but the user could downgrade during the 10-min OAuth
  // window — without this the lapsed user still links a Pro-only secondary
  // calendar (TOCTOU). Inert while PAYWALL is off (entitled always true),
  // load-bearing the moment it flips.
  const calLinker = await prisma.user.findUnique({
    where: { id: userId },
    select: { plan: true, role: true },
  });
  if (!calLinker || !isEntitled(calLinker.plan, calLinker.role)) {
    return { next: "/calendar?linked=failed" };
  }
  const linkedEmail = normalizeEmail(profile.email);
  // Linking your own primary address duplicates the mailbox: the
  // selector shows it twice and every sync runs double. Refuse it.
  const linkOwner = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  if (linkOwner?.email && normalizeEmail(linkOwner.email) === linkedEmail) {
    return { next: "/settings?inbox=self" };
  }
  const expiresAt = tokens.expiry_date ? new Date(tokens.expiry_date) : null;
  await prisma.linkedCalendarAccount.upsert({
    where: {
      userId_provider_email: {
        userId: userId,
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
      userId: userId,
      provider: "GOOGLE",
      email: linkedEmail,
      accessToken: encryptToken(tokens.access_token),
      refreshToken: encryptOptional(tokens.refresh_token),
      expiresAt,
    },
  });
  return { next: "/calendar?linked=success" };
}

// Callback branch __link_inbox__ (link a secondary inbox).
// A DIFFERENT Google account is attached to the ALREADY-logged-in user
// (userId) as an additional mail source. We NEVER resolve or
// switch the session user by this Google email — the linked token only
// feeds this user's own firewall. verified_email is checked verbatim (as
// the calendar flow does) to block the confused-deputy vector of linking
// an unverified/spoofed address.
export async function finishGoogleInboxLink(
  userId: string,
  tokens: GoogleTokens,
): Promise<LinkFinish> {
  if (!tokens.access_token) {
    return { next: "/settings?inbox=failed" };
  }
  const profile = await getGoogleUserInfo(tokens.access_token);
  if (profile.verified_email !== true) {
    return { next: "/settings?inbox=unverified" };
  }
  const inboxLinker = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  if (!inboxLinker) {
    return { next: "/settings?inbox=failed" };
  }
  const linkedEmail = normalizeEmail(profile.email);
  // Re-check at callback time, with the real address (TOCTOU): the
  // first mailbox is free, a second one needs Pro — a user who got a
  // mailbox or downgraded during the 10-min OAuth window cannot finish.
  // Re-linking this same account is never refused. Inert while the
  // paywall is off.
  const inboxAccount = { provider: "GOOGLE" as const, email: linkedEmail };
  if (!(await mayConnectMailAccount(userId, inboxAccount))) {
    return { next: "/settings?inbox=pro" };
  }
  const expiresAt = tokens.expiry_date ? new Date(tokens.expiry_date) : null;
  // Cap NEW links only: a re-link (existing row → update path) must always
  // be allowed so a user can never lock themselves out of reconnecting an
  // inbox they already have.
  // Case-insensitive: a legacy mixed-case row of this address is the
  // same account, re-linked in place (its stored address kept).
  const existingLink = await findOwnedLinkedAccount(userId, {
    provider: "GOOGLE",
    email: linkedEmail,
  });
  if (!existingLink) {
    const linkedCount = await prisma.linkedInboxAccount.count({
      // GOOGLE only: the cap governs Google links; Naver has its own
      // cap on its own route (MAX_NAVER_ACCOUNTS).
      where: { userId: userId, provider: "GOOGLE" },
    });
    if (linkedCount >= MAX_LINKED_INBOXES) {
      return { next: "/settings?inbox=limit" };
    }
  }
  const savedInbox = await prisma.linkedInboxAccount.upsert({
    where: {
      userId_provider_email: {
        userId: userId,
        provider: "GOOGLE",
        email: existingLink?.email ?? linkedEmail,
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
      userId: userId,
      email: linkedEmail,
      accessToken: encryptToken(tokens.access_token),
      refreshToken: encryptOptional(tokens.refresh_token),
      expiresAt,
    },
  });
  // Check-after-insert for a NEW row: a parallel first connect of
  // another account may have committed meanwhile. Fails closed.
  if (
    !existingLink &&
    !(await keepIfOnlyMailSource(userId, {
      ...inboxAccount,
      id: savedInbox.id,
    }))
  ) {
    return { next: "/settings?inbox=pro" };
  }
  return { next: "/settings?inbox=success" };
}

// The primary Gmail/Calendar integration (callback branch __oauth_state__).
export async function finishGooglePrimaryConnect(
  userId: string,
  tokens: GoogleTokens,
): Promise<LinkFinish> {
  const user = await withDbRetry(() => prisma.user.findUnique({ where: { id: userId } }), {
    label: "oauth.integration.find_user",
  });
  if (!user) {
    return { status: 404, error: "User not found" };
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
    return { next: "/settings?google=offline_access_denied" };
  }

  // Re-check at callback time (TOCTOU): a Free user who connected a
  // linked mailbox during the OAuth window cannot add Gmail as a second.
  if (!(await mayConnectPrimaryGoogle(user.id))) {
    return { next: "/settings?google=pro" };
  }

  const savedToken = await withDbRetry(
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
  // Check-after-write for a NEW primary token: a parallel first connect
  // of a linked mailbox may have committed meanwhile. Fails closed.
  if (
    !existingIntegrationToken &&
    !(await keepPrimaryGoogleIfOnlyMailSource(user.id, savedToken.id))
  ) {
    return { next: "/settings?google=pro" };
  }

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

  return { next: "/settings?google=connected" };
}

const FINISHERS: Record<
  GoogleLinkMarker,
  (userId: string, tokens: GoogleTokens) => Promise<LinkFinish>
> = {
  __oauth_state__: finishGooglePrimaryConnect,
  __link_calendar__: finishGoogleCalendarLink,
  __link_inbox__: finishGoogleInboxLink,
};

/**
 * Exchange a parked code and finish its link. Mirrors the callback's try/catch
 * for these markers: any failure (the exchange included) is logged, reported
 * under the callback's scope, and answered 500 with the generic message.
 */
export async function exchangeAndFinishGoogleLink(
  marker: GoogleLinkMarker,
  userId: string,
  code: string,
): Promise<LinkFinish> {
  try {
    const oauth2 = getOAuth2Client();
    const { tokens } = await oauth2.getToken(code);
    return await FINISHERS[marker](userId, tokens);
  } catch (err) {
    // The account's data was wiped minutes ago: the fence refuses new grants
    // until it lifts. Say so instead of a generic failure.
    if (isDataWipeFenceError(err)) return { next: "/settings?google=wipe_in_progress" };
    console.error("[OAUTH] callback failed:", err instanceof Error ? err.message : String(err));
    captureError(err, { tags: { scope: "auth.oauth.callback" } });
    return { status: 500, error: GOOGLE_LINK_FAILED };
  }
}
