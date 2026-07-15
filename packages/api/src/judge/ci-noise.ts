/**
 * CI/monitoring noise detector (#793) — the SILENT split of the automated
 * sender floor.
 *
 * The uniform floor (#794) demotes every automated sender's PUSH to QUEUE.
 * This module identifies the strictly-noise subset that deserves SILENT —
 * mail that is never worth even a glance — while honoring two hard
 * constraints pulling in opposite directions:
 *
 *  - Eval ground truth: Vercel "Deployment completed: klorn-web" is QUEUE.
 *    A production deploy result of your own site IS worth a glance, so
 *    "CI sender + routine subject" is too broad a SILENT rule.
 *  - Founder's deferred-caution (#793): a too-broad rule could hide a
 *    genuine "production is down" alert.
 *
 * The reconciling boundary — noise is ONLY:
 *  (a) non-production context: a CI/monitoring notice explicitly about
 *      test / preview / staging / sandbox ("Failed preview deployment",
 *      "TEST: Monitor is DOWN"), or
 *  (b) a monitoring pulse: up / back online / recovered / resolved /
 *      periodic uptime report — inherently no-action mail.
 *
 * Real DOWN/failure alerts and prod deploy results fall through to the
 * QUEUE floor. Security/account vocabulary is carved out first (shared
 * single-source regexes in keyword-policy.ts) — that mail is never noise.
 *
 * Consumed flag-gated (CI_NOISE_SILENT_FLOOR, default OFF): the judge logs a
 * shadow line when OFF so dogfood measures would-be silences before the flip.
 */

import { extractEmailAddress } from "../mail/email-address.js";
import type { ClassifiableEmail } from "./email-classifier.js";
import {
  ACCOUNT_ALERT_ACTION_RE,
  ACCOUNT_CONFIRMATION_RE,
  isAutomatedSender,
} from "./keyword-policy.js";

/** Read per call (not at module load) so tests and ops can flip it live. */
export function isCiNoiseSilentEnabled(): boolean {
  return process.env.CI_NOISE_SILENT_FLOOR === "true";
}

/** CI / deploy / monitoring platforms whose automated mail carries the signal. */
const CI_SENDER_RE =
  /@(?:[\w.-]*\.)?(vercel\.(com|app)|netlify\.(com|app)|circleci\.com|travis-ci\.(com|org)|buildkite\.com|appveyor\.com|uptimerobot\.com|pingdom\.com|statuscake\.com|cronitor\.io|betteruptime\.com|betterstack\.com)/i;

/**
 * Machine-role local-parts CI/monitoring platforms actually alert from
 * (alert@uptimerobot.com, builds@circleci.com). isAutomatedSender doesn't
 * know these roles — and must not, its scope is commitment/notification
 * policy — so the detector recognizes them ONLY on a known platform domain.
 * A human channel on the same domain (support@vercel.com) stays human.
 */
const CI_MACHINE_ROLE_RE =
  /^(alerts?|builds?|ci|deploys?|status|monitor(ing)?|robot|bot|automation)([._+-][^@]*)?@/i;

/** Machine mail for the purposes of this detector (see CI_MACHINE_ROLE_RE). */
function isCiMachineSender(from: string): boolean {
  if (isAutomatedSender(from)) return true;
  const addr = extractEmailAddress(from);
  return CI_SENDER_RE.test(addr) && CI_MACHINE_ROLE_RE.test(addr);
}

/** CI/deploy context vocabulary (subject + snippet). */
const CI_CONTEXT_RE = /\b(deploy(ment)?|build|pipeline|workflow|preview|ci)\b/i;

/** Monitoring context vocabulary (subject + snippet). */
const MONITOR_CONTEXT_RE = /\b(monitor(ing)?|uptime|status page|health[- ]?check)\b/i;

/** Explicit non-production markers — the noise boundary for branch (a). */
const NON_PROD_RE = /\b(test|preview|staging|sandbox)\b/i;

/** No-action monitoring pulses — the noise boundary for branch (b). */
const MONITOR_PULSE_RE =
  /\b(is (back )?up|back online|recovered|resolved|operational|no incidents|(weekly|monthly) (uptime |status )?(report|summary))\b/i;

export interface CiNoiseVerdict {
  reason: string;
}

/**
 * Pure detector: null = not noise (leave the decision alone). Never matches
 * security/account mail, human senders, or anything without an explicit
 * non-prod marker / monitoring pulse.
 */
export function detectCiNoise(email: ClassifiableEmail): CiNoiseVerdict | null {
  const from = email.from || "";
  if (!isCiMachineSender(from)) return null;

  const head = `${email.subject || ""} ${email.snippet || ""}`;
  if (ACCOUNT_CONFIRMATION_RE.test(head) || ACCOUNT_ALERT_ACTION_RE.test(head)) return null;

  const ciContext = CI_SENDER_RE.test(from) || CI_CONTEXT_RE.test(head);
  const monitorContext = MONITOR_CONTEXT_RE.test(head);
  if (!ciContext && !monitorContext) return null;

  if (NON_PROD_RE.test(head)) {
    return { reason: "CI/monitoring noise — non-production notice, silenced" };
  }
  if (monitorContext && MONITOR_PULSE_RE.test(head)) {
    return { reason: "CI/monitoring noise — routine monitoring pulse, silenced" };
  }
  return null;
}
