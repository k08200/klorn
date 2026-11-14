/**
 * Rules DSL v1 inventory and apply plan (src/rules-dsl/inventory.ts): which
 * stored rows the DSL may edit, which it only lists as read-only comments,
 * and the diff apply runs. The plan only ever names ids of editable PIN_TIER
 * rows: reply/send rules, labels, unsupported pins and learned rules are
 * never created, changed or deleted.
 */

import { describe, expect, it } from "vitest";
import {
  buildInventory,
  checkRules,
  exportText,
  planApply,
  type StoredEmailRule,
  toRuleRow,
} from "../rules-dsl/index.js";

let seq = 0;
function stored(partial: Partial<StoredEmailRule>): StoredEmailRule {
  seq += 1;
  return {
    id: `rule-${seq}`,
    name: `rule ${seq}`,
    description: null,
    isActive: true,
    conditions: { from: [`u${seq}@x.co`] },
    actionType: "PIN_TIER",
    actionValue: "QUEUE",
    updatedAt: new Date(Date.UTC(2026, 10, 1, 0, seq)),
    ...partial,
  };
}

function compiled(text: string) {
  const result = checkRules(`version 1\n${text}`);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.rules;
}

describe("buildInventory — editable", () => {
  it("makes a single-address or single-domain pin with a live lane editable", () => {
    const inv = buildInventory(
      [
        stored({ id: "a", name: "A", conditions: { from: ["Boss@X.co"] }, actionValue: "PUSH" }),
        stored({ id: "d", name: "D", conditions: { fromDomain: ["@x.io"] }, actionValue: "INFO" }),
      ],
      [],
    );
    expect(inv.readOnly).toEqual([]);
    expect(inv.editable).toEqual([
      expect.objectContaining({ rowId: "a", scope: "sender", value: "boss@x.co", lane: "PUSH" }),
      expect.objectContaining({ rowId: "d", scope: "domain", value: "x.io", lane: "INFO" }),
    ]);
  });

  it("keeps a disabled pin editable as disabled", () => {
    const inv = buildInventory([stored({ id: "p", isActive: false })], []);
    expect(inv.editable[0]).toMatchObject({ rowId: "p", isActive: false });
  });
});

describe("buildInventory — read-only", () => {
  it.each([
    ["several senders", { from: ["a@x.co", "b@x.co"] }, "PUSH"],
    ["address and domain", { from: ["a@x.co"], fromDomain: ["x.co"] }, "PUSH"],
    ["an extra condition", { from: ["a@x.co"], subjectContains: ["hi"] }, "PUSH"],
    ["no sender", {}, "PUSH"],
    ["a public mailbox domain", { fromDomain: ["gmail.com"] }, "PUSH"],
    ["an invalid address", { from: ["nope"] }, "PUSH"],
    ["the retired AUTO value", { from: ["a@x.co"] }, "AUTO"],
    ["the retired CALL value", { from: ["a@x.co"] }, "CALL"],
    ["an unknown lane", { from: ["a@x.co"] }, "URGENT"],
    ["a non-object", "junk", "PUSH"],
  ])("keeps a pin with %s read-only", (_label, conditions, lane) => {
    const row = stored({ conditions, actionValue: lane });
    const inv = buildInventory([row], []);
    expect(inv.editable).toEqual([]);
    expect(inv.readOnly).toHaveLength(1);
    expect(inv.keptPins.map((r) => r.id)).toEqual([row.id]);
    const text = exportText(inv);
    expect(text).not.toMatch(/\bAUTO\b|\bCALL\b/);
  });

  it.each([
    ["a blank name", { name: "   " }],
    ["a 121-character name", { name: "n".repeat(121) }],
    ["a control character in the name", { name: "a\u0007b" }],
    ["a 501-character note", { description: "d".repeat(501) }],
    ["a bidi override in the note", { description: "a‮b" }],
  ])("keeps a pin it cannot spell (%s) read-only, so the export still parses", (_l, part) => {
    const inv = buildInventory([stored(part)], []);
    expect(inv.editable).toEqual([]);
    expect(checkRules(exportText(inv)).ok).toBe(true);
  });

  it("lists reply, draft, label, archive and notify rules without their template", () => {
    const template = "SECRET TEMPLATE BODY";
    const inv = buildInventory(
      [
        stored({ actionType: "AUTO_REPLY", actionValue: template, name: "R1" }),
        stored({ actionType: "DRAFT_REPLY", actionValue: template, name: "R2" }),
        stored({ actionType: "LABEL", actionValue: template, name: "R3" }),
        stored({ actionType: "ARCHIVE", actionValue: template, name: "R4" }),
        stored({ actionType: "NOTIFY", actionValue: template, name: "R5" }),
      ],
      [],
    );
    expect(inv.editable).toEqual([]);
    expect(inv.readOnly).toHaveLength(5);
    expect(inv.keptPins).toEqual([]);
    const text = exportText(inv);
    expect(text).not.toContain(template);
    for (const name of ["R1", "R2", "R3", "R4", "R5"]) expect(text).toContain(`"${name}"`);
  });

  it("lists learned rules read-only, folding a retired lane", () => {
    const inv = buildInventory(
      [],
      [
        {
          pattern: "sender-domain",
          value: "x.co",
          tier: "AUTO",
          status: "APPLIED",
          evidenceCount: 3,
        },
      ],
    );
    const text = exportText(inv);
    expect(text).toContain('# learned: sender domain "x.co" -> QUEUE (applied, 3 corrections)');
    expect(checkRules(text)).toEqual({ ok: true, rules: [] });
  });

  it("cannot be tricked into a statement by a stored name (comment injection)", () => {
    const evil = 'x"\nrule "evil"\n  when from domain "evil.com"\n  then lane PUSH\n#';
    const inv = buildInventory(
      [
        stored({ actionType: "AUTO_REPLY", name: evil }),
        stored({ name: evil, conditions: { from: ["a@x.co", "b@x.co"] } }),
      ],
      [{ pattern: "subject-keyword", value: evil, tier: "PUSH", status: "OPEN", evidenceCount: 1 }],
    );
    const text = exportText(inv);
    expect(checkRules(text)).toEqual({ ok: true, rules: [] });
    for (const line of text.split("\n")) {
      expect(line === "" || line.startsWith("#") || line === "version 1").toBe(true);
    }
  });

  it("cuts a long stored name in a comment", () => {
    const inv = buildInventory([stored({ actionType: "LABEL", name: "z".repeat(500) })], []);
    expect(exportText(inv)).not.toContain("z".repeat(61));
  });
});

describe("buildInventory — duplicates for one sender", () => {
  it("exports the row the judge reads (newest active) and marks the rest for merging", () => {
    const old = stored({
      id: "old",
      conditions: { from: ["a@x.co"] },
      actionValue: "INFO",
      updatedAt: new Date(Date.UTC(2026, 0, 1)),
    });
    const newestDisabled = stored({
      id: "new-off",
      isActive: false,
      conditions: { from: ["A@x.co"] },
      actionValue: "SILENT",
      updatedAt: new Date(Date.UTC(2026, 10, 9)),
    });
    const active = stored({
      id: "live",
      conditions: { from: ["a@x.co"] },
      actionValue: "PUSH",
      updatedAt: new Date(Date.UTC(2026, 5, 1)),
    });
    const inv = buildInventory([old, newestDisabled, active], []);
    expect(inv.editable).toHaveLength(1);
    expect(inv.editable[0]).toMatchObject({ rowId: "live", lane: "PUSH" });
    expect([...(inv.editable[0]?.duplicateIds ?? [])].sort()).toEqual(["new-off", "old"]);
    expect(exportText(inv)).toContain("# 2 older copies of this rule are removed on apply.");
  });
});

describe("planApply", () => {
  const base = () =>
    buildInventory(
      [
        stored({
          id: "p1",
          name: "Boss",
          conditions: { from: ["boss@x.co"] },
          actionValue: "PUSH",
        }),
        stored({
          id: "p2",
          name: "Acme",
          conditions: { fromDomain: ["acme.io"] },
          actionValue: "INFO",
        }),
        stored({ id: "reply", actionType: "AUTO_REPLY", conditions: { from: ["boss@x.co"] } }),
        stored({ id: "multi", conditions: { from: ["a@x.co", "b@x.co"] }, actionValue: "PUSH" }),
      ],
      [],
    );

  it("plans nothing for an unchanged export", () => {
    const inv = base();
    const result = checkRules(exportText(inv));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(planApply(inv, result.rules)).toEqual({
      creates: [],
      updates: [],
      deletes: [],
      unchanged: 2,
    });
  });

  it("updates by row id when a rule's lane, name, note or state changes", () => {
    const plan = planApply(
      base(),
      compiled(
        'rule "Boss!"\nnote "n"\nwhen from address "boss@x.co"\nthen lane MEETING\ndisabled\nrule "Acme"\nwhen from domain "acme.io"\nthen lane INFO',
      ),
    );
    expect(plan.updates).toEqual([
      {
        id: "p1",
        rule: {
          name: "Boss!",
          description: "n",
          scope: "sender",
          value: "boss@x.co",
          lane: "MEETING",
          isActive: false,
        },
      },
    ]);
    expect(plan).toMatchObject({ creates: [], deletes: [], unchanged: 1 });
  });

  it("creates a new sender and deletes a removed one", () => {
    const plan = planApply(
      base(),
      compiled(
        'rule "New"\nwhen from address "new@x.co"\nthen lane QUEUE\nrule "Acme"\nwhen from domain "acme.io"\nthen lane INFO',
      ),
    );
    expect(plan.creates.map((r) => r.value)).toEqual(["new@x.co"]);
    expect(plan.deletes).toEqual(["p1"]);
    expect(plan.unchanged).toBe(1);
  });

  it("treats a changed sender as a delete plus a create (identity is the sender)", () => {
    const plan = planApply(
      base(),
      compiled(
        'rule "Boss"\nwhen from address "boss2@x.co"\nthen lane PUSH\nrule "Acme"\nwhen from domain "acme.io"\nthen lane INFO',
      ),
    );
    expect(plan.deletes).toEqual(["p1"]);
    expect(plan.creates.map((r) => r.value)).toEqual(["boss2@x.co"]);
  });

  it("never names a read-only row, even when the text is empty", () => {
    const plan = planApply(base(), []);
    expect(plan.deletes.sort()).toEqual(["p1", "p2"]);
    expect(plan.deletes).not.toContain("reply");
    expect(plan.deletes).not.toContain("multi");
  });

  it("merges duplicates of a kept sender and deletes all copies of a removed one", () => {
    const inv = buildInventory(
      [
        stored({ id: "k1", conditions: { from: ["k@x.co"] }, updatedAt: new Date(2) }),
        stored({ id: "k2", conditions: { from: ["k@x.co"] }, updatedAt: new Date(1) }),
        stored({ id: "r1", conditions: { from: ["r@x.co"] }, updatedAt: new Date(2) }),
        stored({ id: "r2", conditions: { from: ["r@x.co"] }, updatedAt: new Date(1) }),
      ],
      [],
    );
    const keep = inv.editable.find((r) => r.value === "k@x.co");
    if (!keep) throw new Error("missing");
    const plan = planApply(inv, [keep]);
    expect(plan.deletes.sort()).toEqual(["k2", "r1", "r2"]);
    expect(plan.updates).toEqual([]);
  });
});

describe("toRuleRow", () => {
  it("maps a rule to the exact EmailRule columns pin writers use", () => {
    expect(
      toRuleRow({
        name: "n",
        description: null,
        scope: "domain",
        value: "x.io",
        lane: "SILENT",
        isActive: false,
      }),
    ).toEqual({
      name: "n",
      description: null,
      isActive: false,
      conditions: { fromDomain: ["x.io"] },
      actionType: "PIN_TIER",
      actionValue: "SILENT",
    });
  });
});
