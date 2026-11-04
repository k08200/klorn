/**
 * Fallback parity (docs/design/attention-engine-v3.md principle 9 and
 * "Fallback parity"): with no LLM facts, keyword facts through policy v3 must
 * reproduce at least today's keyword-fallback lanes.
 *
 * The v2 side is the REAL path: the marketing fast-path, then
 * `keywordFallbackJudgement` (keyword features → v2 rule → floors). The
 * corpus is the full cross product of the signals those detectors read.
 * The guarantees and the documented divergence classes live in v3/parity.ts
 * (shared with the replay CLI).
 */

import { describe, expect, it } from "vitest";
import type { ClassifiableEmail } from "../judge/email-classifier.js";
import { isClearMarketing } from "../judge/keyword-policy.js";
import { hasSpamLabel, keywordFallbackJudgement } from "../judge/poc-judge.js";
import { toLiveTier } from "../judge/tiers.js";
import { keywordFactsV1 } from "../judge/v3/keyword-facts.js";
import { classifyParityDivergence, parityViolation } from "../judge/v3/parity.js";
import { laneFromFactsV3 } from "../judge/v3/policy.js";

const RECEIVED = new Date("2026-10-30T23:00:00.000Z");

const FROMS = [
  "Jane Kim <jane@acme.com>",
  "Pat Lee <pat@acmeventures.com>",
  "Acme <noreply@acme.com>",
  "GitHub <notifications@github.com>",
  "Shop <orders@shop.com>",
  "Weekly <newsletter@media.com>",
  "Card <refund@capitalone.com>",
];
const SUBJECTS = [
  "Project update",
  "Need this today",
  "오늘 6시까지 회신 필요",
  "Zoom call notes",
  "Can we reschedule our sync?",
  "Invitation: Board sync @ Tue Oct 27, 2026 10am",
  "Could you take a look?",
  "Our newsletter is here",
  "Newsletter: are you in?",
  "New sign-in from Chrome on Mac",
  "Unusual sign-in — was this you?",
  "[광고] 가을 할인 쿠폰",
  "Action required: verify your account",
];
const SNIPPETS = ["", "please confirm by tomorrow", "we can meet next week"];
const LABEL_SETS: string[][] = [[], ["CATEGORY_PROMOTIONS"], ["SPAM"], ["CATEGORY_SOCIAL"]];
const BODIES = ["", "Join: https://meet.google.com/abc-defg-hij"];

function* corpus(): Generator<ClassifiableEmail> {
  for (const from of FROMS)
    for (const subject of SUBJECTS)
      for (const snippet of SNIPPETS)
        for (const labels of LABEL_SETS)
          for (const hasListUnsubscribe of [false, true])
            for (const body of BODIES)
              yield { from, subject, snippet, labels, hasListUnsubscribe, body };
}

const rows = [...corpus()].map((email) => {
  const facts = keywordFactsV1(email, RECEIVED);
  const spam = hasSpamLabel(email.labels);
  const v2 = isClearMarketing(email)
    ? ("SILENT" as const)
    : toLiveTier(keywordFallbackJudgement(email).tier);
  const decision = laneFromFactsV3({ facts, relationship: null, spam, decidedAt: RECEIVED });
  return { email, facts, spam, v2, decision };
});

describe("keyword facts → policy v3 parity with the v2 keyword fallback", () => {
  it("covers the full signal cross product", () => {
    expect(rows.length).toBe(
      FROMS.length * SUBJECTS.length * SNIPPETS.length * LABEL_SETS.length * 2 * BODIES.length,
    );
  });

  it("breaks none of (a) no hiding, (b) no lost PUSH, (c) no machine PUSH, (d) no new PUSH", () => {
    for (const r of rows) {
      const violation = parityViolation({
        v2: r.v2,
        v3: r.decision.lane,
        v3PushCandidate: r.decision.pushCandidate,
        facts: r.facts,
        spam: r.spam,
      });
      expect(violation, JSON.stringify(r.email)).toBeNull();
    }
  });

  it("every other difference is a documented divergence", () => {
    const counts: Record<string, number> = {};
    for (const r of rows) {
      const cls = classifyParityDivergence(r.v2, r.decision.lane, r.facts);
      if (cls === null) continue;
      expect(cls, `${r.v2} → ${r.decision.lane}: ${JSON.stringify(r.email)}`).not.toBe(
        "unclassified",
      );
      const key = `${cls}: ${r.v2}→${r.decision.lane}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    // Pinned: the doc's divergence table (§3(5) "Fallback parity") must match.
    expect(counts).toEqual({
      "bulkScheduling: MEETING→QUEUE": 218,
      "bulkScheduling: MEETING→INFO": 102,
      "bulkScheduling: MEETING→SILENT": 52,
      "bulkScheduling: QUEUE→INFO": 51,
      "bulkScheduling: QUEUE→SILENT": 26,
      "machineListFiled: QUEUE→INFO": 117,
      "listNeverInterrupts: PUSH→QUEUE": 52,
    });
  });

  it("the guarantees reject real regressions (the checker is not vacuous)", () => {
    const facts = rows[0].facts;
    const personal = { ...facts, kind: "personal" as const, addressedTo: "me_direct" as const };
    expect(
      parityViolation({
        v2: "QUEUE",
        v3: "SILENT",
        v3PushCandidate: false,
        facts: personal,
        spam: false,
      }),
    ).toBe("hidden");
    expect(
      parityViolation({
        v2: "PUSH",
        v3: "QUEUE",
        v3PushCandidate: false,
        facts: personal,
        spam: false,
      }),
    ).toBe("lostPush");
    expect(
      parityViolation({
        v2: "QUEUE",
        v3: "PUSH",
        v3PushCandidate: true,
        facts: { ...personal, kind: "notification" },
        spam: false,
      }),
    ).toBe("machinePush");
    expect(
      parityViolation({
        v2: "QUEUE",
        v3: "PUSH",
        v3PushCandidate: true,
        facts: personal,
        spam: true,
      }),
    ).toBe("machinePush");
    expect(
      parityViolation({
        v2: "QUEUE",
        v3: "PUSH",
        v3PushCandidate: true,
        facts: personal,
        spam: false,
      }),
    ).toBe("newPush");
    expect(classifyParityDivergence("INFO", "PUSH", personal)).toBe("unclassified");
  });
});
