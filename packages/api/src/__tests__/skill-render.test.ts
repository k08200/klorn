import { describe, expect, it } from "vitest";
import { MAX_SKILL_VARIABLE_LENGTH, renderSkillTemplate } from "../agentcore/skill-render.js";

describe("renderSkillTemplate", () => {
  it("substitutes {{key}} placeholders with their values", () => {
    expect(renderSkillTemplate("Hello {{name}}!", { name: "Alex" })).toBe("Hello Alex!");
  });

  it("replaces every occurrence of a placeholder", () => {
    expect(renderSkillTemplate("{{x}}-{{x}}", { x: "1" })).toBe("1-1");
  });

  it("returns the template unchanged when variables is undefined", () => {
    expect(renderSkillTemplate("no vars {{x}}", undefined)).toBe("no vars {{x}}");
  });

  it("treats a regex-metacharacter key as a literal, not a pattern", () => {
    // A key like `(a+)+` must match the literal text `{{(a+)+}}`, never act as
    // a regex — the crux of the ReDoS fix.
    expect(renderSkillTemplate("x {{(a+)+}} y", { "(a+)+": "Z" })).toBe("x Z y");
    // A hostile key that is NOT literally present leaves the template untouched.
    expect(renderSkillTemplate("aaaaaaaa", { "(a+)+": "Z" })).toBe("aaaaaaaa");
  });

  it("does not catastrophically backtrack on a hostile key + long input (ReDoS regression)", () => {
    // The old `new RegExp('\\{\\{' + key + '\\}\\}')` blocked the event loop for
    // seconds-to-hours on this exact input; split/join is linear. A generous
    // 500ms budget that the vulnerable version blew past by orders of magnitude.
    const template = "{{".concat("a".repeat(50), "!");
    const start = Date.now();
    renderSkillTemplate(template, { "(a+)+": "Z" });
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("stringifies non-string values from an untyped JSON body", () => {
    expect(renderSkillTemplate("n={{n}}", { n: 42 as unknown as string })).toBe("n=42");
  });

  it("caps each variable value length to bound output size (memory-amplification guard)", () => {
    const huge = "b".repeat(MAX_SKILL_VARIABLE_LENGTH + 500);
    expect(renderSkillTemplate("{{x}}", { x: huge }).length).toBe(MAX_SKILL_VARIABLE_LENGTH);
  });
});
