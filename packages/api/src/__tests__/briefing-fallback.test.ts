import { describe, expect, it } from "vitest";
import { buildSignalOnlyBriefing } from "../briefing.js";
import type { BriefingSignals } from "../briefing-signals.js";

const EMPTY_SIGNALS: BriefingSignals = {
  deadlines: [],
  urgentItems: [],
  crossLinks: [],
  topActions: [],
};

describe("buildSignalOnlyBriefing", () => {
  it("returns a calm placeholder when no signals exist", () => {
    const out = buildSignalOnlyBriefing(EMPTY_SIGNALS);
    expect(out).toMatch(/AI summary unavailable/i);
    expect(out).toMatch(/Nothing urgent/);
  });

  it("renders top actions as a numbered Top 3 list", () => {
    const signals: BriefingSignals = {
      ...EMPTY_SIGNALS,
      topActions: [
        {
          id: "a1",
          rank: 1,
          score: 10,
          action: "Reply to Alpha Capital",
          reason: "follow-up due today",
          refs: [],
        },
        {
          id: "a2",
          rank: 2,
          score: 8,
          action: "Read Notion notes",
          reason: "3pm call prep",
          refs: [],
        },
      ],
    };
    const out = buildSignalOnlyBriefing(signals);
    expect(out).toMatch(/Top 3 Today/);
    expect(out).toMatch(/1\. Reply to Alpha Capital — follow-up due today/);
    expect(out).toMatch(/2\. Read Notion notes — 3pm call prep/);
  });

  it("lists deadlines and urgent items as separate sections", () => {
    const signals: BriefingSignals = {
      ...EMPTY_SIGNALS,
      deadlines: [
        {
          source: "task",
          id: "t1",
          title: "Ship Q3 deck",
          dueAt: null,
          dueText: "tomorrow",
          reason: "investor meeting Wednesday",
        },
      ],
      urgentItems: [
        {
          source: "email",
          id: "e1",
          title: "Legal review needed",
          reason: "blocking signature",
        },
      ],
    };
    const out = buildSignalOnlyBriefing(signals);
    expect(out).toMatch(/\*\*Deadlines\*\*/);
    expect(out).toMatch(/Ship Q3 deck \(tomorrow\) — investor meeting Wednesday/);
    expect(out).toMatch(/\*\*Urgent\*\*/);
    expect(out).toMatch(/Legal review needed — blocking signature/);
  });

  it("dedups deadlines by title so repeated calendar entries cannot fill the section", () => {
    const signals: BriefingSignals = {
      ...EMPTY_SIGNALS,
      deadlines: [
        {
          source: "calendar",
          id: "b1",
          title: "생일 축하합니다!",
          dueAt: null,
          dueText: "event start",
          reason: "scheduled today/upcoming",
        },
        {
          source: "calendar",
          id: "b2",
          title: "생일 축하합니다!",
          dueAt: null,
          dueText: "event start",
          reason: "scheduled today/upcoming",
        },
        {
          source: "calendar",
          id: "b3",
          title: "생일 축하합니다!",
          dueAt: null,
          dueText: "event start",
          reason: "scheduled today/upcoming",
        },
      ],
    };
    const out = buildSignalOnlyBriefing(signals);
    const matches = out.match(/생일 축하합니다!/g) || [];
    expect(matches.length).toBe(1);
  });

  it("caps top actions at 3 and deadlines at 5 to keep output one-screen", () => {
    const signals: BriefingSignals = {
      ...EMPTY_SIGNALS,
      topActions: Array.from({ length: 6 }, (_, i) => ({
        id: `a${i}`,
        rank: i + 1,
        score: 10 - i,
        action: `Action ${i + 1}`,
        reason: `reason ${i + 1}`,
        refs: [],
      })),
      deadlines: Array.from({ length: 8 }, (_, i) => ({
        source: "task" as const,
        id: `t${i}`,
        title: `Deadline ${i + 1}`,
        dueAt: null,
        dueText: "soon",
        reason: `reason ${i + 1}`,
      })),
    };
    const out = buildSignalOnlyBriefing(signals);
    // Top 3 actions only
    expect(out).toMatch(/3\. Action 3 — reason 3/);
    expect(out).not.toMatch(/4\. Action 4/);
    // Up to 5 deadlines
    expect(out).toMatch(/Deadline 5 \(soon\)/);
    expect(out).not.toMatch(/Deadline 6 \(soon\)/);
  });
});
