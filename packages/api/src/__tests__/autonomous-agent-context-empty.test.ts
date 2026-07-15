import { describe, expect, it } from "vitest";
import { isAgentContextEmpty } from "../agentcore/autonomous-agent.js";

/**
 * A total gatherUserContext failure (its own outer catch fires, see
 * agent-context.ts) used to fall through runAgentForUser's skip check as a
 * NON-empty context — "" doesn't contain "## Open Tasks\nNone" — so instead
 * of skipping the tick the way every other failure mode does, it triggered a
 * real, paid LLM call with a blank user message.
 */
describe("isAgentContextEmpty", () => {
  it("treats a total context failure (empty string) as empty — skip the tick, don't spend on it", () => {
    expect(isAgentContextEmpty("")).toBe(true);
  });

  it("is empty when there are no tasks, no calendar events, and no emails", () => {
    const context = "## Open Tasks\nNone\n\n## Upcoming Calendar\nNone\n\n## Current Time\n...";
    expect(isAgentContextEmpty(context)).toBe(true);
  });

  it("is NOT empty when there are open tasks", () => {
    const context = "## Open Tasks (2)\n- [MEDIUM] Do the thing\n\n## Upcoming Calendar\nNone";
    expect(isAgentContextEmpty(context)).toBe(false);
  });

  it("is NOT empty when there are calendar events", () => {
    const context = "## Open Tasks\nNone\n\n## Upcoming Calendar (next 7 days)\n- Standup @ 9am";
    expect(isAgentContextEmpty(context)).toBe(false);
  });

  it("is NOT empty when there are recent emails, even with no tasks/calendar", () => {
    const context =
      "## Open Tasks\nNone\n\n## Upcoming Calendar\nNone\n\n## Recent Emails (1)\n### Email #1...";
    expect(isAgentContextEmpty(context)).toBe(false);
  });
});
