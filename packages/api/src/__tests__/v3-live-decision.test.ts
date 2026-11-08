import { describe, expect, it, vi } from "vitest";
import {
  decideLiveLane,
  type FactsBasis,
  type LiveDecisionInput,
} from "../judge/v3/live-decision.js";
import { POLICY_VERSION } from "../judge/v3/policy.js";
import type { FactsV1, RelationshipSnapshot } from "../judge/v3/policy-types.js";
import { UNKNOWN_RELATIONSHIP } from "../judge/v3/relationship.js";
import { genFacts, genRelationship, mulberry32, pick } from "./helpers/v3-facts-gen.js";

const NOW = new Date("2026-11-03T09:00:00Z");

function facts(over: Partial<FactsV1> = {}): FactsV1 {
  return {
    asks: [],
    addressedTo: "me_direct",
    threadTurn: "none",
    event: null,
    transaction: null,
    risk: [],
    kind: "personal",
    ambiguous: false,
    ...over,
  };
}

function rel(over: Partial<RelationshipSnapshot> = {}): RelationshipSnapshot {
  return { ...UNKNOWN_RELATIONSHIP, ...over };
}

const MAIL = {
  from: "Dana <dana@example.com>",
  subject: "Quarterly numbers",
  snippet: "Here are the numbers",
  body: "Here are the numbers",
  labels: [] as string[],
};

function input(over: Partial<LiveDecisionInput> = {}): LiveDecisionInput {
  return {
    v2Tier: "QUEUE",
    v2Source: "llm",
    email: MAIL,
    receivedAt: NOW,
    basis: { kind: "none", pre: null, relationship: null },
    decidedAt: NOW,
    ...over,
  };
}

const llm = (f: FactsV1, relationship: RelationshipSnapshot | null = null): FactsBasis => ({
  kind: "llm",
  facts: f,
  relationship,
  signals: null,
});

describe("decideLiveLane: LLM facts decide through policy v3.0", () => {
  it("a direct ask due within 24h is a budgeted PUSH with its due and reasons", () => {
    const due = "2026-11-03T18:00:00+09:00";
    const d = decideLiveLane(
      input({
        v2Tier: "QUEUE",
        basis: llm(
          facts({ asks: [{ kind: "reply", object: "numbers", due, evidence: "by 6pm today" }] }),
        ),
      }),
    );
    expect(d.lane).toBe("PUSH");
    expect(d.policyVersion).toBe(POLICY_VERSION);
    expect(d.basis).toBe("llm");
    expect(d.pushCandidate).toBe(true);
    expect(d.budgeted).toBe(true);
    expect(d.precedence).toBe(false);
    expect(d.reasons[0]?.code).toBe("ask_due_soon");
    expect(d.due).toBe(due);
  });

  it("carries threadTurn and the relationship's importance and trust", () => {
    const d = decideLiveLane(
      input({
        basis: llm(facts({ threadTurn: "mine_to_reply" }), rel({ vip: true })),
      }),
    );
    expect(d.lane).toBe("QUEUE");
    expect(d.threadTurn).toBe("mine_to_reply");
    expect(d.importance).toBe(1);
    expect(d.trusted).toBe(true);
  });

  it("passes the mailbox spam and automated-sender signals to the policy", () => {
    const due = "2026-11-03T18:00:00+09:00";
    const ask = { kind: "reply" as const, object: "x", due, evidence: "by 6pm today" };
    const base = facts({ asks: [ask] });
    const signals = { automatedSender: true, spam: false } as never;
    const automated = decideLiveLane(
      input({ basis: { kind: "llm", facts: base, relationship: null, signals } }),
    );
    expect(automated.lane).toBe("QUEUE");
    const spam = decideLiveLane(
      input({
        basis: {
          kind: "llm",
          facts: facts({ event: { proposedTimes: [], hasInvite: true, conflict: null } }),
          relationship: null,
          signals: { automatedSender: false, spam: true } as never,
        },
      }),
    );
    expect(spam.lane).toBe("QUEUE");
  });
});

describe("decideLiveLane: no LLM facts", () => {
  it("keeps the v2 lane when the v2 judge had a model answer", () => {
    for (const v2Tier of ["PUSH", "MEETING", "QUEUE", "INFO", "SILENT"] as const) {
      const d = decideLiveLane(input({ v2Tier, v2Source: "llm" }));
      expect(d.lane).toBe(v2Tier);
      expect(d.policyVersion).toBe("v2");
      expect(d.basis).toBe("v2");
      expect(d.reasons).toEqual([]);
      expect(d.due).toBeNull();
      expect(d.threadTurn).toBeNull();
      expect(d.budgeted).toBe(true);
    }
  });

  it("uses keyword facts with the certain pre-facts when v2 also fell back to keywords", () => {
    const meeting = {
      ...MAIL,
      subject: "Can we reschedule Tuesday?",
      snippet: "Need to reschedule",
    };
    const keywordOnly = decideLiveLane(
      input({ v2Tier: "MEETING", v2Source: "keyword-fallback", email: meeting }),
    );
    expect(keywordOnly.basis).toBe("keyword");
    expect(keywordOnly.policyVersion).toBe(POLICY_VERSION);
    expect(keywordOnly.lane).toBe("MEETING");

    // A certain pre-fact (list mail → bulk) overrides the keyword guess: bulk
    // scheduling mail is not MEETING (doc §3(5) parity table, bulkScheduling).
    const bulk = decideLiveLane(
      input({
        v2Tier: "MEETING",
        v2Source: "keyword-fallback",
        email: meeting,
        basis: {
          kind: "none",
          pre: { facts: { addressedTo: "bulk" }, certain: ["addressedTo"] },
          relationship: null,
        },
      }),
    );
    expect(bulk.basis).toBe("keyword");
    expect(bulk.lane).not.toBe("MEETING");
  });

  it("replay's keyword mode forces keyword facts even over a model lane", () => {
    const d = decideLiveLane(
      input({
        v2Tier: "PUSH",
        v2Source: "llm",
        basis: { kind: "keyword", pre: null, relationship: null },
      }),
    );
    expect(d.basis).toBe("keyword");
    expect(d.policyVersion).toBe(POLICY_VERSION);
  });
});

describe("decideLiveLane: precedence keeps the v2 lane", () => {
  it("a pin keeps its lane, spends no budget and says pinned", () => {
    const d = decideLiveLane(
      input({ v2Tier: "PUSH", v2Source: "pinned-rule", basis: llm(facts({ kind: "promotion" })) }),
    );
    expect(d.lane).toBe("PUSH");
    expect(d.precedence).toBe(true);
    expect(d.budgeted).toBe(false);
    expect(d.reasons.map((r) => r.code)).toEqual(["pinned"]);
    expect(d.reasons[0]?.params).toEqual({ tier: "PUSH" });
  });

  it("a manual override (replay) keeps its lane and spends no budget", () => {
    const d = decideLiveLane(
      input({ v2Tier: "PUSH", v2Source: "llm", manualOverride: true, basis: llm(facts()) }),
    );
    expect(d.lane).toBe("PUSH");
    expect(d.budgeted).toBe(false);
    expect(d.reasons[0]?.code).toBe("manual_override");
  });

  it.each([
    ["fast-path", "kind"],
    ["sender-prior", "sender_pattern"],
    ["learned-rule", "learned_rule"],
  ] as const)("%s keeps the v2 lane with reason %s, and a PUSH from it is budgeted", (source, code) => {
    const d = decideLiveLane(input({ v2Tier: "PUSH", v2Source: source, basis: llm(facts()) }));
    expect(d.lane).toBe("PUSH");
    expect(d.precedence).toBe(true);
    expect(d.budgeted).toBe(true);
    expect(d.policyVersion).toBe(POLICY_VERSION);
    expect(d.reasons.map((r) => r.code)).toEqual([code]);
  });
});

describe("decideLiveLane: trust for the slot reserve", () => {
  it.each([
    [null, false],
    [rel(), false],
    [rel({ sentCount: 0 }), false],
    // One reply ("who is this?") is not a relationship.
    [rel({ sentCount: 1 }), false],
    [rel({ sentCount: 2 }), true],
    [rel({ vip: true }), true],
    [rel({ vip: false, sentCount: 3 }), true],
  ])("relationship %j → trusted %s", (relationship, trusted) => {
    expect(decideLiveLane(input({ basis: llm(facts(), relationship) })).trusted).toBe(trusted);
    expect(
      decideLiveLane(input({ basis: { kind: "none", pre: null, relationship } })).trusted,
    ).toBe(trusted);
  });
});

describe("decideLiveLane: sender authentication and stored signals", () => {
  it("a sender whose From failed DMARC is never trusted, VIP or not", () => {
    for (const relationship of [rel({ vip: true }), rel({ sentCount: 9 })]) {
      const passed = decideLiveLane(input({ basis: llm(facts(), relationship) }));
      const forged = decideLiveLane(
        input({ basis: llm(facts(), relationship), senderAuthenticated: false }),
      );
      expect(passed.trusted).toBe(true);
      expect(forged.trusted).toBe(false);
    }
  });

  it("reads the DMARC verdict from the LLM basis signals when the caller has none", () => {
    const d = decideLiveLane(
      input({
        basis: {
          kind: "llm",
          facts: facts(),
          relationship: rel({ vip: true }),
          signals: { senderAuthenticated: false } as never,
        },
      }),
    );
    expect(d.trusted).toBe(false);
  });

  it("ignores a stored signal that is not a boolean and falls back to the mailbox", () => {
    const event = facts({ event: { proposedTimes: [], hasInvite: true, conflict: null } });
    // "false" is truthy; it must not read as spam, and the labels decide.
    const d = decideLiveLane(
      input({
        basis: {
          kind: "llm",
          facts: event,
          relationship: null,
          signals: { spam: "false" } as never,
        },
      }),
    );
    expect(d.lane).toBe("MEETING");
    const spam = decideLiveLane(
      input({
        email: { ...MAIL, labels: ["SPAM"] },
        basis: { kind: "llm", facts: event, relationship: null, signals: { spam: 1 } as never },
      }),
    );
    expect(spam.lane).toBe("QUEUE");
  });

  it("a precedence decision reports basis v2, not the facts it did not use", () => {
    const d = decideLiveLane(
      input({ v2Tier: "INFO", v2Source: "learned-rule", basis: llm(facts({ kind: "promotion" })) }),
    );
    expect(d.basis).toBe("v2");
  });
});

describe("decideLiveLane: policy version and the MEETING fallback", () => {
  it("stamps the version that decided, including one replay names", () => {
    const newsletter = llm(facts({ kind: "newsletter", addressedTo: "bulk" }));
    const v30 = decideLiveLane(input({ basis: newsletter, policyVersion: "v3.0" }));
    expect(v30).toMatchObject({ lane: "SILENT", policyVersion: "v3.0" });
    const live = decideLiveLane(input({ basis: newsletter }));
    expect(live).toMatchObject({ lane: "INFO", policyVersion: POLICY_VERSION });
  });

  it("a DMARC-passing known correspondent's payment risk PUSHes through the live path", () => {
    const relationship = rel({
      inboundCount: 10,
      firstSeenAt: new Date(NOW.getTime() - 90 * 24 * 3_600_000).toISOString(),
    });
    const risky = llm(facts({ risk: ["payment_failed"], kind: "notification" }), relationship);
    expect(decideLiveLane(input({ basis: risky, senderAuthenticated: true })).lane).toBe("PUSH");
    expect(decideLiveLane(input({ basis: risky, senderAuthenticated: null })).lane).toBe("QUEUE");
  });

  it("an urgent invite PUSHes with a MEETING fallback; a plain PUSH has none", () => {
    const due = "2026-11-03T18:00:00+09:00";
    const ask = { kind: "reply" as const, object: "time", due, evidence: "by 6pm today" };
    const event = { proposedTimes: [], hasInvite: true, conflict: false };
    const invite = decideLiveLane(input({ basis: llm(facts({ event, asks: [ask] })) }));
    expect(invite.lane).toBe("PUSH");
    expect(invite.meetingFallback?.map((r) => r.code)).toEqual(["event"]);
    const plain = decideLiveLane(input({ basis: llm(facts({ asks: [ask] })) }));
    expect(plain.lane).toBe("PUSH");
    expect(plain.meetingFallback).toBeNull();
  });

  it("the MEETING fallback keeps the relationship reason v3.0's MEETING carried", () => {
    const due = "2026-11-03T18:00:00+09:00";
    const ask = { kind: "reply" as const, object: "time", due, evidence: "by 6pm today" };
    const event = { proposedTimes: [], hasInvite: true, conflict: false };
    const relationship: RelationshipSnapshot = { ...UNKNOWN_RELATIONSHIP, sentCount: 3 };
    const invite = decideLiveLane(
      input({ basis: llm(facts({ event, asks: [ask] }), relationship) }),
    );
    expect(invite.reasons.map((r) => r.code)).toContain("relationship");
    expect(invite.meetingFallback?.map((r) => r.code)).toEqual(["event", "relationship"]);
  });
});

describe("decideLiveLane properties (seeded)", () => {
  const SOURCES = [
    "llm",
    "keyword-fallback",
    "pinned-rule",
    "fast-path",
    "sender-prior",
    "learned-rule",
  ];
  const TIERS = ["PUSH", "MEETING", "QUEUE", "INFO", "SILENT"] as const;

  it("without LLM facts and with a model v2 lane, the lane is always v2's", () => {
    const rng = mulberry32(1103);
    for (let i = 0; i < 2000; i++) {
      const v2Tier = pick(rng, TIERS);
      const d = decideLiveLane(
        input({
          v2Tier,
          v2Source: "llm",
          basis: { kind: "none", pre: null, relationship: genRelationship(rng, NOW) },
        }),
      );
      expect(d.lane).toBe(v2Tier);
    }
  });

  it("a non-precedence PUSH always comes from a policy PUSH candidate or the v2 lane", () => {
    const rng = mulberry32(31);
    for (let i = 0; i < 3000; i++) {
      const v2Source = pick(rng, SOURCES);
      const d = decideLiveLane(
        input({
          v2Tier: pick(rng, TIERS),
          v2Source,
          basis: llm(genFacts(rng, NOW), genRelationship(rng, NOW)),
        }),
      );
      if (d.lane !== "PUSH" || d.precedence) continue;
      expect(d.pushCandidate).toBe(true);
      expect(d.budgeted).toBe(true);
    }
  });

  it("only pins and manual overrides are unbudgeted", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 2000; i++) {
      const v2Source = pick(rng, SOURCES);
      const manualOverride = rng() < 0.1;
      const d = decideLiveLane(
        input({
          v2Tier: pick(rng, TIERS),
          v2Source,
          manualOverride,
          basis: llm(genFacts(rng, NOW), genRelationship(rng, NOW)),
        }),
      );
      expect(d.budgeted).toBe(!(manualOverride || v2Source === "pinned-rule"));
    }
  });
});

describe("judgeV3LivePolicyVersion", () => {
  it("is the live default unless JUDGE_V3_POLICY_VERSION names a known version", async () => {
    const { judgeV3LivePolicyVersion } = await import("../judge/v3/flags.js");
    expect(judgeV3LivePolicyVersion({})).toBe(POLICY_VERSION);
    expect(judgeV3LivePolicyVersion({ JUDGE_V3_POLICY_VERSION: "v3.0" })).toBe("v3.0");
    expect(judgeV3LivePolicyVersion({ JUDGE_V3_POLICY_VERSION: " v3.1 " })).toBe("v3.1");
    for (const bad of ["", "v9", "constructor", "__proto__"]) {
      expect(judgeV3LivePolicyVersion({ JUDGE_V3_POLICY_VERSION: bad })).toBe(POLICY_VERSION);
    }
  });

  it("logs a mistyped version once, so a failed rollback does not pass unseen", async () => {
    const { judgeV3LivePolicyVersion } = await import("../judge/v3/flags.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const env = { JUDGE_V3_POLICY_VERSION: "V3.0-typo" };
      expect(judgeV3LivePolicyVersion(env)).toBe(POLICY_VERSION);
      expect(judgeV3LivePolicyVersion(env)).toBe(POLICY_VERSION);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("V3.0-typo");
    } finally {
      warn.mockRestore();
    }
  });
});
