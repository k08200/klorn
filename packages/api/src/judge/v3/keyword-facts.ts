/**
 * Keyword facts: facts schema v1 derived from the v2 keyword-fallback
 * detectors, for mail with no LLM facts (provider down, budget line reached,
 * mail older than the extractor). Principle 9 of the v3 doc: with the model
 * down, deterministic facts must reproduce at least today's keyword-fallback
 * lanes. `v3-keyword-parity.test.ts` holds that guarantee against the real v2
 * path (`keywordFallbackJudgement`), and lists every divergence.
 *
 * Mapping (each line mirrors one v2 branch):
 *  - clear marketing (promotions tab / marketing subject) → promotion, bulk, no asks
 *  - marketing vocabulary without a question or investor sender → newsletter
 *  - automated sender → notification; otherwise a person → personal
 *  - List-Unsubscribe → bulk when machine/marketing, group when a person (a list)
 *  - urgent vocabulary (not marketing, not a routine account confirmation)
 *      → a reply ask quoting the word. It is due at arrival only where v2's
 *      keyword rule would have pushed (an investor-looking sender); elsewhere
 *      it has no due date, so the model-down path never interrupts more, or
 *      for more senders, than v2 did (keyword words carry no real deadline)
 *  - meeting vocabulary otherwise → an attend ask with no due date
 *  - scheduling intent (the v2 MEETING detector) → event
 * Deterministic pre-facts from the extractor win over these when certain.
 */

import type { ClassifiableEmail } from "../email-classifier.js";
import {
  detectSchedulingIntent,
  isAutomatedSender,
  isClearMarketing,
  keywordSignals,
} from "../keyword-policy.js";
import { isRoutineAccountConfirmation } from "../poc-judge.js";
import type { AddressedTo, FactAsk, FactsV1, MailKind } from "./policy-types.js";

export function keywordFactsV1(email: ClassifiableEmail, receivedAt: Date): FactsV1 {
  const s = keywordSignals(email);
  const automated = isAutomatedSender(email.from || "");
  const clearMarketing = isClearMarketing(email);
  const marketing = clearMarketing || s.marketing;
  return {
    asks: marketing || isRoutineAccountConfirmation(email) ? [] : keywordAsks(s, receivedAt),
    addressedTo: clearMarketing
      ? "bulk"
      : addressedTo(email.hasListUnsubscribe === true, automated || marketing),
    threadTurn: "none",
    event: detectSchedulingIntent(email)
      ? { proposedTimes: [], hasInvite: false, conflict: null }
      : null,
    transaction: null,
    risk: [],
    kind: mailKind({
      clearMarketing,
      newsletter: s.marketing && !s.question && !s.investor,
      automated,
    }),
    ambiguous: false,
  };
}

function keywordAsks(s: ReturnType<typeof keywordSignals>, receivedAt: Date): FactAsk[] {
  if (s.urgentEvidence) {
    const due = s.investor ? receivedAt.toISOString() : null;
    return [{ kind: "reply", object: "", due, evidence: s.urgentEvidence }];
  }
  if (s.meetingEvidence) {
    return [{ kind: "attend", object: "", due: null, evidence: s.meetingEvidence }];
  }
  return [];
}

function addressedTo(listMail: boolean, machineOrMarketing: boolean): AddressedTo {
  if (!listMail) return "me_direct";
  return machineOrMarketing ? "bulk" : "group";
}

function mailKind(m: {
  clearMarketing: boolean;
  newsletter: boolean;
  automated: boolean;
}): MailKind {
  if (m.clearMarketing) return "promotion";
  if (m.newsletter) return "newsletter";
  return m.automated ? "notification" : "personal";
}
