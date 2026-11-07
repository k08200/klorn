/**
 * Fallback parity (docs/design/attention-engine-v3.md principle 9, "Fallback
 * parity"): how a policy v3 lane over keyword facts may differ from the v2
 * keyword-fallback lane for the same mail. Shared by the parity test and the
 * replay CLI so the documented classes are defined once.
 *
 * Guarantees, checked by `parityViolation`:
 *  (a) nothing v2 shows becomes SILENT, except bulk scheduling mail (#1497);
 *  (b) every v2 PUSH stays a v3 PUSH candidate, except list mail;
 *  (c) machine, marketing and spam mail never become a PUSH candidate;
 *  (d) nothing becomes a PUSH candidate that v2 did not notify for: v2 PUSH,
 *      or v2 MEETING, which notifies too (the model-down path never
 *      interrupts more, or for more senders, than v2).
 * Every other difference must belong to one of `PARITY_DIVERGENCES`.
 */

import type { LiveTier } from "@klorn/contract";
import type { FactsV1 } from "./policy-types.js";

const isList = (f: FactsV1) => f.addressedTo === "group" || f.addressedTo === "bulk";

type DivergenceTest = (v2: LiveTier, v3: LiveTier, f: FactsV1) => boolean;

export const PARITY_DIVERGENCES = {
  // MEETING requires "not bulk" (§3(4)); v2 let bulk invites into a lane that
  // notifies (#1497). v2 QUEUE here is the same scheduling branch after its spam floor.
  bulkScheduling: (v2, _v3, f) =>
    (v2 === "MEETING" || v2 === "QUEUE") && f.event !== null && f.addressedTo === "bulk",
  // PUSH requires the mail to be addressed to me; v2 could PUSH list mail.
  listNeverInterrupts: (v2, v3, f) => v2 === "PUSH" && v3 === "QUEUE" && isList(f),
  // Machine list mail with nothing asked is filed (INFO) instead of queued; still visible.
  machineListFiled: (v2, v3, f) =>
    v2 === "QUEUE" &&
    v3 === "INFO" &&
    f.kind === "notification" &&
    f.addressedTo === "bulk" &&
    f.asks.length === 0,
  // v3.1 checks PUSH before MEETING: a due-soon ask wins over the event. v2
  // notified for it as MEETING already, so no new interrupt.
  pushBeforeMeeting: (v2, v3, f) => v2 === "MEETING" && v3 === "PUSH" && f.event !== null,
  // v3.1 keeps SILENT for clear marketing only (the LOCKED narrow-SILENT rule):
  // newsletters and other bulk mail are filed in INFO, still visible.
  narrowSilent: (v2, v3, f) =>
    v2 === "SILENT" &&
    v3 === "INFO" &&
    (f.kind === "newsletter" || (f.addressedTo === "bulk" && f.kind !== "promotion")),
} satisfies Record<string, DivergenceTest>;

export type ParityDivergence = keyof typeof PARITY_DIVERGENCES;

/** The documented class a difference belongs to, or null when the lanes agree. "unclassified" is a bug. */
export function classifyParityDivergence(
  v2: LiveTier,
  v3: LiveTier,
  facts: FactsV1,
): ParityDivergence | "unclassified" | null {
  if (v2 === v3) return null;
  const hit = (
    Object.entries(PARITY_DIVERGENCES) as Array<[ParityDivergence, DivergenceTest]>
  ).find(([, test]) => test(v2, v3, facts));
  return hit ? hit[0] : "unclassified";
}

export type ParityViolation = "hidden" | "lostPush" | "machinePush" | "newPush";

/** Which guarantee (a)–(d) a keyword-path decision breaks, if any. */
export function parityViolation(input: {
  v2: LiveTier;
  v3: LiveTier;
  v3PushCandidate: boolean;
  facts: FactsV1;
  spam: boolean;
}): ParityViolation | null {
  const { v2, v3, facts } = input;
  if (v2 !== "SILENT" && v3 === "SILENT" && !PARITY_DIVERGENCES.bulkScheduling(v2, v3, facts)) {
    return "hidden";
  }
  if (
    v2 === "PUSH" &&
    !input.v3PushCandidate &&
    !PARITY_DIVERGENCES.listNeverInterrupts(v2, v3, facts)
  ) {
    return "lostPush";
  }
  if (input.v3PushCandidate && (facts.kind !== "personal" || input.spam)) return "machinePush";
  if (input.v3PushCandidate && v2 !== "PUSH" && v2 !== "MEETING") return "newPush";
  return null;
}
