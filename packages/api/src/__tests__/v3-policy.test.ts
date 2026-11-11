/**
 * Policy v3 (docs/design/attention-engine-v3.md §3(4), "Policy v3.0: exact
 * evaluation"). Example tests pin each rule; property tests run the seeded
 * generator over thousands of fact combinations and assert the invariants the
 * founder relies on before flipping JUDGE_V3_POLICY.
 */

import { describe, expect, it } from "vitest";
import { toLiveTier } from "../judge/tiers.js";
import {
  isFirstContact,
  laneFromFactsUnderRules,
  laneFromFactsV3,
  POLICY_VERSION,
  POLICY_VERSIONS,
  policyRules,
  RISK_TRUST_MIN_HISTORY_MS,
  RISK_TRUST_MIN_INBOUND,
} from "../judge/v3/policy.js";
import type { FactsV1, RelationshipSnapshot } from "../judge/v3/policy-types.js";
import { UNKNOWN_RELATIONSHIP } from "../judge/v3/relationship.js";
import {
  genFacts,
  genRelationship,
  genTierOrNull,
  mulberry32,
  pick,
} from "./helpers/v3-facts-gen.js";

const NOW = new Date("2026-10-31T09:00:00.000Z");
const HOUR = 3_600_000;
const inHours = (h: number) => new Date(NOW.getTime() + h * HOUR).toISOString();

const base: FactsV1 = {
  asks: [],
  addressedTo: "me_direct",
  threadTurn: "none",
  event: null,
  transaction: null,
  risk: [],
  kind: "personal",
  ambiguous: false,
};
const facts = (over: Partial<FactsV1>): FactsV1 => ({ ...base, ...over });
const noRelationship = UNKNOWN_RELATIONSHIP;
const decide = (f: FactsV1, extra: Partial<Parameters<typeof laneFromFactsV3>[0]> = {}) =>
  laneFromFactsV3({ facts: f, relationship: null, decidedAt: NOW, ...extra });

const replyAsk = (due: string | null, evidence = "can you confirm by 5pm") => ({
  kind: "reply" as const,
  object: "confirm",
  due,
  evidence,
});

describe("laneFromFactsV3 — rules", () => {
  it("stamps the policy version that decided, v3.1 by default", () => {
    expect(decide(base).policyVersion).toBe(POLICY_VERSION);
    expect(POLICY_VERSION).toBe("v3.1");
    expect(decide(base, { version: "v3.0" }).policyVersion).toBe("v3.0");
    // Untyped input (a stored or env string): an unknown name runs the live rules.
    for (const bad of ["v9", "constructor", "__proto__", "toString"]) {
      expect(decide(base, { version: bad as never }).policyVersion).toBe(POLICY_VERSION);
    }
  });

  it("PUSH: an ask due within 24h, addressed to me, from a person", () => {
    const d = decide(facts({ asks: [replyAsk(inHours(5))] }));
    expect(d.lane).toBe("PUSH");
    expect(d.pushCandidate).toBe(true);
    expect(d.reasons[0]).toMatchObject({
      code: "ask_due_soon",
      fact: "asks[0]",
      evidence: "can you confirm by 5pm",
      params: { askKind: "reply", due: inHours(5) },
    });
    expect(d.reasons[1]).toMatchObject({
      code: "addressed_to_me",
      params: { addressedTo: "me_direct" },
    });
  });

  it("PUSH: an ask overdue by up to 24h counts as due soon; an older one is stale and queues", () => {
    expect(decide(facts({ asks: [replyAsk(inHours(-5))] })).lane).toBe("PUSH");
    expect(decide(facts({ asks: [replyAsk(inHours(-24))] })).lane).toBe("PUSH");
    expect(decide(facts({ asks: [replyAsk(inHours(-30))] })).lane).toBe("QUEUE");
  });

  it("PUSH picks the earliest qualifying ask as the deciding evidence", () => {
    const d = decide(
      facts({ asks: [replyAsk(inHours(20), "later one"), replyAsk(inHours(2), "sooner one")] }),
    );
    expect(d.reasons[0]).toMatchObject({ fact: "asks[1]", evidence: "sooner one" });
  });

  it("an ask due in more than 24h is QUEUE, not PUSH", () => {
    const d = decide(facts({ asks: [replyAsk(inHours(25))] }));
    expect(d.lane).toBe("QUEUE");
    expect(d.reasons[0]).toMatchObject({ code: "ask", fact: "asks[0]" });
  });

  it("an ask with no due date is QUEUE", () => {
    expect(decide(facts({ asks: [replyAsk(null)] })).lane).toBe("QUEUE");
  });

  it("an unparseable due date never makes a PUSH", () => {
    expect(decide(facts({ asks: [replyAsk("tomorrow-ish")] })).lane).toBe("QUEUE");
  });

  const vipSender = { ...noRelationship, vip: true };

  it("PUSH: payment_failed or security_alert from a VIP sender, addressed to me", () => {
    for (const risk of ["payment_failed", "security_alert"] as const) {
      const d = decide(facts({ risk: [risk], kind: "notification" }), {
        relationship: vipSender,
      });
      expect(d.lane).toBe("PUSH");
      expect(d.reasons[0]).toMatchObject({
        code: "risk",
        fact: "risk",
        params: { risk, trusted: true },
      });
    }
  });

  it("a VIP address whose From failed DMARC is not trusted: a forged VIP never interrupts", () => {
    const f = facts({ risk: ["payment_failed"], kind: "notification" });
    const forged = decide(f, { relationship: vipSender, senderAuthenticated: false });
    expect(forged.lane).toBe("QUEUE");
    expect(forged.reasons[0]).toMatchObject({ params: { risk: "payment_failed", trusted: false } });
    // No verdict (some providers report none) is not a failure.
    expect(decide(f, { relationship: vipSender, senderAuthenticated: null }).lane).toBe("PUSH");
    expect(decide(f, { relationship: vipSender, senderAuthenticated: true }).lane).toBe("PUSH");
  });

  it("risk carries no evidence: from anyone but a VIP it queues instead", () => {
    // Past sends are not trust: Klorn's own auto-replies land in sent mail too.
    for (const relationship of [
      null,
      noRelationship,
      { ...noRelationship, sentCount: 0, sameOrgDomain: true },
      { ...noRelationship, sentCount: 12, lastSentAt: inHours(-24) },
    ]) {
      const d = decide(facts({ risk: ["payment_failed"], kind: "notification" }), { relationship });
      expect(d.lane).toBe("QUEUE");
      expect(d.pushCandidate).toBe(false);
      expect(d.reasons[0]).toMatchObject({
        code: "risk",
        params: { risk: "payment_failed", trusted: false },
      });
    }
  });

  it("a payment risk under a phishing suspicion stays visible in QUEUE, never filed or hidden", () => {
    for (const kind of ["notification", "newsletter"] as const) {
      const d = decide(facts({ kind, risk: ["payment_failed", "phishing_suspect"] }));
      expect(d.lane).toBe("QUEUE");
      expect(d.reasons[0]).toMatchObject({ code: "risk", params: { risk: "payment_failed" } });
      expect(d.reasons).toContainEqual(
        expect.objectContaining({ params: { risk: "phishing_suspect" } }),
      );
    }
  });

  it("phishing_suspect vetoes PUSH on both paths and is surfaced as a reason", () => {
    const viaRisk = decide(facts({ risk: ["security_alert", "phishing_suspect"] }), {
      relationship: vipSender,
    });
    expect(viaRisk.pushCandidate).toBe(false);
    const viaAsk = decide(facts({ risk: ["phishing_suspect"], asks: [replyAsk(inHours(1))] }));
    expect(viaAsk.lane).toBe("QUEUE");
    expect(viaAsk.reasons).toContainEqual(
      expect.objectContaining({ code: "risk", params: { risk: "phishing_suspect" } }),
    );
  });

  it("a receipt never interrupts through an ask (a fake invoice is machine mail)", () => {
    const d = decide(facts({ kind: "receipt", asks: [{ ...replyAsk(inHours(2)), kind: "pay" }] }));
    expect(d.lane).toBe("QUEUE");
    expect(d.pushCandidate).toBe(false);
  });

  it("an automated sender never interrupts through an ask, whatever kind the model said", () => {
    const d = decide(facts({ kind: "personal", asks: [replyAsk(inHours(1))] }), {
      automatedSender: true,
    });
    expect(d.lane).toBe("QUEUE");
    const viaRisk = decide(facts({ kind: "notification", risk: ["security_alert"] }), {
      automatedSender: true,
      relationship: vipSender,
    });
    expect(viaRisk.lane).toBe("PUSH");
  });

  it("a phishing-suspect invite never lands MEETING", () => {
    const d = decide(
      facts({
        risk: ["phishing_suspect"],
        event: { proposedTimes: [], hasInvite: true, conflict: null },
      }),
    );
    expect(d.lane).toBe("QUEUE");
    expect(d.reasons[0]).toMatchObject({ code: "risk", params: { risk: "phishing_suspect" } });
    expect(d.reasons.filter((r) => r.params.risk === "phishing_suspect")).toHaveLength(1);
  });

  it("account_change alone never interrupts", () => {
    expect(decide(facts({ risk: ["account_change"], kind: "notification" })).lane).toBe("INFO");
  });

  it("v3.0: machine mail interrupts only through risk; a due ask from a notification is QUEUE", () => {
    for (const kind of ["notification", "newsletter", "promotion"] as const) {
      const d = decide(facts({ kind, asks: [replyAsk(inHours(1))] }), { version: "v3.0" });
      expect(d.lane).toBe("QUEUE");
      expect(d.pushCandidate).toBe(false);
    }
  });

  it("v3.1: a notification may interrupt through a due ask, unless the sender is automated", () => {
    const ask = facts({ kind: "notification", asks: [replyAsk(inHours(1))] });
    expect(decide(ask).lane).toBe("PUSH");
    expect(decide(ask, { automatedSender: true }).lane).toBe("QUEUE");
    // Newsletters and promotions still never interrupt through an ask.
    for (const kind of ["newsletter", "promotion"] as const) {
      expect(decide(facts({ kind, asks: [replyAsk(inHours(1))] })).pushCandidate).toBe(false);
    }
  });

  // A sender that has mailed the user often, for a while (v3.1 risk trust).
  const known = (over: Partial<RelationshipSnapshot> = {}): RelationshipSnapshot => ({
    ...noRelationship,
    inboundCount: RISK_TRUST_MIN_INBOUND,
    firstSeenAt: new Date(NOW.getTime() - RISK_TRUST_MIN_HISTORY_MS - HOUR).toISOString(),
    ...over,
  });

  it("v3.1: a risk-only PUSH trusts a known correspondent whose From passed DMARC", () => {
    const risky = facts({ risk: ["payment_failed"], kind: "notification" });
    const ok = decide(risky, { senderAuthenticated: true, relationship: known() });
    expect(ok.lane).toBe("PUSH");
    expect(ok.reasons[0]).toMatchObject({
      code: "risk",
      params: { risk: "payment_failed", trusted: true },
    });
    // v3.0 trusted a VIP only.
    expect(
      decide(risky, { senderAuthenticated: true, relationship: known(), version: "v3.0" }).lane,
    ).toBe("QUEUE");
  });

  it("v3.1: DMARC alone is not trust: a fresh webmail account or an attacker's own domain passes it", () => {
    const risky = facts({ risk: ["security_alert"], kind: "notification" });
    const cases: Array<[string, Partial<Parameters<typeof decide>[1]>]> = [
      ["no relationship", { senderAuthenticated: true, relationship: null }],
      ["too few mails", { senderAuthenticated: true, relationship: known({ inboundCount: 2 }) }],
      [
        "too recent",
        {
          senderAuthenticated: true,
          relationship: known({
            firstSeenAt: new Date(NOW.getTime() - 2 * 24 * HOUR).toISOString(),
          }),
        },
      ],
      [
        "no first-seen date",
        { senderAuthenticated: true, relationship: known({ firstSeenAt: null }) },
      ],
      ["DMARC failed", { senderAuthenticated: false, relationship: known() }],
      ["no verdict", { senderAuthenticated: null, relationship: known() }],
    ];
    for (const [name, extra] of cases) {
      const d = decide(risky, extra);
      expect(d.lane, name).toBe("QUEUE");
      expect(d.reasons[0]?.params.trusted, name).toBe(false);
    }
  });

  it("v3.1: never risk trust for an ambiguous fact set, a promotion or a newsletter", () => {
    for (const f of [
      facts({ risk: ["payment_failed"], kind: "notification", ambiguous: true }),
      facts({ risk: ["payment_failed"], kind: "promotion" }),
      facts({ risk: ["payment_failed"], kind: "newsletter" }),
    ]) {
      expect(decide(f, { senderAuthenticated: true, relationship: known() }).lane).toBe("QUEUE");
    }
  });

  it("a risk under a phishing suspicion is QUEUE and never reads as trusted", () => {
    const phish = facts({ risk: ["payment_failed", "phishing_suspect"], kind: "notification" });
    for (const relationship of [known(), { ...noRelationship, vip: true }]) {
      const d = decide(phish, { senderAuthenticated: true, relationship });
      expect(d.lane).toBe("QUEUE");
      expect(d.reasons[0]).toMatchObject({ code: "risk", params: { trusted: false } });
    }
  });

  it("v3.1: a notification ask whose From failed DMARC never interrupts", () => {
    const ask = facts({ kind: "notification", asks: [replyAsk(inHours(1))] });
    expect(decide(ask, { senderAuthenticated: false }).lane).toBe("QUEUE");
    expect(decide(ask, { senderAuthenticated: null }).lane).toBe("PUSH");
  });

  it("v3.1: spam keeps an urgent invite out of PUSH and MEETING", () => {
    const event = { proposedTimes: [inHours(3)], hasInvite: true, conflict: null };
    const d = decide(facts({ event, asks: [replyAsk(inHours(1))] }), { spam: true });
    expect(d.lane).toBe("QUEUE");
    expect(d.reasons[0]?.code).toBe("spam_floor");
  });

  it("PUSH needs addressedTo me_direct or me_cc", () => {
    expect(decide(facts({ addressedTo: "me_cc", asks: [replyAsk(inHours(1))] })).lane).toBe("PUSH");
    expect(decide(facts({ addressedTo: "group", asks: [replyAsk(inHours(1))] })).lane).toBe(
      "QUEUE",
    );
    expect(
      decide(facts({ addressedTo: "bulk", risk: ["security_alert"] }), {
        relationship: vipSender,
      }).lane,
    ).not.toBe("PUSH");
  });

  it("MEETING: an event not sent in bulk", () => {
    const event = { proposedTimes: [inHours(3)], hasInvite: true, conflict: true };
    const d = decide(facts({ event, asks: [replyAsk(null)] }));
    expect(d.lane).toBe("MEETING");
    expect(d.pushCandidate).toBe(false);
    expect(d.reasons[0]).toMatchObject({
      code: "event",
      fact: "event",
      params: { conflict: true },
    });
  });

  it("v3.0 checks MEETING before PUSH; v3.1 lets a due-soon ask win over the event", () => {
    const event = { proposedTimes: [inHours(3)], hasInvite: true, conflict: true };
    const urgentInvite = facts({ event, asks: [replyAsk(inHours(1))] });
    expect(decide(urgentInvite, { version: "v3.0" }).lane).toBe("MEETING");
    const d = decide(urgentInvite);
    expect(d.lane).toBe("PUSH");
    expect(d.reasons[0]?.code).toBe("ask_due_soon");
    // A phishing-suspect invite is still neither PUSH nor MEETING.
    const phish = decide(
      facts({ event, asks: [replyAsk(inHours(1))], risk: ["phishing_suspect"] }),
    );
    expect(phish.lane).toBe("QUEUE");
  });

  it("a bulk event is not a MEETING", () => {
    const event = { proposedTimes: [], hasInvite: false, conflict: null };
    const bulkNewsletter = facts({ event, addressedTo: "bulk", kind: "newsletter" });
    expect(decide(bulkNewsletter, { version: "v3.0" }).lane).toBe("SILENT");
    expect(decide(bulkNewsletter).lane).toBe("INFO");
  });

  it("QUEUE: personal/work_thread kind, my turn to reply, or a transaction needing action", () => {
    expect(decide(facts({ kind: "work_thread" })).reasons[0]).toMatchObject({
      code: "kind",
      params: { kind: "work_thread" },
    });
    expect(decide(facts({ kind: "notification", threadTurn: "mine_to_reply" })).lane).toBe("QUEUE");
    const tx = decide(
      facts({ kind: "notification", transaction: { kind: "invoice", actionRequired: true } }),
    );
    expect(tx.lane).toBe("QUEUE");
    expect(tx.reasons[0]).toMatchObject({
      code: "transaction_action",
      params: { transactionKind: "invoice" },
    });
  });

  it("INFO: a transaction record, or a notification/receipt with no asks", () => {
    const rec = decide(
      facts({ kind: "receipt", transaction: { kind: "receipt", actionRequired: false } }),
    );
    expect(rec.lane).toBe("INFO");
    expect(rec.reasons[0]).toMatchObject({
      code: "transaction_record",
      params: { transactionKind: "receipt" },
    });
    expect(decide(facts({ kind: "notification" })).lane).toBe("INFO");
    expect(decide(facts({ kind: "receipt" })).lane).toBe("INFO");
  });

  it("v3.0 SILENT: bulk with no asks, or newsletter/promotion with no asks", () => {
    const v30 = { version: "v3.0" as const };
    expect(decide(facts({ addressedTo: "bulk", kind: "meeting" }), v30).reasons[0].code).toBe(
      "bulk",
    );
    expect(decide(facts({ kind: "newsletter", addressedTo: "me_direct" }), v30).lane).toBe(
      "SILENT",
    );
    expect(decide(facts({ kind: "promotion" }), v30).lane).toBe("SILENT");
  });

  it("v3.1 SILENT is clear marketing only: a promotion; newsletters and bulk mail are filed in INFO", () => {
    expect(decide(facts({ kind: "promotion" })).lane).toBe("SILENT");
    expect(decide(facts({ kind: "promotion", addressedTo: "bulk" })).lane).toBe("SILENT");
    const newsletter = decide(facts({ kind: "newsletter", addressedTo: "me_direct" }));
    expect(newsletter.lane).toBe("INFO");
    expect(newsletter.reasons[0]).toMatchObject({ code: "kind", params: { kind: "newsletter" } });
    const bulk = decide(facts({ addressedTo: "bulk", kind: "meeting" }));
    expect(bulk.lane).toBe("INFO");
    expect(bulk.reasons[0]?.code).toBe("bulk");
  });

  it("a newsletter that asks something is QUEUE, never SILENT", () => {
    expect(
      decide(facts({ kind: "newsletter", addressedTo: "bulk", asks: [replyAsk(null)] })).lane,
    ).toBe("QUEUE");
  });

  it("defaults to QUEUE when nothing matches", () => {
    const d = decide(facts({ kind: "meeting" }));
    expect(d.lane).toBe("QUEUE");
    expect(d.reasons[0].code).toBe("default_queue");
  });

  it("ambiguous facts never hide: SILENT/INFO become QUEUE", () => {
    const d = decide(facts({ kind: "newsletter", ambiguous: true }));
    expect(d.lane).toBe("QUEUE");
    expect(d.reasons[0].code).toBe("ambiguous");
    expect(d.reasons[1].code).toBe("kind");
  });

  it("spam never interrupts: PUSH/MEETING become QUEUE", () => {
    const d = decide(facts({ asks: [replyAsk(inHours(1))] }), { spam: true });
    expect(d.lane).toBe("QUEUE");
    expect(d.pushCandidate).toBe(false);
    expect(d.reasons[0].code).toBe("spam_floor");
    const m = decide(facts({ event: { proposedTimes: [], hasInvite: true, conflict: null } }), {
      spam: true,
    });
    expect(m.lane).toBe("QUEUE");
  });

  it("a manual override wins over everything, then a sender pin (as today)", () => {
    const urgent = facts({ asks: [replyAsk(inHours(1))] });
    const overridden = decide(urgent, { pinnedTier: "SILENT", manualOverrideTier: "INFO" });
    expect(overridden.lane).toBe("INFO");
    expect(overridden.pushCandidate).toBe(false);
    expect(overridden.reasons[0]).toMatchObject({
      code: "manual_override",
      params: { tier: "INFO" },
    });
    const pinned = decide(urgent, { pinnedTier: "SILENT" });
    expect(pinned.lane).toBe("SILENT");
    expect(pinned.reasons[0].code).toBe("pinned");
  });

  it("a legacy AUTO pin renders as QUEUE", () => {
    expect(decide(base, { pinnedTier: "AUTO" }).lane).toBe("QUEUE");
  });

  it("adds a WHO reason with only the known relationship features", () => {
    const d = laneFromFactsV3({
      facts: facts({ kind: "personal" }),
      relationship: {
        ...noRelationship,
        sentCount: 12,
        lastSentAt: inHours(-48),
        sameOrgDomain: true,
        dismissCount: 0,
        // P2-only fields never reach clients (the reason uses an allowlist).
        inboundCount: 30,
        firstSeenAt: inHours(-24 * 400),
      },
      decidedAt: NOW,
    });
    const who = d.reasons.find((r) => r.code === "relationship");
    expect(who?.params).toEqual({
      sentCount: 12,
      lastSentAt: inHours(-48),
      sameOrgDomain: true,
      dismissCount: 0,
    });
  });
});

// ── Properties ─────────────────────────────────────────────────────────────

const ITERATIONS = 5000;
const LIVE = new Set(["PUSH", "MEETING", "QUEUE", "INFO", "SILENT"]);

/** Seeded inputs over every policy version, DMARC verdict and automated-sender signal. */
function* cases(seed: number) {
  const rng = mulberry32(seed);
  for (let i = 0; i < ITERATIONS; i++) {
    yield {
      i,
      input: {
        facts: genFacts(rng, NOW),
        relationship: genRelationship(rng, NOW),
        pinnedTier: genTierOrNull(rng, 0.08),
        manualOverrideTier: genTierOrNull(rng, 0.08),
        spam: rng() < 0.1,
        automatedSender: rng() < 0.2,
        senderAuthenticated: pick(rng, [true, false, null] as const),
        version: pick(rng, POLICY_VERSIONS),
        decidedAt: NOW,
      },
    };
  }
}

/** The risk trust the policy applies, restated from the doc for the property. */
function riskTrusted(
  input: ReturnType<typeof cases> extends Generator<infer C> ? C["input"] : never,
) {
  const { facts: f, relationship: rel, senderAuthenticated: auth } = input;
  if (auth === false) return false;
  if (rel?.vip === true) return true;
  if (input.version === "v3.0" || auth !== true) return false;
  if (f.ambiguous || f.kind === "promotion" || f.kind === "newsletter") return false;
  const firstSeen = rel?.firstSeenAt ? Date.parse(rel.firstSeenAt) : Number.NaN;
  return (
    (rel?.inboundCount ?? 0) >= RISK_TRUST_MIN_INBOUND &&
    Number.isFinite(firstSeen) &&
    NOW.getTime() - firstSeen >= RISK_TRUST_MIN_HISTORY_MS
  );
}

const dueWithin24h = (f: FactsV1) =>
  f.asks.some((a) => {
    const t = a.due ? Date.parse(a.due) : Number.NaN;
    return Number.isFinite(t) && t >= NOW.getTime() - 24 * HOUR && t <= NOW.getTime() + 24 * HOUR;
  });

describe("laneFromFactsV3 — v3.2 first-contact gate and due window", () => {
  // #1649's two misses, as Haiku extracted them (phishing-eval-set.json).
  const overdueInvoice = facts({
    kind: "work_thread",
    asks: [
      {
        kind: "pay",
        object: "settle invoice",
        due: inHours(10),
        evidence: "Could you arrange payment today",
      },
    ],
    transaction: { kind: "invoice", actionRequired: true },
  });
  const callInvite = facts({
    kind: "meeting",
    asks: [{ kind: "attend", object: "intro call", due: null, evidence: "has invited you" }],
    event: { proposedTimes: [inHours(48)], hasInvite: false, conflict: null },
  });
  const known = (over: Partial<RelationshipSnapshot>): RelationshipSnapshot => ({
    ...UNKNOWN_RELATIONSHIP,
    inboundCount: 0,
    sentCount: 0,
    meetingCount: 0,
    vip: false,
    sameOrgDomain: false,
    ...over,
  });
  const firstContact = known({});
  const v32 = (f: FactsV1, extra: Partial<Parameters<typeof laneFromFactsV3>[0]> = {}) =>
    decide(f, { version: "v3.2", relationship: firstContact, ...extra });

  it("phish-028 shape: a stranger's pay ask due today goes to QUEUE, not PUSH", () => {
    expect(decide(overdueInvoice, { relationship: firstContact }).lane).toBe("PUSH");
    const d = v32(overdueInvoice);
    expect(d.lane).toBe("QUEUE");
    expect(d.pushCandidate).toBe(false);
    expect(d.policyVersion).toBe("v3.2");
    expect(d.reasons[0]).toMatchObject({
      code: "first_contact",
      params: { payAsk: true, event: false },
    });
    // The interrupt it would have made follows as supporting reasons.
    expect(d.reasons[1]).toMatchObject({ code: "ask_due_soon", params: { askKind: "pay" } });
  });

  it("phish-029 shape: a stranger's text-only invite goes to QUEUE, not MEETING", () => {
    expect(decide(callInvite, { relationship: firstContact }).lane).toBe("MEETING");
    const d = v32(callInvite);
    expect(d.lane).toBe("QUEUE");
    expect(d.reasons[0]).toMatchObject({
      code: "first_contact",
      params: { payAsk: false, event: true },
    });
    expect(d.reasons[1]?.code).toBe("event");
  });

  it("an urgent invite from a stranger cannot reach PUSH through a due-soon ask either", () => {
    const urgentInvite = { ...callInvite, asks: [replyAsk(inHours(2))] };
    expect(decide(urgentInvite, { relationship: firstContact }).lane).toBe("PUSH");
    expect(v32(urgentInvite)).toMatchObject({ lane: "QUEUE", pushCandidate: false });
  });

  const monthAgo = new Date(NOW.getTime() - RISK_TRUST_MIN_HISTORY_MS - HOUR).toISOString();

  it("each kind of established contact lifts the gate: the known sender is unaffected", () => {
    const evidence: Partial<RelationshipSnapshot>[] = [
      { vip: true },
      { sentCount: 2 },
      { inboundCount: RISK_TRUST_MIN_INBOUND, firstSeenAt: monthAgo },
      { meetingCount: 1 },
    ];
    for (const over of evidence) {
      const rel = known(over);
      expect(isFirstContact(rel, null, NOW), JSON.stringify(over)).toBe(false);
      expect(v32(overdueInvoice, { relationship: rel }).lane).toBe("PUSH");
      expect(v32(callInvite, { relationship: rel }).lane).toBe("MEETING");
    }
  });

  it("cheap contact is not established: one mail, one reply, a fresh sender, the same domain", () => {
    const cheap: Partial<RelationshipSnapshot>[] = [
      // The same phish sent twice.
      { inboundCount: 1, firstSeenAt: inHours(-1) },
      // A "who is this?" reply.
      { sentCount: 1 },
      // Plenty of mail, but all of it this week.
      { inboundCount: 20, firstSeenAt: inHours(-24 * 6) },
      // A free account at the user's own mail provider can share the domain.
      { sameOrgDomain: true },
    ];
    for (const over of cheap) {
      expect(isFirstContact(known(over), true, NOW), JSON.stringify(over)).toBe(true);
      expect(v32(callInvite, { relationship: known(over) }).lane).toBe("QUEUE");
    }
  });

  it("fails closed on unknown counts; no snapshot at all keeps the v3.1 lane (keyword fallback parity)", () => {
    expect(isFirstContact(noRelationship, true, NOW)).toBe(true);
    expect(v32(callInvite, { relationship: noRelationship }).lane).toBe("QUEUE");
    // Live LLM facts always carry a snapshot; only the model-down keyword path has none.
    expect(v32(overdueInvoice, { relationship: null }).lane).toBe("PUSH");
    expect(v32(callInvite, { relationship: null }).lane).toBe("MEETING");
  });

  it("history behind a From that failed DMARC is no evidence: a forger copies the address", () => {
    const correspondent = known({ inboundCount: 12, sentCount: 4, vip: true });
    expect(isFirstContact(correspondent, false, NOW)).toBe(true);
    expect(v32(overdueInvoice, { relationship: correspondent }).lane).toBe("PUSH");
    expect(
      v32(overdueInvoice, { relationship: correspondent, senderAuthenticated: false }).lane,
    ).toBe("QUEUE");
  });

  it("gates only a pay ask or an event: a stranger's due-soon reply ask still interrupts", () => {
    const d = v32(facts({ asks: [replyAsk(inHours(3))] }));
    expect(d.lane).toBe("PUSH");
    expect(d.reasons[0].code).toBe("ask_due_soon");
  });

  it("a pay ask with no due that would not interrupt keeps its lane and reason", () => {
    const later = facts({
      asks: [{ kind: "pay", object: "invoice", due: inHours(24 * 9), evidence: "pay by the 20th" }],
    });
    const d = v32(later);
    expect(d.lane).toBe("QUEUE");
    expect(d.reasons[0].code).toBe("ask");
  });

  it("a phishing or spam floor still decides first; a pin or override is not gated", () => {
    const phish = { ...callInvite, risk: ["phishing_suspect" as const] };
    expect(v32(phish).reasons[0]).toMatchObject({
      code: "risk",
      params: { risk: "phishing_suspect" },
    });
    expect(v32(callInvite, { spam: true }).reasons[0].code).toBe("spam_floor");
    expect(v32(overdueInvoice, { pinnedTier: "PUSH" }).lane).toBe("PUSH");
    expect(v32(callInvite, { manualOverrideTier: "MEETING" }).lane).toBe("MEETING");
  });

  it("the gate's two halves are rule parameters: a pay-only candidate lets an invite ring", () => {
    const payOnly = { ...policyRules("v3.2"), firstContactGate: { payAsk: true, event: false } };
    const under = (f: FactsV1) =>
      laneFromFactsUnderRules({ facts: f, relationship: firstContact, decidedAt: NOW }, payOnly);
    expect(under(overdueInvoice).lane).toBe("QUEUE");
    expect(under(callInvite).lane).toBe("MEETING");
    expect(policyRules("v3.1").firstContactGate).toEqual({ payAsk: false, event: false });
  });

  it("v3.2 keeps the ±24h window, inclusive on both edges", () => {
    const at = (ms: number) =>
      v32(facts({ asks: [replyAsk(new Date(NOW.getTime() + ms).toISOString())] })).lane;
    expect(at(24 * HOUR)).toBe("PUSH");
    expect(at(24 * HOUR + 1000)).toBe("QUEUE");
    expect(at(-24 * HOUR)).toBe("PUSH");
    expect(at(-24 * HOUR - 1000)).toBe("QUEUE");
    expect(policyRules("v3.2").dueWindow).toEqual(policyRules("v3.1").dueWindow);
  });

  it("the window is a rule parameter: a candidate ±72h window moves both edges", () => {
    const wide = {
      ...policyRules("v3.2"),
      dueWindow: { overdueMs: 72 * HOUR, aheadMs: 72 * HOUR },
    };
    const at = (ms: number) =>
      laneFromFactsUnderRules(
        {
          facts: facts({ asks: [replyAsk(new Date(NOW.getTime() + ms).toISOString())] }),
          relationship: null,
          decidedAt: NOW,
        },
        wide,
      ).lane;
    expect(at(72 * HOUR)).toBe("PUSH");
    expect(at(72 * HOUR + 1000)).toBe("QUEUE");
    expect(at(-72 * HOUR)).toBe("PUSH");
    expect(at(-72 * HOUR - 1000)).toBe("QUEUE");
  });

  it("a version's own rules through laneFromFactsUnderRules decide exactly as laneFromFactsV3", () => {
    for (const { i, input } of cases(11)) {
      const { policyVersion, ...viaVersion } = laneFromFactsV3(input);
      expect(laneFromFactsUnderRules(input, policyRules(policyVersion)), `case ${i}`).toEqual(
        viaVersion,
      );
    }
  });

  it("v3.2 differs from v3.1 only by holding a first contact's pay ask or event in QUEUE", () => {
    for (const { i, input } of cases(12)) {
      const a = laneFromFactsV3({ ...input, version: "v3.1" });
      const b = laneFromFactsV3({ ...input, version: "v3.2" });
      if (a.lane === b.lane) {
        expect(b.reasons, `case ${i}`).toEqual(a.reasons);
        continue;
      }
      const f = input.facts;
      expect(["PUSH", "MEETING"], `case ${i}`).toContain(a.lane);
      expect(b.lane, `case ${i}`).toBe("QUEUE");
      expect(b.reasons[0].code, `case ${i}`).toBe("first_contact");
      expect(input.relationship, `case ${i}`).not.toBeNull();
      const rel = input.relationship as RelationshipSnapshot;
      expect(isFirstContact(rel, input.senderAuthenticated, NOW), `case ${i}`).toBe(true);
      expect(f.event !== null || f.asks.some((x) => x.kind === "pay"), `case ${i}`).toBe(true);
    }
  });
});

describe("laneFromFactsV3 — properties", () => {
  it("always returns one of the five lanes and a deciding reason", () => {
    for (const { i, input } of cases(1)) {
      const d = laneFromFactsV3(input);
      expect(LIVE.has(d.lane), `case ${i}`).toBe(true);
      expect(d.reasons.length, `case ${i}`).toBeGreaterThan(0);
      expect(d.policyVersion).toBe(input.version);
    }
  });

  it("precedence: a manual override always decides, then a pin", () => {
    for (const { i, input } of cases(2)) {
      const d = laneFromFactsV3(input);
      if (input.manualOverrideTier) {
        expect(d.lane, `case ${i}`).toBe(toLiveTier(input.manualOverrideTier));
        expect(d.reasons[0].code).toBe("manual_override");
      } else if (input.pinnedTier) {
        expect(d.lane, `case ${i}`).toBe(toLiveTier(input.pinnedTier));
        expect(d.reasons[0].code).toBe("pinned");
      }
    }
  });

  it("no PUSH without a due ask or a trusted payment/security risk; never phishing; only to me", () => {
    for (const { i, input } of cases(3)) {
      const d = laneFromFactsV3(input);
      if (!d.pushCandidate) continue;
      const f = input.facts;
      const risky = f.risk.includes("payment_failed") || f.risk.includes("security_alert");
      expect((risky && riskTrusted(input)) || dueWithin24h(f), `case ${i}`).toBe(true);
      expect(f.risk.includes("phishing_suspect"), `case ${i}`).toBe(false);
      expect(["me_direct", "me_cc"], `case ${i}`).toContain(f.addressedTo);
      expect(input.spam, `case ${i}`).toBe(false);
    }
  });

  it("pushCandidate is exactly 'the facts, not a pin or override, made it PUSH'", () => {
    for (const { i, input } of cases(4)) {
      const d = laneFromFactsV3(input);
      if (d.pushCandidate) expect(d.lane, `case ${i}`).toBe("PUSH");
      if (input.pinnedTier || input.manualOverrideTier)
        expect(d.pushCandidate, `case ${i}`).toBe(false);
    }
  });

  it("SILENT never for mail sent directly to me that asks something", () => {
    for (const { i, input } of cases(5)) {
      if (input.pinnedTier || input.manualOverrideTier) continue;
      const d = laneFromFactsV3(input);
      if (input.facts.addressedTo === "me_direct" && input.facts.asks.length > 0) {
        expect(d.lane, `case ${i}`).not.toBe("SILENT");
      }
    }
  });

  it("phishing never lands PUSH or MEETING; an automated sender PUSHes only through trusted risk", () => {
    for (const { i, input } of cases(9)) {
      if (input.pinnedTier || input.manualOverrideTier) continue;
      const d = laneFromFactsV3({ ...input, automatedSender: i % 2 === 0 });
      if (input.facts.risk.includes("phishing_suspect")) {
        expect(["PUSH", "MEETING"], `case ${i}`).not.toContain(d.lane);
      }
      if (i % 2 === 0 && d.pushCandidate) expect(d.reasons[0].code, `case ${i}`).toBe("risk");
    }
  });

  it("ambiguous facts never land SILENT or INFO; spam never lands PUSH or MEETING", () => {
    for (const { i, input } of cases(6)) {
      if (input.pinnedTier || input.manualOverrideTier) continue;
      const d = laneFromFactsV3(input);
      if (input.facts.ambiguous) expect(["SILENT", "INFO"], `case ${i}`).not.toContain(d.lane);
      if (input.spam) expect(["PUSH", "MEETING"], `case ${i}`).not.toContain(d.lane);
    }
  });

  it("every evidence string in a reason comes verbatim from the facts", () => {
    for (const { i, input } of cases(7)) {
      const quotes = new Set(input.facts.asks.map((a) => a.evidence));
      for (const r of laneFromFactsV3(input).reasons) {
        if (r.evidence !== null) expect(quotes.has(r.evidence), `case ${i}`).toBe(true);
      }
    }
  });

  it("is deterministic and does not mutate its input", () => {
    for (const { i, input } of cases(8)) {
      const snapshot = JSON.stringify(input);
      const a = laneFromFactsV3(input);
      const b = laneFromFactsV3(input);
      expect(b, `case ${i}`).toEqual(a);
      expect(JSON.stringify(input), `case ${i}`).toBe(snapshot);
    }
  });
});
