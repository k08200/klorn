/**
 * The server renders the briefing's Top 3 under a localized header; the web
 * client finds that list by the literal "Top 3" token (use-briefing.ts
 * extractTopActions) to show per-rank feedback and the pick's "Open mail"
 * link. Every language's rendering must stay findable, with the action as
 * the label (the reason and the quote are cut at the dash).
 * Run from the api suite because the web package has no unit-test runner.
 */

import { describe, expect, it } from "vitest";
import { extractTopActions } from "../../../web/src/app/briefing/use-briefing";
import { NOTIFICATION_LANGUAGES } from "../notify/notification-strings.js";
import { briefingCopy } from "../pim/briefing-copy.js";
import { renderBriefingAnswer } from "../pim/briefing-picks.js";

describe("server-rendered Top 3 is what the web client parses", () => {
  it.each(NOTIFICATION_LANGUAGES)("%s", (lang) => {
    const text = renderBriefingAnswer(
      {
        signal: "Signal line.",
        picks: [
          { rank: 1, emailId: "e1", action: "Sign the contract", reason: "r", quote: "by Friday" },
          { rank: 2, emailId: "e2", action: "Pay invoice 42", reason: "due", quote: "Nov 30" },
        ],
        connected: [],
        other: ["1. not a pick"],
      },
      briefingCopy(lang),
    );
    expect(extractTopActions(text)).toEqual([
      { rank: 1, label: "Sign the contract" },
      { rank: 2, label: "Pay invoice 42" },
    ]);
  });
});
