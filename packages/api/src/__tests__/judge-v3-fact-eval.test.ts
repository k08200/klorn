import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dueBucket, scoreItem, summarizeFactEval } from "../judge/v3/fact-eval.js";
import { ASK_KINDS, type FactsV1, MAIL_KINDS, RISKS } from "../judge/v3/facts-schema.js";

const at = new Date("2026-06-01T14:00:00Z");
const facts = (over: Partial<FactsV1> = {}): FactsV1 => ({
  asks: [],
  addressedTo: "me_direct",
  threadTurn: "none",
  event: null,
  transaction: null,
  risk: [],
  kind: "personal",
  ambiguous: false,
  ...over,
});
const ask = (kind: "reply" | "provide", due: string | null) => ({
  kind,
  object: "x",
  due,
  evidence: "by today",
});

describe("dueBucket", () => {
  it("buckets the earliest due against receipt", () => {
    expect(dueBucket(facts(), at)).toBe("none");
    expect(dueBucket(facts({ asks: [ask("reply", "2026-06-01T23:59:00+00:00")] }), at)).toBe(
      "within24h",
    );
    expect(dueBucket(facts({ asks: [ask("reply", "2026-06-05T23:59:00+00:00")] }), at)).toBe(
      "later",
    );
  });
});

describe("scoreItem", () => {
  it("scores only labelled fields", () => {
    const s = scoreItem(
      facts({ asks: [ask("provide", "2026-06-01T20:00:00Z")] }),
      { asksPresent: true, due: "within24h" },
      at,
    );
    expect(s).toEqual({ asksPresent: true, due: true });
  });

  it("transaction kind null means any kind; null label means no transaction", () => {
    const f = facts({ transaction: { kind: "statement", actionRequired: false } });
    expect(
      scoreItem(f, { transaction: { kind: null, actionRequired: false } }, at).transaction,
    ).toBe(true);
    expect(
      scoreItem(f, { transaction: { kind: "invoice", actionRequired: false } }, at).transaction,
    ).toBe(false);
    expect(scoreItem(f, { transaction: null }, at).transaction).toBe(false);
  });
});

describe("summarizeFactEval", () => {
  it("reports per-field accuracy, ask-kind precision/recall and evidence validity", () => {
    const s = summarizeFactEval([
      {
        id: "a",
        facts: facts({ asks: [ask("reply", null)] }),
        label: { asksPresent: true, askKinds: ["reply"] },
        receivedAt: at,
        asksChecked: 2,
        asksDropped: 1,
      },
      {
        id: "b",
        facts: facts(),
        label: { asksPresent: true, askKinds: ["provide"] },
        receivedAt: at,
        asksChecked: 0,
        asksDropped: 0,
      },
      { id: "c", facts: null, label: {}, receivedAt: at, asksChecked: 0, asksDropped: 0 },
    ]);
    expect(s.fields.asksPresent).toEqual({ correct: 1, total: 2, accuracy: 0.5 });
    expect(s.askKinds).toEqual({ precision: 1, recall: 0.5 });
    expect(s.evidenceValidity).toBe(0.5);
    expect(s.noFacts).toBe(1);
    expect(s.misses).toEqual([{ id: "b", fields: ["asksPresent"] }]);
  });
});

describe("synthetic fact labels file", () => {
  const doc = JSON.parse(
    readFileSync(new URL("../../eval/facts/synthetic-facts.json", import.meta.url), "utf8"),
  );
  const items = JSON.parse(
    readFileSync(new URL("../../eval/judge-eval-set.json", import.meta.url), "utf8"),
  ).items as { id: string }[];

  it("labels only items that exist in the synthetic judge set, once each", () => {
    const ids = doc.items.map((i: { id: string }) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids)
      expect(
        items.some((i) => i.id === id),
        id,
      ).toBe(true);
  });

  it("uses only facts v1 vocabulary", () => {
    for (const { labels } of doc.items) {
      if (labels.kind) expect(MAIL_KINDS).toContain(labels.kind);
      for (const k of labels.askKinds ?? []) expect(ASK_KINDS).toContain(k);
      for (const r of labels.risk ?? []) expect(RISKS).toContain(r);
      if (labels.due) expect(["none", "within24h", "later"]).toContain(labels.due);
    }
  });
});
