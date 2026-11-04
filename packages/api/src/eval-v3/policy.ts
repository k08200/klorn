/**
 * Facts → lane, doc §3(4), for the P1 benchmark only. Deterministic and pure.
 *
 * Deliberately left out (they need data the eval sets do not carry, and P3
 * owns them): per-user importance / top-k, the daily interrupt budget, QUEUE
 * ranking. So "PUSH" here means "a PUSH candidate under the doc's rule".
 * The deadline window is measured from the mail's Date header — the eval's
 * "now" — not from wall-clock time.
 *
 * Precedence follows the doc's order: PUSH, MEETING, QUEUE, INFO, SILENT,
 * then the v2 default (QUEUE). A Gmail spam label never interrupts or
 * schedules (the v2 spam floor, a deterministic pre-fact).
 */
import type { Tier } from "../judge/tiers.js";
import type { FactsV1, Risk } from "./facts-schema.js";

const PUSH_DEADLINE_MS = 24 * 60 * 60 * 1000;
const PUSH_RISKS: ReadonlySet<Risk> = new Set(["payment_failed", "security_alert"]);

export type PolicyRule =
  | "push:deadline"
  | "push:risk"
  | "meeting"
  | "queue:ask"
  | "queue:conversation"
  | "info"
  | "silent"
  | "default";

export interface PolicyDecision {
  lane: Tier;
  rule: PolicyRule;
}

export interface PolicyContext {
  /** The mail's Date header. */
  receivedAt: Date;
  /** Gmail SPAM label present. */
  spam: boolean;
}

function hasDeadlineWithin24h(facts: FactsV1, receivedAt: Date): boolean {
  const limit = receivedAt.getTime() + PUSH_DEADLINE_MS;
  return facts.asks.some((a) => a.due !== null && Date.parse(a.due) <= limit);
}

function pushRule(facts: FactsV1, ctx: PolicyContext): PolicyRule | null {
  if (ctx.spam) return null;
  if (facts.addressedTo !== "me_direct" && facts.addressedTo !== "me_cc") return null;
  if (hasDeadlineWithin24h(facts, ctx.receivedAt)) return "push:deadline";
  if (facts.risk.some((r) => PUSH_RISKS.has(r))) return "push:risk";
  return null;
}

export function laneFromFacts(facts: FactsV1, ctx: PolicyContext): PolicyDecision {
  const push = pushRule(facts, ctx);
  if (push) return { lane: "PUSH", rule: push };

  if (facts.event && facts.addressedTo !== "bulk" && !ctx.spam) {
    return { lane: "MEETING", rule: "meeting" };
  }

  if (facts.asks.length > 0) return { lane: "QUEUE", rule: "queue:ask" };
  if (
    facts.kind === "personal" ||
    facts.kind === "work_thread" ||
    facts.threadTurn === "mine_to_reply"
  ) {
    return { lane: "QUEUE", rule: "queue:conversation" };
  }

  // No asks past this point, so "notification without asks" is just the kind.
  if ((facts.transaction && !facts.transaction.actionRequired) || facts.kind === "notification") {
    return { lane: "INFO", rule: "info" };
  }

  if (facts.addressedTo === "bulk" || facts.kind === "newsletter" || facts.kind === "promotion") {
    return { lane: "SILENT", rule: "silent" };
  }

  return { lane: "QUEUE", rule: "default" };
}
