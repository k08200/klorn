/**
 * Triage priorities (2026-09-11): the user's own words about what matters,
 * reaching the judge and the summarize prompts. The contract: capped and
 * collapsed on the way in, quoted (never as an instruction) on the way out,
 * empty → byte-identical prompts, one read per user per minute.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  findUniqueCalls: 0,
  stored: "investor mail first" as string | null,
}));

vi.mock("../db.js", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async () => {
        state.findUniqueCalls += 1;
        return { triagePriorities: state.stored };
      }),
    },
  },
}));

import {
  fetchTriagePriorities,
  invalidateTriagePriorities,
  normalizeTriagePriorities,
  prioritiesJudgeBlock,
  prioritiesPreambleSentence,
  resetTriagePrioritiesCacheForTests,
  TRIAGE_PRIORITIES_MAX,
} from "../mail/triage-priorities.js";

describe("normalizeTriagePriorities", () => {
  it("collapses whitespace, strips control characters, keeps the words", () => {
    expect(normalizeTriagePriorities("  investor mail\n\n is  urgent\t ")).toEqual({
      text: "investor mail is urgent",
    });
  });

  it("null / empty clears; a non-string is refused", () => {
    expect(normalizeTriagePriorities(null)).toEqual({ text: null });
    expect(normalizeTriagePriorities("   \n ")).toEqual({ text: null });
    expect(normalizeTriagePriorities(42)).toEqual({ error: "text must be a string" });
  });

  it("refuses text past the cap instead of silently truncating a rule", () => {
    const long = "a".repeat(TRIAGE_PRIORITIES_MAX + 1);
    expect(normalizeTriagePriorities(long)).toEqual({
      error: `text must be at most ${TRIAGE_PRIORITIES_MAX} characters`,
    });
    expect(normalizeTriagePriorities("a".repeat(TRIAGE_PRIORITIES_MAX))).toEqual({
      text: "a".repeat(TRIAGE_PRIORITIES_MAX),
    });
  });
});

describe("prompt fragments", () => {
  it("quote the user's words as their statement; empty → nothing", () => {
    expect(prioritiesPreambleSentence("VC mail first")).toBe(
      ' The user has stated what matters to them (their own words, authoritative for priority and urgency): "VC mail first".',
    );
    expect(prioritiesPreambleSentence(null)).toBe("");
    expect(prioritiesJudgeBlock("")).toBe("");
    expect(prioritiesJudgeBlock("김대표 메일은 바로")).toContain('"김대표 메일은 바로"');
    expect(prioritiesJudgeBlock("x")).toContain("keep the JSON shape");
  });

  it("a double quote inside the text cannot close the quoted span", () => {
    expect(prioritiesJudgeBlock('say "urgent"')).toContain(`"say 'urgent'"`);
  });
});

describe("fetchTriagePriorities", () => {
  beforeEach(() => {
    resetTriagePrioritiesCacheForTests();
    state.findUniqueCalls = 0;
    state.stored = "investor mail first";
  });

  it("reads once per user per minute — a backfill must not query per email", async () => {
    expect(await fetchTriagePriorities("u1")).toBe("investor mail first");
    expect(await fetchTriagePriorities("u1")).toBe("investor mail first");
    expect(await fetchTriagePriorities("u1")).toBe("investor mail first");
    expect(state.findUniqueCalls).toBe(1);
  });

  it("a write invalidates, so the next judgement sees the new text", async () => {
    await fetchTriagePriorities("u1");
    state.stored = "newsletters can wait";
    expect(await fetchTriagePriorities("u1")).toBe("investor mail first");
    invalidateTriagePriorities("u1");
    expect(await fetchTriagePriorities("u1")).toBe("newsletters can wait");
    expect(state.findUniqueCalls).toBe(2);
  });
});
