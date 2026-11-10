// Pins packages/web/src/lib/tool-labels.ts. The web package has no unit-test
// runner (Playwright e2e only), so its pure helper is exercised from here —
// same arrangement as web-meeting-link.test.ts. The helper and the locale
// tables have no imports, which keeps the cross-package import trivial.
import { describe, expect, it } from "vitest";
import de from "../../../web/src/lib/locales/de";
import en from "../../../web/src/lib/locales/en";
import es from "../../../web/src/lib/locales/es";
import fr from "../../../web/src/lib/locales/fr";
import ja from "../../../web/src/lib/locales/ja";
import ko from "../../../web/src/lib/locales/ko";
import zh from "../../../web/src/lib/locales/zh";
import {
  KNOWN_TOOL_IDS,
  toolLabelKey,
  UNKNOWN_TOOL_LABEL_KEY,
} from "../../../web/src/lib/tool-labels";

const LOCALES = { en, ko, ja, zh, es, fr, de } as const;

describe("toolLabelKey", () => {
  it("maps a known tool id to its own label key", () => {
    expect(toolLabelKey("send_email")).toBe("tool.label.send_email");
    expect(toolLabelKey("create_event")).toBe("tool.label.create_event");
    expect(toolLabelKey("prepared_action")).toBe("tool.label.prepared_action");
  });

  it("falls back to the generic Action key for an unknown id", () => {
    expect(toolLabelKey("create_task_and_optional_reminder_single_highlight")).toBe(
      UNKNOWN_TOOL_LABEL_KEY,
    );
    expect(toolLabelKey("")).toBe(UNKNOWN_TOOL_LABEL_KEY);
    expect(toolLabelKey(null)).toBe(UNKNOWN_TOOL_LABEL_KEY);
    expect(toolLabelKey(undefined)).toBe(UNKNOWN_TOOL_LABEL_KEY);
  });

  it("does not resolve inherited object properties as tool ids", () => {
    expect(toolLabelKey("constructor")).toBe(UNKNOWN_TOOL_LABEL_KEY);
    expect(toolLabelKey("__proto__")).toBe(UNKNOWN_TOOL_LABEL_KEY);
    expect(toolLabelKey("toString")).toBe(UNKNOWN_TOOL_LABEL_KEY);
  });

  it("never returns a raw tool id", () => {
    for (const id of KNOWN_TOOL_IDS) {
      expect(toolLabelKey(id)).not.toBe(id);
    }
  });
});

describe("tool label keys in every shipped locale", () => {
  const keys = [...KNOWN_TOOL_IDS.map((id) => toolLabelKey(id)), UNKNOWN_TOOL_LABEL_KEY];

  for (const [locale, table] of Object.entries(LOCALES)) {
    it(`${locale} has a non-empty, non-id label for every key`, () => {
      for (const key of keys) {
        const label = table[key];
        expect(label, `${locale} ${key}`).toBeTruthy();
        expect(label).not.toMatch(/_/);
      }
    });
  }
});
