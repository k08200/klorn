import { prisma } from "./db.js";
import { sendWelcomeEmail } from "./email.js";
import { captureError } from "./sentry.js";

export interface WelcomeRecipient {
  id: string;
  email: string;
  name: string | null;
}

/**
 * Send the founder welcome email exactly once per user.
 *
 * Safe to call on any sign-in path: an atomic `welcomeEmailSentAt` null → now
 * claim means only the first caller actually sends, so the email-verify and
 * Google sign-in hooks cannot double-welcome the same account.
 *
 * If the send does not land — a real failure OR Resend being unconfigured
 * (`skipped`) — the claim is released so a later sign-in retries; a missing API
 * key must not permanently stamp the user as welcomed. Failures are logged to
 * the console AND Sentry (inside sendWelcomeEmail and here) — never swallowed.
 *
 * Residual gap: a hard process crash between the claim write and the release
 * (not a thrown error — those are caught below) can leave a user stamped but
 * un-welcomed. The window is microseconds and the cost is one missed email, so
 * we accept it rather than add a two-phase outbox for a non-critical message.
 */
export async function maybeSendWelcomeEmail(user: WelcomeRecipient): Promise<void> {
  let claimed = false;
  try {
    const claim = await prisma.user.updateMany({
      where: { id: user.id, welcomeEmailSentAt: null },
      data: { welcomeEmailSentAt: new Date() },
    });
    if (claim.count === 0) return; // already welcomed, or a concurrent caller won the claim
    claimed = true;

    const result = await sendWelcomeEmail(user.email, user.name);
    if (result === "sent") return; // keep the claim

    // `failed` or `skipped` → release so a later sign-in retries. On `failed`,
    // sendWelcomeEmail already logged + captured the real error; `skipped`
    // (Resend unconfigured) is an expected no-op, so release quietly.
    await releaseClaim(user.id);
    claimed = false;
    if (result === "failed") {
      console.error(`[WELCOME] send failed for user ${user.id} — will retry on next sign-in`);
    }
  } catch (err) {
    if (claimed) await releaseClaim(user.id);
    console.error(`[WELCOME] unexpected error welcoming user ${user.id}:`, err);
    captureError(err, { tags: { scope: "welcome-email.orchestrate" }, extra: { userId: user.id } });
  }
}

/** Best-effort claim release; logs + captures on failure so it is never silent. */
async function releaseClaim(userId: string): Promise<void> {
  await prisma.user
    .updateMany({ where: { id: userId }, data: { welcomeEmailSentAt: null } })
    .catch((err) => {
      console.error(`[WELCOME] failed to release claim for user ${userId}:`, err);
      captureError(err, { tags: { scope: "welcome-email.release" }, extra: { userId } });
    });
}
