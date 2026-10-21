import { isDemoAccessEnabled, registerDevice, signToken } from "../auth.js";
import { prisma } from "../db.js";
import { withDbRetry } from "../db-retry.js";
import { maybeSendWelcomeEmail } from "../notify/welcome-email.js";
import {
  evaluateBetaAutoPro,
  isDemoUser,
  normalizeEmail,
  parseDeviceName,
  parseDeviceType,
  triggerDueLoginBriefing,
} from "../routes/auth.js";
import { mintExchangeCode } from "./exchange-codes.js";
import { resolveSocialLoginAction, type SocialIdentity } from "./social-identity.js";

export interface SocialLoginContext {
  ip: string;
  userAgent: string;
  /** A web sign-in's login binding, bound to its exchange code (auth/exchange-codes.ts). */
  binding?: string;
}

/**
 * Finish an Apple/Naver login whose identity the provider has already
 * verified. Mirrors the Google login branch in routes/auth.ts step for step
 * (beta gate → find-or-create → takeover neutralization → automation config →
 * welcome → JWT → device session → briefing → exchange code) WITHOUT touching
 * that live branch — the Google path stays exactly as shipped, and this one is
 * dark behind the provider flags until they flip.
 *
 * Returns the browser redirect: /auth/callback?code=… on success, or
 * /login?error=<provider>_… on every refusal.
 */
export async function completeSocialLogin(
  identity: SocialIdentity,
  ctx: SocialLoginContext,
): Promise<{ redirect: string; token?: string }> {
  const webUrl = process.env.WEB_URL || "http://localhost:8001";
  const fail = (reason: string) => ({
    redirect: `${webUrl}/login?error=${identity.provider}_${reason}`,
  });
  const email = normalizeEmail(identity.email);

  const identityRow = await withDbRetry(
    () =>
      prisma.userIdentity.findUnique({
        where: { provider_subject: { provider: identity.provider, subject: identity.subject } },
      }),
    { label: "social.find_identity" },
  );
  const emailUser = identityRow
    ? null
    : await withDbRetry(() => prisma.user.findUnique({ where: { email } }), {
        label: "social.find_user_by_email",
      });

  // Same belt-and-suspenders as the Google branch: a social login must never
  // resolve into the shared demo account.
  const resolvedUserId = identityRow?.userId ?? emailUser?.id;
  if (resolvedUserId && isDemoUser(resolvedUserId) && !isDemoAccessEnabled()) {
    return fail("failed");
  }

  const action = resolveSocialLoginAction({
    identityUserId: identityRow?.userId ?? null,
    emailUserId: emailUser?.id ?? null,
    emailVerified: identity.emailVerified,
  });

  let userId: string;
  let isNewUser = false;

  switch (action.kind) {
    case "reject_collision":
      // The address already has a Klorn account and the provider cannot vouch
      // for it — tell the user to sign in the original way instead of silently
      // handing the account to whoever controls this provider profile.
      return fail("email_in_use");

    case "reject_unverified":
      // Unclaimed address the provider cannot vouch for either — refusing
      // creation closes the pre-claim backdoor (see resolveSocialLoginAction).
      return fail("email_unverified");

    case "signin": {
      userId = action.userId;
      // Track provider-side email drift (Apple relay rotation) for support.
      // Best-effort (login proceeds regardless), but never silent.
      if (identityRow && identityRow.email !== email) {
        await prisma.userIdentity
          .update({ where: { id: identityRow.id }, data: { email } })
          .catch((err) =>
            console.warn(`[SOCIAL] identity email-drift update failed for ${identityRow.id}:`, err),
          );
      }
      break;
    }

    case "attach": {
      userId = action.userId;
      // The provider verified this address, which proves ownership — the same
      // pre-registration-takeover neutralization as the Google branch: an
      // unverified password row on this email loses its password and sessions.
      if (emailUser && !emailUser.emailVerified) {
        const wasUnverifiedPassword = Boolean(emailUser.passwordHash);
        await withDbRetry(
          () =>
            prisma.user.update({
              where: { id: userId },
              data: {
                emailVerified: true,
                ...(wasUnverifiedPassword
                  ? { passwordHash: null, sessionsInvalidatedAt: new Date() }
                  : {}),
              },
            }),
          { label: "social.verify_user" },
        );
        if (wasUnverifiedPassword) {
          await prisma.device.deleteMany({ where: { userId } }).catch(() => {});
        }
      }
      await withDbRetry(
        () =>
          prisma.userIdentity.upsert({
            where: { userId_provider: { userId, provider: identity.provider } },
            create: { userId, provider: identity.provider, subject: identity.subject, email },
            update: { subject: identity.subject, email },
          }),
        { label: "social.attach_identity" },
      );
      break;
    }

    case "create": {
      // Beta gate: identical to the register endpoint and the Google signup
      // path — a third signup door must not bypass the waitlist.
      const betaGateEnabled = process.env.BETA_GATE_ENABLED === "true";
      if (betaGateEnabled) {
        const waitlistEntry = await prisma.waitlist.findUnique({
          where: { email },
          select: { status: true },
        });
        if (waitlistEntry?.status !== "APPROVED") {
          return { redirect: `${webUrl}/login?error=invite_only` };
        }
      }
      const betaAutoProGrant = await evaluateBetaAutoPro();
      const created = await withDbRetry(
        () =>
          prisma.user.create({
            data: {
              email,
              name: identity.name || email.split("@")[0],
              passwordHash: null, // social-only user, no password
              // "create" only fires for provider-VERIFIED addresses
              // (resolveSocialLoginAction rejects the rest), so this mirrors
              // the Google branch's pre-verified stance exactly.
              emailVerified: true,
              ...(betaGateEnabled && { plan: "PRO" as const }),
              ...(betaAutoProGrant ?? {}),
              identities: {
                create: { provider: identity.provider, subject: identity.subject, email },
              },
            },
          }),
        { label: "social.create_user" },
      );
      userId = created.id;
      isNewUser = true;
      break;
    }
  }

  const user = await withDbRetry(() => prisma.user.findUnique({ where: { id: userId } }), {
    label: "social.load_user",
  });
  if (!user) return fail("failed");

  // Post-login tail — the same provider-agnostic steps as the Google branch.
  await withDbRetry(
    () =>
      prisma.automationConfig.upsert({
        where: { userId: user.id },
        create: { userId: user.id },
        update: {},
      }),
    { label: "social.upsert_automation_config" },
  );
  if (isNewUser) {
    void maybeSendWelcomeEmail({ id: user.id, email: user.email, name: user.name }).catch((err) =>
      console.error(`[WELCOME] ${identity.provider} sign-in welcome failed for ${user.id}:`, err),
    );
  }

  const token = signToken({ userId: user.id, email: user.email });
  await registerDevice(user.id, token, {
    deviceName: parseDeviceName(ctx.userAgent),
    deviceType: parseDeviceType(ctx.userAgent),
    ipAddress: ctx.ip,
  });
  triggerDueLoginBriefing(user.id, 10_000);

  // Bound to the browser that started a web sign-in (auth/exchange-codes.ts).
  const code = mintExchangeCode(token, ctx.binding);
  // token: for the DESKTOP callback branch (routes/social-auth.ts), which
  // relays/parks the JWT instead of redirecting a browser. Web callers use
  // only `redirect` — the token never lands in a URL there.
  return { redirect: `${webUrl}/auth/callback?code=${code}`, token };
}
