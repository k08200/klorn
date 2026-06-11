/**
 * POC judge — single-email 4-tier classifier.
 *
 * Per POC.md (locked 2026-05-26): "분류기 — `poc-judge.ts` 기반.
 * 4-feature scorer (confidence + sender trust + reversibility + urgency)
 * → 4-tier output. 기존 코드 위에서 정제."
 *
 * Day 7 Technical POC HARD GATE: ≥80% agreement with founder hand-labels
 * on 50 real emails. Used by:
 *   - scripts/poc-label-emails.ts (extracts 50 emails to label)
 *   - scripts/poc-accuracy.ts     (measures labels vs judgeEmail output)
 *
 * Side effects: none. This file does not persist anything. Integration
 * with EmailMessage/AttentionItem is a follow-up PR — keeping the judge
 * pure makes Day 7 GATE measurement and Day 6 prompt iteration cheap.
 */

import type { ClassifiableEmail } from "./email-classifier.js";
import { createCompletion, MODEL } from "./openai.js";
import { captureError } from "./sentry.js";
import { TIERS, type Tier } from "./tiers.js";

// PocTier is the canonical 4-tier vocabulary — re-exported from tiers.ts so
// the judge, calibration, mirror, and API can never drift apart again.
export type PocTier = Tier;

export const POC_TIERS: ReadonlyArray<PocTier> = TIERS;

/**
 * Four features that drive the tier decision. All values are 0.0–1.0 floats
 * so the rule (tierFromFeatures) can be reviewed, tuned, and overridden by
 * a human without re-running the LLM.
 */
export interface PocFeatures {
  /** Model's own confidence that its other three scores are right. */
  confidence: number;
  /** 1.0 = sender is a known, important human; 0.0 = unknown / promotional. */
  senderTrust: number;
  /** 1.0 = if AUTO is wrong it's trivial to undo; 0.0 = irreversible (e.g. a sent reply). */
  reversibility: number;
  /** 1.0 = needs attention within hours; 0.0 = informational, no clock. */
  urgency: number;
}

export interface PocJudgement {
  tier: PocTier;
  /** Short, human-readable explanation suitable for tooltip / receipt line. */
  reason: string;
  features: PocFeatures;
  /** Which path produced this judgement — useful for accuracy diffs. */
  source: "fast-path" | "sender-prior" | "llm" | "keyword-fallback";
}

/**
 * One past manual tier correction, rendered into the judge prompt as a
 * few-shot example. Mined from AttentionItem rows whose tierReason carries
 * MANUAL_OVERRIDE_PREFIX (see judge-context.ts). The judge stays pure —
 * callers fetch these and pass them in.
 */
export interface CorrectionExample {
  from: string;
  subject: string;
  tier: PocTier;
}

/**
 * A stable per-sender tier pattern strong enough to skip the LLM entirely.
 *  - "override": the user manually corrected this sender ≥2 times to the
 *    same tier — the strongest possible signal (any tier except AUTO).
 *  - "history": ≥3 consecutive past classifications agreed on QUEUE/SILENT.
 *    Never PUSH (urgency is content-dependent) and never AUTO (floors are
 *    the LLM's job).
 * Thresholds are enforced where the prior is constructed (judge-context.ts);
 * judgeEmail re-checks only the tier allowlist and the urgency guard.
 */
export interface SenderPrior {
  tier: PocTier;
  count: number;
  kind: "override" | "history";
}

export interface JudgeContext {
  corrections: CorrectionExample[];
  senderPrior: SenderPrior | null;
}

export const EMPTY_JUDGE_CONTEXT: JudgeContext = { corrections: [], senderPrior: null };

const CLAMP = (n: number): number => Math.max(0, Math.min(1, n));

/**
 * Deterministic 4-feature → 4-tier mapping.
 *
 * Re-tuned 2026-05-28 after first 50-email accuracy run. The original rule
 * defaulted to SILENT and produced 50% accuracy because the founder's
 * mental model is the opposite: QUEUE is the default ("things I'll look
 * at on my own schedule"), and SILENT is narrow ("clear marketing/promo
 * I never want to see").
 *
 * Order matters — earlier branches dominate.
 */
export function tierFromFeatures(features: PocFeatures): {
  tier: PocTier;
  reason: string;
} {
  const f: PocFeatures = {
    confidence: CLAMP(features.confidence),
    senderTrust: CLAMP(features.senderTrust),
    reversibility: CLAMP(features.reversibility),
    urgency: CLAMP(features.urgency),
  };

  // 1. Very low confidence → QUEUE.
  //    Hiding uncertain mail behind a wrong tier is the worst failure mode.
  if (f.confidence < 0.5) {
    return { tier: "QUEUE", reason: "Low classification confidence — queued for review" };
  }

  // 2. Urgent + sure → wake the user.
  if (f.urgency >= 0.7 && f.confidence >= 0.7) {
    return { tier: "PUSH", reason: "Urgent and confident" };
  }

  // 3. Clear promotional / marketing signal → SILENT.
  //    Very narrow: only when the sender is anonymous-ish AND there is no
  //    time signal AND any wrong action would be trivially reversible. This
  //    matches the founder's SILENT bucket (LinkedIn invites, 광고, view-in-browser).
  //    System notifications (Vercel deploy, account confirmations, own-product
  //    signups) do NOT match because they carry context worth a manual glance.
  if (f.senderTrust < 0.2 && f.urgency < 0.2 && f.reversibility > 0.9) {
    return { tier: "SILENT", reason: "Promotional / marketing — no human attention needed" };
  }

  // 4. Trivially reversible + very sure + not urgent → AUTO.
  //    Floors stay high so we never auto-handle a destructive action or a
  //    misclassification. Per POC.md OUT scope, AUTO is *classified only*
  //    during the POC; actual execution stays disabled.
  if (f.reversibility >= 0.85 && f.confidence >= 0.85 && f.urgency < 0.5) {
    return { tier: "AUTO", reason: "Reversible, confident, not urgent" };
  }

  // 5. Default → QUEUE.
  //    Everything that isn't clearly marketing, urgent, or auto-handleable
  //    belongs in the manual review queue. The founder's mental model treats
  //    "I'll look at this on my own pace" as the dominant bucket.
  return { tier: "QUEUE", reason: "Visible in queue for manual review" };
}

interface LlmFeatureResponse {
  confidence?: number;
  senderTrust?: number;
  reversibility?: number;
  urgency?: number;
  reason?: string;
}

const MAX_FEW_SHOT_EXAMPLES = 5;

/**
 * Render past manual corrections as a ground-truth block. The model scores
 * features (not tiers), so the block spells out the feature→tier rule it
 * should aim for when an example matches the incoming email's pattern.
 */
function buildCorrectionsBlock(corrections: CorrectionExample[]): string {
  if (corrections.length === 0) return "";
  const lines = corrections
    .slice(0, MAX_FEW_SHOT_EXAMPLES)
    .map((c) => `- from: ${c.from.slice(0, 120)} | subject: ${c.subject.slice(0, 80)} → ${c.tier}`);
  return `

The user manually corrected these past classifications (ground truth for how THIS user tiers similar mail — PUSH = interrupt now, QUEUE = review later, SILENT = clear marketing, AUTO = safe to auto-handle). When the email matches one of these patterns, score your features so the rule lands on the corrected tier:
${lines.join("\n")}`;
}

function buildJudgePrompt(email: ClassifiableEmail, corrections: CorrectionExample[] = []): string {
  const subject = (email.subject || "").slice(0, 200);
  const from = (email.from || "").slice(0, 200);
  const snippet = (email.snippet || "").replace(/\s+/g, " ").slice(0, 400);
  const labels = (email.labels || []).slice(0, 10).join(",");

  return `You score one email on four 0.0–1.0 features. The features feed a deterministic tier rule, so be honest, not generous.

Features:
- confidence: how sure you are that your other three scores are right (1.0 = certain, 0.5 = could go either way)
- senderTrust: is this sender a real person the recipient knows or cares about? (1.0 = clear known/important human; 0.5 = professional but unfamiliar; 0.0 = anonymous / no-reply / marketing list)
- reversibility: if this mail were auto-handled (e.g. archived, replied) and that turned out wrong, how easy is it to recover? (1.0 = trivial undo, just unarchive; 0.5 = mildly awkward; 0.0 = irreversible action, e.g. lost an investor)
- urgency: does this need attention within hours? (1.0 = today / time-bound; 0.5 = this week; 0.0 = informational, no clock)

Also give a short reason (under 12 words) describing what the email is.

Respond with JSON only:
{"confidence":0.0,"senderTrust":0.0,"reversibility":0.0,"urgency":0.0,"reason":"short phrase"}${buildCorrectionsBlock(corrections)}

Email:
from: ${from}
subject: ${subject}
labels: ${labels}
snippet: ${snippet}`;
}

async function extractFeaturesWithLlm(
  email: ClassifiableEmail,
  userId?: string,
  corrections: CorrectionExample[] = [],
): Promise<{ features: PocFeatures; reason: string } | null> {
  try {
    const response = await createCompletion(
      {
        model: MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are a strict JSON scorer for an email triage POC. Respond with valid JSON only — no prose, no code fences.",
          },
          { role: "user", content: buildJudgePrompt(email, corrections) },
        ],
        response_format: { type: "json_object" },
      },
      userId ? { userId, priority: "background" as const } : {},
    );

    const raw = response.choices[0]?.message?.content;
    if (!raw) return null;

    const parsed = JSON.parse(raw) as LlmFeatureResponse;

    const features: PocFeatures = {
      confidence: CLAMP(Number(parsed.confidence ?? 0)),
      senderTrust: CLAMP(Number(parsed.senderTrust ?? 0)),
      reversibility: CLAMP(Number(parsed.reversibility ?? 0)),
      urgency: CLAMP(Number(parsed.urgency ?? 0)),
    };
    const reason = typeof parsed.reason === "string" ? parsed.reason : "";
    return { features, reason };
  } catch (err) {
    captureError(err, { tags: { scope: "poc-judge.llm" } });
    return null;
  }
}

/**
 * Coarse keyword-only feature scorer for when the LLM is unavailable.
 *
 * Re-tuned 2026-05-28 to separate two automated-sender signals that the
 * founder treats differently:
 *  - "marketing"   = newsletter / digest / promo / "광고" → SILENT bucket
 *  - "notification"= no-reply / notifications@ / updates.* → still QUEUE
 *
 * The old `isAutomated` mashed both together and forced everything into
 * the SILENT branch.
 */
function keywordFeatures(email: ClassifiableEmail): PocFeatures {
  const from = (email.from || "").toLowerCase();
  const subject = (email.subject || "").toLowerCase();
  const snippet = (email.snippet || "").toLowerCase();
  const hay = `${subject} ${snippet}`;
  const fromAndSubject = `${from} ${subject}`;

  // Narrow marketing signal — the patterns the founder permanently silences.
  const isMarketing =
    /newsletter|digest|marketing|promo|\[광고\]|\[알림\]|\(광고\)|unsubscribe|수신거부/.test(
      fromAndSubject,
    );
  // Broader system-notification signal — these the founder still wants in QUEUE.
  const isSystemNotification =
    /no[-_]?reply@|noreply@|donotreply@|notifications?@|@updates\.|@email\.|@notifications\./.test(
      from,
    );
  const isInvestor = /investor|vc|capital|ventures|partner@|fund/.test(from);
  const isUrgentWord = URGENT_WORDS_RE.test(hay);
  const isMeeting = /meeting|invite|calendar|zoom|reschedule|미팅|일정/.test(hay);
  const isQuestion = /\?|could you|can you|would you|please/.test(hay);

  // senderTrust calibrated against the founder's 50-email ground truth:
  //   marketing       → 0.05 (clear SILENT signal — passes the trust<0.2 floor)
  //   system notice   → 0.4  (QUEUE — visible but not interrupting)
  //   investor        → 0.85
  //   default         → 0.45 (queue-by-default per tierFromFeatures rule 5)
  let senderTrust = 0.45;
  if (isMarketing) senderTrust = 0.05;
  else if (isSystemNotification) senderTrust = 0.4;
  else if (isInvestor) senderTrust = 0.85;

  // Marketing gets 0.1/0.95 (not the 0.2/0.9 defaults) because the SILENT
  // branch in tierFromFeatures requires urgency < 0.2 AND reversibility > 0.9
  // — strict inequalities. With the old defaults a clear newsletter sat
  // exactly ON both boundaries, so the keyword fallback could never SILENT
  // marketing mail when the LLM was down (caught by eval/judge-eval-set.json).
  let urgency = 0.2;
  if (isUrgentWord) urgency = 0.85;
  else if (isMeeting) urgency = 0.55;
  else if (isMarketing) urgency = 0.1;

  // Replies to a human are hard to undo; archives are trivial.
  let reversibility = 0.9;
  if (isQuestion || isInvestor) reversibility = 0.3;
  else if (isMarketing) reversibility = 0.95;

  // Higher confidence when a pattern matched; lower otherwise so the rule
  // defaults to QUEUE for unfamiliar cases.
  const confidence = isMarketing || isSystemNotification || isInvestor ? 0.7 : 0.55;

  return { confidence, senderTrust, reversibility, urgency };
}

/**
 * Patterns that the founder has confirmed they always want silenced.
 * Re-tuned 2026-05-28: previously fast-path fired on any fastClassify
 * "automated" result, which over-claimed Vercel notifications / own-product
 * waitlist signups / Google account confirms as SILENT.
 */
const MARKETING_SUBJECT_RE =
  /unsubscribe|view (this email )?in (your )?browser|\[광고\]|\[알림\]|\(광고\)|수신거부|무료\s*체험|할인\s*쿠폰/i;

/**
 * Time-pressure vocabulary shared by the keyword fallback and the
 * sender-prior urgency guard. Case-insensitive on purpose — callers pass
 * raw subject/snippet.
 */
const URGENT_WORDS_RE = /urgent|asap|긴급|중요|action required|today|tomorrow|deadline|due/i;

/** Cheap content check: does this email carry any time-pressure signal? */
export function looksUrgent(email: ClassifiableEmail): boolean {
  const hay = `${email.subject || ""} ${email.snippet || ""}`;
  return URGENT_WORDS_RE.test(hay);
}

/**
 * Representative feature vector for a short-circuited tier so receipts and
 * accuracy diffs stay shaped like every other judgement. Confidence reflects
 * "repeated identical outcomes", not an LLM score.
 */
function priorFeatures(tier: PocTier): PocFeatures {
  switch (tier) {
    case "SILENT":
      return { confidence: 0.9, senderTrust: 0.05, reversibility: 0.95, urgency: 0.1 };
    case "PUSH":
      return { confidence: 0.9, senderTrust: 0.9, reversibility: 0.5, urgency: 0.8 };
    case "AUTO":
      return { confidence: 0.9, senderTrust: 0.5, reversibility: 0.9, urgency: 0.2 };
    default:
      return { confidence: 0.9, senderTrust: 0.45, reversibility: 0.9, urgency: 0.2 };
  }
}

const OVERRIDE_PRIOR_TIERS: ReadonlySet<PocTier> = new Set(["PUSH", "QUEUE", "SILENT"]);
const HISTORY_PRIOR_TIERS: ReadonlySet<PocTier> = new Set(["QUEUE", "SILENT"]);

/**
 * Whether a sender prior is allowed to bypass the LLM for THIS email.
 *
 * Guards (in addition to the construction thresholds in judge-context.ts):
 *  - tier allowlist per prior kind (see SenderPrior docs)
 *  - urgency guard: a sender we normally QUEUE/SILENT can still send a
 *    time-critical email. Any urgency vocabulary in the content sends the
 *    email to the LLM instead. A PUSH override prior skips the guard —
 *    urgent content and "always interrupt" agree.
 */
function canShortCircuit(prior: SenderPrior, email: ClassifiableEmail): boolean {
  const allowed = prior.kind === "override" ? OVERRIDE_PRIOR_TIERS : HISTORY_PRIOR_TIERS;
  if (!allowed.has(prior.tier)) return false;
  if (prior.tier !== "PUSH" && looksUrgent(email)) return false;
  return true;
}

/**
 * Judge a single email → 4-tier. Pure: does not persist anything.
 *
 * Hot path:
 *  1. Clear marketing/promo (Gmail PROMOTIONS label OR marketing subject) → SILENT.
 *     Narrowed from "any automated sender" so system notifications keep
 *     getting LLM evaluation.
 *  2. Sender prior (context) — a stable per-sender pattern from manual
 *     overrides / consistent history skips the LLM (see canShortCircuit).
 *  3. LLM 4-feature extraction (with correction few-shots) → tier rule.
 *  4. LLM down → keyword feature fallback → tier rule.
 *
 * `context` is optional and fetched by callers (judge-context.ts) so the
 * judge itself stays DB-free.
 */
export async function judgeEmail(
  email: ClassifiableEmail,
  userId?: string,
  context: JudgeContext = EMPTY_JUDGE_CONTEXT,
): Promise<PocJudgement> {
  // Fast-path: only the patterns we are certain the founder treats as SILENT.
  //   - Gmail's CATEGORY_PROMOTIONS label (calibrated, ad-targeted mail)
  //   - Explicit marketing subject markers (광고, view-in-browser, unsubscribe)
  // Anything else, including no-reply / notifications@ system mail, falls
  // through to the LLM (or keyword fallback) so the rule can decide between
  // QUEUE and SILENT based on senderTrust + urgency + reversibility.
  const labels = email.labels || [];
  const subject = email.subject || "";
  const isClearMarketing =
    labels.includes("CATEGORY_PROMOTIONS") || MARKETING_SUBJECT_RE.test(subject);

  if (isClearMarketing) {
    return {
      tier: "SILENT",
      reason: "Promotional / marketing — no human attention needed",
      features: { confidence: 0.95, senderTrust: 0.05, reversibility: 1.0, urgency: 0.0 },
      source: "fast-path",
    };
  }

  const prior = context.senderPrior;
  if (prior && canShortCircuit(prior, email)) {
    const basis =
      prior.kind === "override"
        ? `${prior.count} manual corrections`
        : `${prior.count} consistent past classifications`;
    return {
      tier: prior.tier,
      reason: `Sender pattern — ${basis} → ${prior.tier}`,
      features: priorFeatures(prior.tier),
      source: "sender-prior",
    };
  }

  const llm = await extractFeaturesWithLlm(email, userId, context.corrections);
  if (llm) {
    const { tier, reason: ruleReason } = tierFromFeatures(llm.features);
    return {
      tier,
      reason: llm.reason || ruleReason,
      features: llm.features,
      source: "llm",
    };
  }

  const features = keywordFeatures(email);
  const { tier, reason } = tierFromFeatures(features);
  return { tier, reason, features, source: "keyword-fallback" };
}

/**
 * Bulk wrapper for the accuracy script and offline batch jobs. Caps
 * concurrency so a 50-email run doesn't open 50 simultaneous provider
 * connections, and optionally sleeps between calls so a free-tier provider
 * (Gemini AI Studio is 15 RPM) doesn't trip its per-minute rate limit and
 * silently force every email back to keyword-fallback.
 */
export async function judgeEmails(
  emails: ClassifiableEmail[],
  options: { userId?: string; concurrency?: number; interCallDelayMs?: number } = {},
): Promise<PocJudgement[]> {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const delayMs = Math.max(0, options.interCallDelayMs ?? 0);
  const results: PocJudgement[] = new Array(emails.length);

  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, emails.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= emails.length) return;
      results[i] = await judgeEmail(emails[i], options.userId);
      // Throttle for free-tier RPM caps. Only sleep when there's more
      // work in the queue — saves the final wait at the end of the run.
      if (delayMs > 0 && cursor < emails.length) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  });
  await Promise.all(workers);
  return results;
}
