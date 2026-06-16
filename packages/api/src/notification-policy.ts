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
  /**
   * Optional — the Notification.type the caller is about to write. When set,
   * lets us skip the noise heuristic for first-party surfaces ("briefing",
   * etc.) whose body content the founder writes and may legitimately contain
   * marketing-looking words like "sale" or "deal" inside a real briefing.
   */
  notificationType?: string | null;
}): "noise" | "housekeeping" | null {
  const title = args.title || "";
  const message = args.message || "";
  const type = args.notificationType || "";
  const combined = `${title} ${message}`.toLowerCase();

  // Surfaces that skip the noise heuristic. The heuristic is tuned for RAW,
  // un-adjudicated inbound mail and false-positives on legit content:
  //   - "briefing": body is author-controlled (our own prompt), may quote a
  //     real "$X sale deadline".
  //   - "firewall": the firewall judge / URGENT classifier already adjudicated
  //     this email as PUSH-worthy. The keyword heuristic must NOT silently veto
  //     that decision — a subject like "confirm your wire transfer" or
  //     "verify your account before the deal closes" is exactly what must ring.
  const isAuthored = type === "briefing" || type === "firewall";

  if (
    !isAuthored &&
    (/^\[새 메일\]/.test(title) ||
      /newsletter|광고|marketing|promotion|unsubscribe|수신거부|digest|\[ad\]|\[광고\]|할인|coupon|\bsale\b|deal|welcome to |verify your |confirm your /.test(
        combined,
      ))
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

  // Empty-briefing push: the daily briefing notification was sent but the
  // model had no calendar / task / email signals to summarize, so the body
  // is just a "no action" placeholder. Pushing this to the user's phone
  // ("Daily Briefing Ready — No action needed") is pure noise — there's
  // nothing to read or act on. The DB notification + the in-app bell still
  // get the row (so the receipt page tells the truth); we just suppress
  // the phone push.
  //
  // Observed 2026-05-31 in the founder's dogfood phone (4 of 6 most-recent
  // pushes were "Daily Briefing Ready — No action needed" while the
  // calendar held zero upcoming events).
  if (
    /^daily briefing ready$/i.test(title) &&
    (/^\s*no action needed[.!]?\s*$/i.test(message) ||
      /\bnothing to (prepare|surface|review)\b/i.test(message) ||
      /\bno tasks, calendar, or emails to analyze\b/i.test(message))
  ) {
    return "housekeeping";
  }

  return null;
}
