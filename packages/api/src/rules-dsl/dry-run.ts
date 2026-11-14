/**
 * Rules DSL v1 dry-run, pure part: what the proposed rules would change on
 * mail Klorn already judged, compared with what the CURRENT rules give.
 * Uses the judge's own pin matcher (mail/pin-match.ts). It does not run the
 * judge: a mail whose pin the text removes is reported as going back to the
 * judge (`to: null`), not with a guessed lane. The interrupt budget is not
 * modelled. A mail the user moved by hand keeps its lane, as in policy v3.
 */

import { toLiveTier } from "../judge/tiers.js";
import { type PinRuleLike, pinnedTierFromRules } from "../mail/pin-match.js";
import { senderKey } from "./compile.js";
import { type RuleInventory, type StoredEmailRule, sameRule, toRuleRow } from "./inventory.js";
import type { CompiledRule, DslLane } from "./types.js";

export const DRY_RUN_SAMPLE_LIMIT = 20;
const SUBJECT_CHARS = 80;

export interface DryRunMail {
  id: string;
  /** The parsed sender address, lowercased; "" when the From had none. */
  sender: string;
  subject: string;
  /** The lane the mail holds now. */
  lane: DslLane;
  /** The user moved this mail by hand: a pin never overrides that. */
  manual: boolean;
}

export interface DryRunTransition {
  from: DslLane;
  /** null = back to the judge (the pin that decided it is gone). */
  to: DslLane | null;
  count: number;
}

export interface DryRunSample {
  id: string;
  sender: string;
  subject: string;
  from: DslLane;
  to: DslLane | null;
}

export interface DryRunResult {
  examined: number;
  changed: number;
  manualKept: number;
  transitions: DryRunTransition[];
  samples: DryRunSample[];
}

function newestFirst(a: StoredEmailRule, b: StoredEmailRule): number {
  return b.updatedAt.getTime() - a.updatedAt.getTime();
}

/** The pins the judge reads today: active PIN_TIER rows, newest first. */
export function currentPinRules(rows: readonly StoredEmailRule[]): PinRuleLike[] {
  return rows.filter((r) => r.actionType === "PIN_TIER" && r.isActive).sort(newestFirst);
}

/**
 * The pins the judge would read after apply, newest first as it reads them: a
 * rule apply leaves untouched keeps its row's updatedAt, a created or changed
 * one is written at `now`, and every PIN_TIER row apply keeps as-is stays in.
 */
export function proposedPinRules(
  rules: readonly CompiledRule[],
  inventory: RuleInventory,
  now: Date,
): PinRuleLike[] {
  const existing = new Map(inventory.editable.map((rule) => [senderKey(rule), rule]));
  const fromText = rules
    .filter((rule) => rule.isActive)
    .map((rule) => {
      const row = existing.get(senderKey(rule));
      const updatedAt = row && sameRule(row, rule) ? row.updatedAt : now;
      return { ...toRuleRow(rule), updatedAt };
    });
  const kept = inventory.keptPins.filter((row) => row.isActive);
  return [...fromText, ...kept].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

function laneOf(rules: readonly PinRuleLike[], sender: string): DslLane | null {
  const tier = pinnedTierFromRules(rules, sender);
  return tier ? toLiveTier(tier) : null;
}

function shortSubject(subject: string): string {
  return subject.length > SUBJECT_CHARS ? `${subject.slice(0, SUBJECT_CHARS)}…` : subject;
}

export function dryRunRules(input: {
  current: readonly PinRuleLike[];
  proposed: readonly PinRuleLike[];
  mails: readonly DryRunMail[];
  sampleLimit?: number;
}): DryRunResult {
  const sampleLimit = input.sampleLimit ?? DRY_RUN_SAMPLE_LIMIT;
  const counts = new Map<string, DryRunTransition>();
  const samples: DryRunSample[] = [];
  let changed = 0;
  let manualKept = 0;
  for (const mail of input.mails) {
    if (mail.manual) {
      manualKept += 1;
      continue;
    }
    const now = laneOf(input.current, mail.sender);
    const next = laneOf(input.proposed, mail.sender);
    const from = now ?? mail.lane;
    const to = next ?? (now ? null : from);
    if (to === from) continue;
    changed += 1;
    const key = `${from}>${to ?? ""}`;
    const entry = counts.get(key) ?? { from, to, count: 0 };
    counts.set(key, { ...entry, count: entry.count + 1 });
    if (samples.length < sampleLimit) {
      samples.push({
        id: mail.id,
        sender: mail.sender,
        subject: shortSubject(mail.subject),
        from,
        to,
      });
    }
  }
  const transitions = [...counts.values()].sort(
    (a, b) =>
      b.count - a.count ||
      (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) ||
      ((a.to ?? "~") < (b.to ?? "~") ? -1 : 1),
  );
  return { examined: input.mails.length, changed, manualKept, transitions, samples };
}
