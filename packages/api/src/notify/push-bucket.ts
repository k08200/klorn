/**
 * Which per-user push rate-limit bucket a push rings against. The CALLER picks
 * it per call (sendPushNotification's `options.bucket`); the category does not.
 *
 * Two independent buckets (caps in config.ts, enforced by push-rate-limit.ts):
 *
 * - interrupt: "this needs you now". Asked for by exactly four callers, pinned
 *   by __tests__/push-interrupt-callers-guard.test.ts:
 *   - judge/firewall-push.ts: the firewall's PUSH and MEETING mail;
 *   - automation-scheduler.ts: the urgent keyword sweep;
 *   - background.ts: "Meeting in N min";
 *   - pim/reminder-scheduler.ts: reminders the user set for a time.
 * - ambient: everything else, and the default. Briefings and the weekly report,
 *   agent proposals, candidate-mail notices, reconnect prompts, test pushes,
 *   and every agent-originated push (autonomous-agent.ts notify_user,
 *   proactive-actions.ts) whatever its category. An LLM or a heuristic chose to
 *   ring those, so they must not use up the room the four above need. None is
 *   lost by arriving later, and the bell row keeps each one either way.
 *
 * The category still drives preferences, quiet hours and the UI label; it no
 * longer picks the bucket, because the agent sends email_urgent and meeting
 * too. Interrupt is opt-in rather than derived from the category so that every
 * way into it is written at a call site the guard can see: a category default
 * would let any new caller that passes email_urgent reach it unnamed.
 */

export type PushBucket = "interrupt" | "ambient";

/** The bucket a push rings against: interrupt only when the caller asks for it. */
export function resolvePushBucket(requested: PushBucket | undefined): PushBucket {
  return requested === "interrupt" ? "interrupt" : "ambient";
}
