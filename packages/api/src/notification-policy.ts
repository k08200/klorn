/**
 * Notification suppression rule.
 *
 * Originally lived in autonomous-agent.ts (PR #456). Moved here so the
 * same rule can be enforced from every notification entry point —
 * push.ts, automation-scheduler.ts, reminder-scheduler.ts, briefing.ts,
 * proactive-actions.ts, background.ts — not just the autonomous agent's
 * notify_user tool. Whack-a-mole if you only patch one site; the prod
 * incident on 2026-05-31 surfaced again from the LOW-risk auto-exec
 * code path that PR #456 didn't cover.
 *
 * Two suppression categories:
 *   - "noise":       newsletter / promo / marketing / verify-your-account
 *                    boilerplate.
 *   - "housekeeping": outcome of LOW-risk tools (mark_read, classify_emails,
 *                    list_skills, execute_skill) the user reviews on the
 *                    daily receipt page. Never warrants a push.
 *
 * Returns the reason string to log, or null when the notification
 * should be allowed through.
 */
export function notificationSuppressionReason(args: {
  title?: string | null;
  message?: string | null;
}): "noise" | "housekeeping" | null {
  const title = args.title || "";
  const message = args.message || "";
  const combined = `${title} ${message}`.toLowerCase();

  if (
    /^\[새 메일\]/.test(title) ||
    /newsletter|광고|marketing|promotion|unsubscribe|수신거부|digest|\[ad\]|\[광고\]|할인|coupon|\bsale\b|deal|welcome to |verify your |confirm your /.test(
      combined,
    )
  ) {
    return "noise";
  }

  if (
    /^\s*\[?(?:klorn|eve|이브)\]?\s*action complete/i.test(title) ||
    /^\s*action complete\b/i.test(title) ||
    /\bmark read finished\b/i.test(combined) ||
    /\bemails? classified\b/i.test(combined) ||
    /\bclassify_emails finished\b/i.test(combined) ||
    /\bmail prioritized\b/i.test(title) ||
    /\binbox priority has been refreshed\b/i.test(combined)
  ) {
    return "housekeeping";
  }

  return null;
}
