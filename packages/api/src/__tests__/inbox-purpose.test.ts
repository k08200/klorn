/**
 * Inbox purpose (2026-08-31): the user declares what each mailbox is FOR at
 * connect time, and the analysis preamble follows it — the old text
 * hardcoded "a work inbox", which skewed category and priority on personal
 * accounts. Unset (and anything unknown) keeps the legacy preamble so
 * existing behavior is untouched until the user answers.
 */

import { describe, expect, it } from "vitest";
import { analysisPreamble } from "../mail/email-summarize.js";

describe("analysisPreamble", () => {
  it("a personal inbox is told it is one", () => {
    expect(analysisPreamble("personal")).toContain("PERSONAL inbox");
    expect(analysisPreamble("personal")).not.toContain("work inbox");
  });

  it("mixed asks for per-email judgment, no default context", () => {
    expect(analysisPreamble("mixed")).toContain("BOTH work and personal");
  });

  it("work is explicit; unset keeps the legacy wording exactly", () => {
    expect(analysisPreamble("work")).toContain("WORK inbox");
    expect(analysisPreamble(null)).toBe("You are Klorn's email triage analyst for a work inbox.");
    expect(analysisPreamble(undefined)).toBe(analysisPreamble(null));
    // Unknown strings (a rollback, a manual edit) degrade to legacy, never throw.
    expect(analysisPreamble("garbage")).toBe(analysisPreamble(null));
  });
});
