/**
 * Which per-user push rate-limit bucket a notification category rings against.
 *
 * Two independent buckets (caps in config.ts, enforced by push-rate-limit.ts):
 *
 * - interrupt: "this needs you now". Urgent mail (the PUSH lane, and MEETING
 *   mail, which firewall-push.ts sends as email_urgent) and meeting alerts
 *   ("Meeting in N min", background.ts). These are the same two kinds the
 *   desktop shell raises OS banners for (desktop-alert.ts).
 * - ambient: everything else. Briefings and the weekly report, agent proposals,
 *   reminders and task nudges, candidate-mail notices, reconnect prompts, test
 *   pushes. Useful, but none is lost by arriving later, and the bell row keeps
 *   each one either way.
 *
 * A record, not a set, so a new NotifCategory fails typecheck until someone
 * decides which bucket it belongs in.
 */

import type { NotifCategory } from "./notification-prefs.js";

export type PushBucket = "interrupt" | "ambient";

const BUCKET_BY_CATEGORY: Record<NotifCategory, PushBucket> = {
  email_urgent: "interrupt",
  meeting: "interrupt",
  // Candidate materials: a firewall-decided notice (push.ts authoredSurface),
  // but one per inbound attachment batch and not time-boxed. Ambient.
  email_candidate: "ambient",
  task_due: "ambient",
  agent_proposal: "ambient",
  daily_briefing: "ambient",
  system: "ambient",
};

export function pushBucketFor(category: NotifCategory): PushBucket {
  return BUCKET_BY_CATEGORY[category];
}
