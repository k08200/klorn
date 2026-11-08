import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FactsV1 } from "../judge/v3/facts-schema.js";
import {
  describeReason,
  laneUnder,
  PHISHING_SCENARIOS,
  type PhishingItemResult,
  summarizePhishingEval,
} from "../judge/v3/phishing-eval.js";

const at = new Date("2026-11-02T01:00:00Z");
const facts = (over: Partial<FactsV1> = {}): FactsV1 => ({
  asks: [],
  addressedTo: "me_direct",
  threadTurn: "mine_to_reply",
  event: null,
  transaction: null,
  risk: [],
  kind: "personal",
  ambiguous: false,
  ...over,
});
const payToday = {
  kind: "pay" as const,
  object: "wire",
  due: "2026-11-02T15:00:00Z",
  evidence: "before 3pm today",
};
const scenario = (name: string) => {
  const s = PHISHING_SCENARIOS.find((x) => x.name === name);
  if (!s) throw new Error(name);
  return s;
};
const lanes = (f: FactsV1) => PHISHING_SCENARIOS.map((s) => laneUnder(f, s, at).lane);

describe("describeReason", () => {
  it("prints the code and its non-null params", () => {
    expect(describeReason(undefined)).toBe("none");
    expect(
      describeReason({
        code: "risk",
        fact: "risk",
        evidence: null,
        params: { risk: "payment_failed", trusted: true, extra: null },
      }),
    ).toBe("risk(risk=payment_failed,trusted=true)");
  });
});

describe("laneUnder (policy v3.1)", () => {
  it("an unflagged due-soon ask PUSHes under every scenario; the flag vetoes it", () => {
    expect(lanes(facts({ asks: [payToday] }))).toEqual(["PUSH", "PUSH", "PUSH"]);
    expect(lanes(facts({ asks: [payToday], risk: ["phishing_suspect"] }))).toEqual([
      "QUEUE",
      "QUEUE",
      "QUEUE",
    ]);
    expect(laneUnder(facts({ asks: [payToday] }), scenario("cold_start"), at).deciding).toMatch(
      /^ask_due_soon\(askKind=pay/,
    );
  });

  it("a risk-only PUSH needs the known-correspondent scenario", () => {
    const risky = facts({ risk: ["payment_failed"], kind: "notification", threadTurn: "none" });
    expect(lanes(risky)).toEqual(["QUEUE", "QUEUE", "PUSH"]);
    expect(lanes({ ...risky, risk: ["payment_failed", "phishing_suspect"] })).toEqual([
      "QUEUE",
      "QUEUE",
      "QUEUE",
    ]);
  });

  it("an unflagged invite is MEETING; a flagged one is QUEUE", () => {
    const invite = facts({
      kind: "meeting",
      event: { proposedTimes: [], hasInvite: true, conflict: null },
    });
    expect(lanes(invite)).toEqual(["MEETING", "MEETING", "MEETING"]);
    expect(lanes({ ...invite, risk: ["phishing_suspect"] })).toEqual(["QUEUE", "QUEUE", "QUEUE"]);
  });
});

describe("summarizePhishingEval", () => {
  const base = {
    receivedAt: at,
    asksChecked: 1,
    asksDropped: 0,
    automatedSenderSignal: false,
  };
  const results: PhishingItemResult[] = [
    {
      ...base,
      id: "p1",
      run: 1,
      phishing: true,
      expectedLane: "QUEUE",
      facts: facts({ asks: [payToday], risk: ["phishing_suspect"] }),
    },
    {
      ...base,
      id: "p2",
      run: 1,
      phishing: true,
      expectedLane: "QUEUE",
      facts: facts({ asks: [payToday] }),
    },
    {
      ...base,
      id: "p3",
      run: 1,
      phishing: true,
      expectedLane: "QUEUE",
      facts: null,
      asksChecked: 0,
    },
    {
      ...base,
      id: "b1",
      run: 1,
      phishing: false,
      expectedLane: "PUSH",
      facts: facts({ asks: [payToday], risk: ["phishing_suspect"] }),
      asksDropped: 1,
    },
    {
      ...base,
      id: "b2",
      run: 1,
      phishing: false,
      expectedLane: "PUSH",
      facts: facts({ asks: [payToday] }),
    },
  ];
  const s = summarizePhishingEval(results);

  it("reports recall on phishing and false positives on benign, without the no-facts items", () => {
    expect(s.noFacts).toBe(1);
    expect(s.phishing).toEqual({ total: 2, flagged: 1, recall: 0.5, missed: ["p2#1"] });
    expect(s.benign).toEqual({
      total: 2,
      flagged: 1,
      falsePositiveRate: 0.5,
      flaggedIds: ["b1#1"],
    });
    expect(s.evidenceValidity).toBe(0.75);
  });

  it("lists phishing that interrupts and benign lane misses per scenario", () => {
    const cold = s.scenarios.cold_start;
    expect(cold.phishingInterrupts).toEqual([
      expect.objectContaining({ id: "p2", run: 1, lane: "PUSH" }),
    ]);
    expect(cold.benignLaneMisses).toEqual([
      expect.objectContaining({ id: "b1", expected: "PUSH", lane: "QUEUE" }),
    ]);
    expect(cold.laneAccuracy).toEqual({ correct: 2, total: 4, accuracy: 0.5 });
    expect(Object.keys(s.scenarios)).toEqual(PHISHING_SCENARIOS.map((x) => x.name));
  });
});

describe("phishing eval set file", () => {
  const doc = JSON.parse(
    readFileSync(new URL("../../eval/phishing-eval-set.json", import.meta.url), "utf8"),
  );
  type Item = {
    id: string;
    from: string;
    to: string;
    subject: string;
    snippet: string;
    body: string;
    receivedAt: string;
    phishing: boolean;
    label: string;
    labelV2: string;
  };
  const items = doc.items as Item[];
  const RESERVED = /(\.example|\.test|(^|\.)example\.(com|net|org))$/i;

  it("has unique ids, a matching count and both classes", () => {
    const ids = items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(doc.metadata.count).toBe(items.length);
    expect(items.filter((i) => i.phishing).length).toBeGreaterThanOrEqual(20);
    expect(items.filter((i) => !i.phishing).length).toBeGreaterThanOrEqual(10);
  });

  it("labels phishing QUEUE and uses only live lanes", () => {
    for (const i of items) {
      expect(typeof i.phishing, i.id).toBe("boolean");
      expect(["PUSH", "MEETING", "QUEUE", "INFO", "SILENT"], i.id).toContain(i.labelV2);
      expect(i.label, i.id).toBe(i.labelV2);
      if (i.phishing) expect(i.labelV2, i.id).toBe("QUEUE");
      expect(Number.isNaN(Date.parse(i.receivedAt)), i.id).toBe(false);
    }
  });

  it("uses only reserved domains in addresses and links (PII-free)", () => {
    for (const i of items) {
      const text = [i.from, i.to, i.subject, i.snippet, i.body].join("\n");
      const hosts = [
        ...[...text.matchAll(/[\w.+-]+@([\w.-]+\w)/g)].map((m) => m[1]),
        ...[...text.matchAll(/https?:\/\/([\w.-]+)/g)].map((m) => m[1]),
      ];
      expect(hosts.length, i.id).toBeGreaterThan(0);
      for (const h of hosts) expect(h, `${i.id}: ${h}`).toMatch(RESERVED);
    }
  });
});
