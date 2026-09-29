/**
 * Startup guard: the judge model must not silently be one our own committed
 * eval says cannot hold the urgent-recall floor.
 *
 * Why this file exists. Between 2026-09-05 and 2026-09-25 production judged
 * 1,433 messages and emitted **zero PUSH**. The cause was not the keyword
 * fallback and not a quiet inbox — the judge was running a paid model that the
 * September bake-off had already recorded as failing the gate on every run it
 * had. The failure mode is specific and it is why nothing looked broken:
 * sonnet-5 reads urgency correctly (0.80–1.00) and reports *confidence* at
 * 0.55–0.60, under the 0.70 floor `tier-policy.ts` requires for PUSH. So mail
 * kept classifying, lanes kept filling, SILENT precision stayed high — and the
 * one lane the product exists to protect quietly went to zero for three weeks.
 *
 * The lesson is not "pin harder". It is that a model swap which degrades the
 * safety floor has no symptom a human notices. It needs to announce itself.
 *
 * This guard warns; it does not refuse to boot. That is deliberate and matches
 * the rule the cost-cap postmortem landed on: tripping must degrade, not
 * amputate. Refusing to start turns a judge that is merely worse into a total
 * outage, and a self-hoster who knowingly pins a cheap or local model must
 * still be able to run. What it may not do is happen silently.
 *
 * Numbers below are the committed ones from `eval/README.md` (2026-09-04,
 * 10 models × 3 runs, 23 clean runs) and re-run with `pnpm eval:judge`.
 */

import { captureError } from "../sentry.js";

/** A model's measured result against the committed 56-email gate set. */
export interface GateResult {
  /** Accuracy range across the clean runs, as percentages. */
  readonly accuracy: string;
  /** Urgent (PUSH) recall per run, out of 13 urgent items in the set. */
  readonly urgentRecall: string;
  /** How many runs passed the full gate, e.g. "0/2". */
  readonly gate: string;
  /** Why it failed, in one clause — this is what an operator needs. */
  readonly mechanism: string;
}

/**
 * Models the committed bake-off recorded as failing the gate on every run.
 *
 * Membership here is an empirical claim, not a judgement about the model: both
 * entries read urgency correctly and lose on calibration. Re-measure before
 * adding or removing an entry, and update `eval/README.md` in the same change.
 */
export const GATE_FAILING_JUDGE_MODELS: Readonly<Record<string, GateResult>> = {
  "anthropic/claude-sonnet-5": {
    accuracy: "80.4–85.7%",
    urgentRecall: "7 and 5 of 13",
    gate: "0/2",
    mechanism:
      "reads urgency correctly (0.80–1.00) but reports confidence at 0.55–0.60, " +
      "under the 0.70 floor PUSH requires — so urgent mail lands in the queue instead",
  },
  "anthropic/claude-opus-4.8": {
    accuracy: "87.5–89.3%",
    urgentRecall: "9 and 8 of 13",
    gate: "0/2",
    mechanism: "misses urgent items outright; recall never reached the 90% floor",
  },
};

/**
 * The pin to recommend when the configured one fails. Measured 54/56 on all
 * three runs with 13/13 urgent recall at $0.30/M — the cheapest model in the
 * bake-off that passed every run.
 */
export const RECOMMENDED_JUDGE_MODEL = "google/gemini-2.5-flash";

/**
 * Compare model ids the way an operator means them.
 *
 * OpenRouter ids carry variant suffixes (`:free`, `:beta`, `:nitro`) that
 * select routing, not a different set of weights, so `claude-sonnet-5:beta`
 * has the same calibration problem as `claude-sonnet-5` and must match. Case
 * and surrounding whitespace are normalised for the same reason: an env var
 * typed by hand should not be able to slip past the check.
 */
export function normalizeModelId(raw: string): string {
  // Tolerates a missing or non-string value on purpose. This module's whole
  // contract is that it cannot be the reason a boot fails, and it is exported,
  // so it must survive being handed whatever a caller has — including the
  // `undefined` that an unset env var produces in a path that forgot a default.
  if (typeof raw !== "string") return "";
  return raw.trim().toLowerCase().split(":")[0] ?? "";
}

export type JudgeModelVerdict =
  | { readonly status: "failed-gate"; readonly model: string; readonly result: GateResult }
  | { readonly status: "not-measured"; readonly model: string }
  | { readonly status: "passed-gate"; readonly model: string };

/**
 * Classify a judge model against the committed gate results.
 *
 * "not-measured" is the honest answer for anything outside the bake-off — most
 * models, including every local one. It is not a warning: we simply have no
 * measurement, and saying otherwise would be the kind of claim this repo
 * retracts rather than makes.
 */
export function judgeModelVerdict(model: string): JudgeModelVerdict {
  const id = normalizeModelId(model);
  const failure = GATE_FAILING_JUDGE_MODELS[id];
  if (failure) return { status: "failed-gate", model: id, result: failure };
  if (id === normalizeModelId(RECOMMENDED_JUDGE_MODEL)) {
    return { status: "passed-gate", model: id };
  }
  return { status: "not-measured", model: id };
}

/**
 * Env var that lets an operator keep a gate-failing pin on purpose.
 *
 * It exists because "we measured this and it fails" is a statement about our
 * 56-email set, not about every inbox. Someone re-measuring on their own mail,
 * or deliberately trading urgent recall for something else, is entitled to do
 * that — they just have to say so in writing rather than discover it in three
 * weeks of silence.
 */
export const ALLOW_GATE_FAILURE_ENV = "JUDGE_MODEL_ALLOW_GATE_FAILURE";

export interface JudgeModelResolution {
  /** What the operator configured (env var, or the built-in default). */
  readonly configured: string;
  /** What the judge will actually run. */
  readonly effective: string;
  readonly verdict: JudgeModelVerdict;
  /** True when we declined the configured pin and used the recommended one. */
  readonly substituted: boolean;
  /** True when the pin fails the gate and the operator opted in anyway. */
  readonly overridden: boolean;
}

/**
 * Decide which model the judge actually runs.
 *
 * `JUDGE_MODEL` is not an ordinary knob. The judge is the one component with a
 * published contract — urgent recall at or above 90% on the committed set — and
 * a model that fails that contract is not a judge, in the same way a negative
 * ceiling is not a cost cap. So this validates the value the way we validate
 * any other external input at a boundary: reject what cannot satisfy the
 * contract, substitute a known-good default, and say so loudly.
 *
 * This is not the "amputate" the cost-cap postmortem warned about. Refusing to
 * boot would be amputation. Serving every request with a model that meets the
 * contract is the opposite — it is the degraded path staying inside the
 * promise. What we will not do is keep the failing pin *silently*: the
 * 2026-09 incident ran three weeks because nothing in the system objected.
 *
 * Pure: takes env explicitly so tests need no global mutation, and logs
 * nothing. Callers report the resolution at startup.
 */
export function resolveJudgeModel(
  configured: string,
  env: Record<string, string | undefined> = process.env,
): JudgeModelResolution {
  const verdict = judgeModelVerdict(configured);
  if (verdict.status !== "failed-gate") {
    return { configured, effective: configured, verdict, substituted: false, overridden: false };
  }

  const allowed = env[ALLOW_GATE_FAILURE_ENV] === "true";
  if (allowed) {
    return { configured, effective: configured, verdict, substituted: false, overridden: true };
  }
  return {
    configured,
    effective: RECOMMENDED_JUDGE_MODEL,
    verdict,
    substituted: true,
    overridden: false,
  };
}

/** The operator-facing message for a resolution that had to act. */
export function gateFailureMessage(resolution: JudgeModelResolution): string {
  const { configured, result } = { configured: resolution.configured, result: resolution.verdict };
  if (result.status !== "failed-gate") return "";
  const head = resolution.substituted
    ? `[JUDGE-MODEL] Declined ${configured} as the judge — our own committed eval says it fails the gate. Running ${resolution.effective} instead.`
    : `[JUDGE-MODEL] Running ${configured} as the judge even though our committed eval says it fails the gate (${ALLOW_GATE_FAILURE_ENV}=true).`;
  const lines = [
    head,
    `  Measured (eval/README.md, 2026-09-04, 3 runs each): accuracy ${result.result.accuracy}, urgent recall ${result.result.urgentRecall}, gate ${result.result.gate}.`,
    `  Mechanism: ${result.result.mechanism}.`,
    `  Effect when it runs: PUSH goes to zero while every other lane looks healthy, so nothing appears broken.`,
  ];
  if (resolution.substituted) {
    lines.push(
      `  To make this explicit, set JUDGE_MODEL=${RECOMMENDED_JUDGE_MODEL} (54/56 on all three runs, 13/13 urgent, $0.30/M).`,
      `  To keep ${configured} anyway, set ${ALLOW_GATE_FAILURE_ENV}=true — or re-run 'pnpm eval:judge' and update eval/README.md if this measurement is stale.`,
    );
  } else {
    lines.push(
      `  This is your explicit choice; nothing was substituted. Unset ${ALLOW_GATE_FAILURE_ENV} to fall back to ${RECOMMENDED_JUDGE_MODEL}.`,
    );
  }
  return lines.join("\n");
}

/**
 * Called once at boot. Emits to stderr and to Sentry so the state is visible in
 * both the place an operator looks during a deploy and the place they get
 * paged from. Never throws — a guard that can take the process down is a
 * bigger risk than the thing it guards against.
 */
export function reportJudgeModelResolution(resolution: JudgeModelResolution): void {
  if (resolution.verdict.status !== "failed-gate") return;

  try {
    console.error(gateFailureMessage(resolution));
  } catch {
    // Logging must never be the reason a boot fails.
  }
  try {
    const what = resolution.substituted ? "substituted" : "kept by operator override";
    captureError(
      new Error(
        `Judge model ${resolution.configured} fails the committed urgent-recall gate — ${what}`,
      ),
      {
        tags: {
          scope: "judge.model_fails_gate",
          configured: resolution.configured,
          effective: resolution.effective,
          substituted: String(resolution.substituted),
        },
        extra: {
          accuracy: resolution.verdict.result.accuracy,
          urgentRecall: resolution.verdict.result.urgentRecall,
          gate: resolution.verdict.result.gate,
          recommended: RECOMMENDED_JUDGE_MODEL,
        },
      },
    );
  } catch {
    // Sentry must never be the reason a boot fails.
  }
}
