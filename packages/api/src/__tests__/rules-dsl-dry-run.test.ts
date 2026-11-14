/**
 * Rules DSL v1 dry-run, pure part (src/rules-dsl/dry-run.ts): what the
 * proposed rules would change on already-judged mail, measured against what
 * the CURRENT rules give, with the judge's own pin matcher (mail/pin-match.ts).
 */

import { describe, expect, it } from "vitest";
import { pinnedTierFromRules } from "../mail/pin-match.js";
import {
  buildInventory,
  checkRules,
  currentPinRules,
  type DryRunMail,
  dryRunRules,
  proposedPinRules,
  type StoredEmailRule,
} from "../rules-dsl/index.js";

let seq = 0;
function pin(conditions: unknown, lane: string, extra: Partial<StoredEmailRule> = {}) {
  seq += 1;
  return {
    id: `p${seq}`,
    name: `p${seq}`,
    description: null,
    isActive: true,
    conditions,
    actionType: "PIN_TIER",
    actionValue: lane,
    updatedAt: new Date(Date.UTC(2026, 10, 1, 0, seq)),
    ...extra,
  } satisfies StoredEmailRule;
}

function mail(id: string, sender: string, lane: DryRunMail["lane"], manual = false): DryRunMail {
  return { id, sender, subject: `subject ${id}`, lane, manual };
}

function rulesFrom(text: string) {
  const r = checkRules(`version 1\n${text}`);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.rules;
}

describe("pinnedTierFromRules (the judge's matcher)", () => {
  it("prefers an exact address over a domain, matches by equality, refuses public domains", () => {
    const rules = [
      { conditions: { fromDomain: ["x.co"] }, actionValue: "INFO" },
      { conditions: { from: ["Boss@x.co"] }, actionValue: "PUSH" },
      { conditions: { fromDomain: ["gmail.com"] }, actionValue: "PUSH" },
    ];
    expect(pinnedTierFromRules(rules, "boss@X.co")).toBe("PUSH");
    expect(pinnedTierFromRules(rules, "other@x.co")).toBe("INFO");
    expect(pinnedTierFromRules(rules, "a@sub.x.co")).toBeNull();
    expect(pinnedTierFromRules(rules, "a@gmail.com")).toBeNull();
    expect(pinnedTierFromRules(rules, "")).toBeNull();
  });
});

describe("dryRunRules", () => {
  const stored = [
    pin({ from: ["boss@x.co"] }, "PUSH"),
    pin({ fromDomain: ["news.io"] }, "SILENT"),
    pin({ from: ["off@x.co"] }, "PUSH", { isActive: false }),
    pin({ from: ["a@m.co", "b@m.co"] }, "MEETING"), // read-only, still read by the judge
  ];
  const inventory = buildInventory(stored, []);

  it("reports nothing for the unchanged rules", () => {
    const current = currentPinRules(stored);
    const proposed = proposedPinRules(rulesFrom(""), inventory.keptPins);
    const unchanged = proposedPinRules(
      inventory.editable.map(({ rowId: _r, duplicateIds: _d, ...rule }) => rule),
      inventory.keptPins,
    );
    const mails = [mail("1", "boss@x.co", "PUSH"), mail("2", "a@news.io", "SILENT")];
    expect(dryRunRules({ current, proposed: unchanged, mails })).toMatchObject({
      examined: 2,
      changed: 0,
      transitions: [],
      samples: [],
    });
    // And dropping every editable rule sends both back to the judge.
    expect(dryRunRules({ current, proposed, mails }).transitions).toEqual([
      { from: "PUSH", to: null, count: 1 },
      { from: "SILENT", to: null, count: 1 },
    ]);
  });

  it("counts lane changes per transition and lists samples", () => {
    const current = currentPinRules(stored);
    const proposed = proposedPinRules(
      rulesFrom(
        [
          'rule "Boss"\nwhen from address "boss@x.co"\nthen lane MEETING',
          'rule "News"\nwhen from domain "news.io"\nthen lane SILENT',
          'rule "New"\nwhen from domain "y.co"\nthen lane INFO',
          'rule "Off"\nwhen from address "off@x.co"\nthen lane PUSH\ndisabled',
        ].join("\n"),
      ),
      inventory.keptPins,
    );
    const mails = [
      mail("1", "boss@x.co", "PUSH"),
      mail("2", "boss@x.co", "PUSH"),
      mail("3", "a@news.io", "SILENT"),
      mail("4", "z@y.co", "QUEUE"),
      mail("5", "z@y.co", "INFO"),
      mail("6", "off@x.co", "QUEUE"),
      mail("7", "a@m.co", "MEETING"),
      mail("8", "boss@x.co", "QUEUE", true),
      mail("9", "", "QUEUE"),
    ];
    const result = dryRunRules({ current, proposed, mails });
    expect(result).toMatchObject({ examined: 9, changed: 3, manualKept: 1 });
    expect(result.transitions).toEqual([
      { from: "PUSH", to: "MEETING", count: 2 },
      { from: "QUEUE", to: "INFO", count: 1 },
    ]);
    expect(result.samples.map((s) => s.id)).toEqual(["1", "2", "4"]);
    expect(result.samples[0]).toEqual({
      id: "1",
      sender: "boss@x.co",
      subject: "subject 1",
      from: "PUSH",
      to: "MEETING",
    });
  });

  it("keeps the read-only pins in force on both sides", () => {
    const current = currentPinRules(stored);
    const proposed = proposedPinRules(
      rulesFrom('rule "m"\nwhen from address "a@m.co"\nthen lane INFO'),
      inventory.keptPins,
    );
    const result = dryRunRules({ current, proposed, mails: [mail("1", "b@m.co", "MEETING")] });
    expect(result.changed).toBe(0);
  });

  it("caps samples and cuts long subjects", () => {
    const current = currentPinRules([]);
    const proposed = proposedPinRules(
      rulesFrom('rule "a"\nwhen from domain "y.co"\nthen lane PUSH'),
      [],
    );
    const mails = Array.from({ length: 50 }, (_, i) => ({
      ...mail(String(i), "a@y.co", "QUEUE" as const),
      subject: "s".repeat(300),
    }));
    const result = dryRunRules({ current, proposed, mails, sampleLimit: 20 });
    expect(result.changed).toBe(50);
    expect(result.samples).toHaveLength(20);
    expect(result.samples[0]?.subject.length).toBeLessThanOrEqual(81);
  });
});
