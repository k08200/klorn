import { prisma } from "../db.js";
import { sendWelcomeEmail } from "../mail/email.js";
import { captureDbFailure, logDbFailure } from "../report-db-failure.js";

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
 * If the send does not land for a reason that can clear — a retryable failure
 * (`failed`: rate limit, 5xx, timeout, Klorn's own key or domain) OR Resend
 * being unconfigured (`skipped`) — the claim is released so a later sign-in
 * retries; a missing API key must not permanently stamp the user as welcomed.
 * When Resend refused the address for good (`rejected`, mail/resend-send.ts),
 * the claim is kept: the welcome is settled, and re-sending on every sign-in
 * would only repeat the refusal. So `welcomeEmailSentAt` means "welcome
 * settled", sent or refused. Failures are logged to the console AND Sentry
 * (inside sendWelcomeEmail and here) — never swallowed.
 *
 * The send carries a per-user idempotency key: a send that timed out here but
 * did land at Resend is answered, on the retry, with the first send instead of
 * a second welcome (Resend keeps the key 24 hours).
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

    const result = await sendWelcomeEmail(user.email, user.name, {
      idempotencyKey: welcomeIdempotencyKey(user.id),
    });
    if (result === "sent") return; // keep the claim
    if (result === "rejected") {
      // Keep the claim: sendWelcomeEmail logged + captured Resend's code.
      console.warn(`[WELCOME] Resend refused the welcome for user ${user.id} — not retrying`);
      return;
    }

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
    logDbFailure("[WELCOME] unexpected error welcoming user", err, {
      level: "error",
      ids: { userId: user.id },
    });
    captureDbFailure("[WELCOME] unexpected error welcoming user", err, {
      tags: { scope: "welcome-email.orchestrate" },
      extra: { userId: user.id },
    });
  }
}

/** One welcome per user, whichever attempt Resend sees first. */
function welcomeIdempotencyKey(userId: string): string {
  return `welcome-email/${userId}`;
}

/** Best-effort claim release; logs + captures on failure so it is never silent. */
async function releaseClaim(userId: string): Promise<void> {
  await prisma.user
    .updateMany({ where: { id: userId }, data: { welcomeEmailSentAt: null } })
    .catch((err) => {
      logDbFailure("[WELCOME] failed to release claim for user", err, {
        level: "error",
        ids: { userId },
      });
      captureDbFailure("[WELCOME] failed to release claim for user", err, {
        tags: { scope: "welcome-email.release" },
        extra: { userId },
      });
    });
}
