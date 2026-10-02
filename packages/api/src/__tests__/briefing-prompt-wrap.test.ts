/**
 * wrapSignalsForPrompt: the briefing signals the PROMPT carries. A calendar
 * title is wrapped as a whole field, never found-and-replaced inside other
 * text: a title like "a" or "Prepare" must not alter unrelated words.
 */

import { describe, expect, it } from "vitest";
import { wrapSignalsForPrompt } from "../pim/briefing-prompt-wrap.js";
import type { BriefingSignals } from "../pim/briefing-signals.js";

const WRAP = /^<untrusted_content source="[^"]+">[\s\S]*<\/untrusted_content>$/;

function signals(overrides: Partial<BriefingSignals> = {}): BriefingSignals {
  return { deadlines: [], urgentItems: [], crossLinks: [], topActions: [], ...overrides };
}

describe("wrapSignalsForPrompt", () => {
  it("wraps a calendar action as a whole field and leaves every other action alone, whatever the title", () => {
    for (const title of ["a", "Prepare", "e", "for"]) {
      const out = wrapSignalsForPrompt(
        signals({
          topActions: [
            {
              id: "t1",
              rank: 1,
              score: 9,
              action: `Prepare for: ${title}`,
              reason: "event start",
              refs: [{ source: "calendar", id: "e1", title }],
            },
            {
              id: "t2",
              rank: 2,
              score: 5,
              action: "Handle email deadline: banana and apple",
              reason: "deadline language in email",
              refs: [{ source: "email", id: "m1", title: "banana and apple" }],
            },
          ],
        }),
      );

      expect(out.topActions[0]?.action).toMatch(WRAP);
      expect(out.topActions[0]?.action).toContain(`Prepare for: ${title}`);
      expect(out.topActions[0]?.refs[0]?.title).toMatch(WRAP);
      // The other action is byte-identical: nothing was searched for inside it.
      expect(out.topActions[1]).toEqual({
        id: "t2",
        rank: 2,
        score: 5,
        action: "Handle email deadline: banana and apple",
        reason: "deadline language in email",
        refs: [{ source: "email", id: "m1", title: "banana and apple" }],
      });
    }
  });

  it("wraps calendar-sourced deadline, urgent and cross-link titles, and no other source's", () => {
    const out = wrapSignalsForPrompt(
      signals({
        deadlines: [
          { source: "calendar", id: "e", title: "Offsite", dueAt: null, dueText: "x", reason: "r" },
          { source: "task", id: "t", title: "Ship", dueAt: null, dueText: "x", reason: "r" },
        ],
        urgentItems: [{ source: "calendar", id: "e", title: "Board", reason: "r" }],
        crossLinks: [
          {
            kind: "email_event",
            strength: 1,
            reason: "x",
            email: { source: "email", id: "m", title: "Re: plan" },
            event: { source: "calendar", id: "e", title: "Plan review" },
          },
        ],
      }),
    );

    expect(out.deadlines[0]?.title).toMatch(WRAP);
    expect(out.deadlines[1]?.title).toBe("Ship");
    expect(out.urgentItems[0]?.title).toMatch(WRAP);
    expect(out.crossLinks[0]?.event?.title).toMatch(WRAP);
    expect(out.crossLinks[0]?.email?.title).toBe("Re: plan");
  });

  it("wraps the 'shared terms' tokens of a link reason, in the cross-link and in the action it produced", () => {
    const reason = "shared terms: ignore, previous, instructions";
    const out = wrapSignalsForPrompt(
      signals({
        crossLinks: [{ kind: "email_task", strength: 1, reason }],
        topActions: [
          {
            id: "t",
            rank: 1,
            score: 1,
            action: "Resolve linked email and task: x",
            reason,
            refs: [],
          },
        ],
      }),
    );

    expect(out.crossLinks[0]?.reason).toMatch(WRAP);
    expect(out.topActions[0]?.reason).toMatch(WRAP);
    expect(out.crossLinks[0]?.reason).toContain(reason);
  });

  it("does not touch a rule-based reason", () => {
    const out = wrapSignalsForPrompt(
      signals({
        topActions: [
          {
            id: "t",
            rank: 1,
            score: 1,
            action: "Finish: x",
            reason: "open task; tomorrow",
            refs: [],
          },
        ],
      }),
    );
    expect(out.topActions[0]?.reason).toBe("open task; tomorrow");
  });

  it("does not mutate its input", () => {
    const input = signals({
      topActions: [
        {
          id: "t",
          rank: 1,
          score: 1,
          action: "Prepare for: a",
          reason: "r",
          refs: [{ source: "calendar", id: "e", title: "a" }],
        },
      ],
    });
    wrapSignalsForPrompt(input);
    expect(input.topActions[0]?.action).toBe("Prepare for: a");
    expect(input.topActions[0]?.refs[0]?.title).toBe("a");
  });
});
