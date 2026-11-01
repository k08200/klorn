/**
 * Post-processing of a validated model answer (facts v1): the absolute-date
 * window and the merge where certain deterministic pre-facts win. Pure; every
 * function returns new objects (repo rule: never mutate inputs).
 */

import type { FactsV1 } from "./facts-schema.js";
import type { PreFacts } from "./pre-facts.js";

const DAY_MS = 86_400_000;
/** A due date this far before the mail is not a reading of this mail. */
export const DUE_WINDOW_PAST_DAYS = 60;
/** …nor one more than this far after it. */
export const DUE_WINDOW_FUTURE_DAYS = 400;

function withinWindow(iso: string, mailMs: number): boolean {
  const t = Date.parse(iso);
  return (
    t >= mailMs - DUE_WINDOW_PAST_DAYS * DAY_MS && t <= mailMs + DUE_WINDOW_FUTURE_DAYS * DAY_MS
  );
}

/** Drop dates that cannot be a reading of this mail. With no valid mail date
 * nothing anchors them, so every date is dropped (fail closed). */
export function enforceDateWindow(
  facts: FactsV1,
  mailDate: Date,
): { facts: FactsV1; issues: string[] } {
  const mailMs = mailDate.getTime();
  const copy: FactsV1 = {
    ...facts,
    asks: facts.asks.map((a) => ({ ...a })),
    event: facts.event ? { ...facts.event, proposedTimes: [...facts.event.proposedTimes] } : null,
    risk: [...facts.risk],
  };
  if (Number.isNaN(mailMs)) {
    return {
      facts: {
        ...copy,
        asks: copy.asks.map((a) => ({ ...a, due: null })),
        event: copy.event ? { ...copy.event, proposedTimes: [] } : null,
      },
      issues: ["mail date invalid: dates dropped"],
    };
  }
  const issues: string[] = [];
  const asks = copy.asks.map((a, i) => {
    if (a.due === null || withinWindow(a.due, mailMs)) return a;
    issues.push(`asks[${i}].due: outside the plausible window of the mail date`);
    return { ...a, due: null };
  });
  const event = copy.event
    ? {
        ...copy.event,
        proposedTimes: copy.event.proposedTimes.filter((t, i) => {
          if (withinWindow(t, mailMs)) return true;
          issues.push(`event.proposedTimes[${i}]: outside the plausible window of the mail date`);
          return false;
        }),
      }
    : null;
  return { facts: { ...copy, asks, event }, issues };
}

function mergeEvent(llm: FactsV1["event"], pre: PreFacts): FactsV1["event"] {
  const ics = pre.certain.includes("event") ? pre.facts.event : undefined;
  const base = ics ?? llm;
  if (!base) return null;
  return {
    proposedTimes: [...(llm?.proposedTimes ?? base.proposedTimes)],
    // Only an attached calendar file is an invite. Mail text (a subject that
    // reads "Invitation: …", or the model reading one) is attacker-writable.
    hasInvite: Boolean(ics),
    // Conflict comes from the calendar read, never from the mail text.
    conflict: null,
  };
}

/** Certain pre-facts replace the model's value; the event merges field by field. */
export function mergeWithPreFacts(llm: FactsV1, pre: PreFacts): FactsV1 {
  const fixed: Partial<FactsV1> = {};
  for (const field of pre.certain) {
    if (field === "event") continue;
    Object.assign(fixed, { [field]: pre.facts[field] });
  }
  return {
    ...llm,
    ...fixed,
    asks: (fixed.asks ?? llm.asks).map((a) => ({ ...a })),
    risk: [...(fixed.risk ?? llm.risk)],
    event: mergeEvent(llm.event, pre),
  };
}
