import { describe, expect, it } from "vitest";
import {
  DOGFOOD_BRIEFING_NOW,
  dogfoodBriefingFixture,
  expectedDogfoodTopActionRefs,
} from "../__fixtures__/briefing/dogfood.js";
import { buildBriefingSignals } from "../briefing-signals.js";

const NOW = new Date("2026-04-28T09:00:00.000Z");

describe("buildBriefingSignals", () => {
  it("extracts deterministic deadline and urgency signals", () => {
    const signals = buildBriefingSignals(
      {
        tasks: {
          tasks: [
            {
              id: "task-1",
              title: "Investor deck update",
              status: "TODO",
              priority: "HIGH",
              dueDate: "2026-04-28T12:00:00.000Z",
            },
          ],
        },
        events: { events: [] },
        emails: {
          emails: [
            {
              id: "email-1",
              from: "sarah@example.com",
              subject: "Urgent: contract review due tomorrow",
              snippet: "Please send this by tomorrow.",
            },
          ],
        },
      },
      { now: NOW },
    );

    expect(signals.deadlines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "task",
          id: "task-1",
          dueAt: "2026-04-28T12:00:00.000Z",
        }),
        expect.objectContaining({
          source: "email",
          id: "email-1",
          dueText: "tomorrow",
          reason: "deadline language in email",
        }),
      ]),
    );
    expect(signals.urgentItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "task", id: "task-1", reason: "HIGH priority" }),
        expect.objectContaining({ source: "email", id: "email-1" }),
      ]),
    );
  });

  it("links emails, tasks, and events through shared work context", () => {
    const signals = buildBriefingSignals(
      {
        tasks: {
          tasks: [
            {
              id: "task-1",
              title: "PartnerCo deck update",
              status: "TODO",
              priority: "MEDIUM",
              dueDate: "2026-04-28T12:00:00.000Z",
            },
          ],
        },
        events: {
          events: [
            {
              id: "event-1",
              summary: "PartnerCo kickoff",
              start: "2026-04-28T13:00:00.000Z",
              end: "2026-04-28T14:00:00.000Z",
            },
          ],
        },
        emails: {
          emails: [
            {
              id: "email-1",
              from: "minsu@partnerco.com",
              subject: "PartnerCo kickoff agenda",
              snippet: "Let's cover metrics and deck updates.",
            },
          ],
        },
      },
      { now: NOW },
    );

    expect(signals.crossLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "email_task",
          email: expect.objectContaining({ id: "email-1" }),
          task: expect.objectContaining({ id: "task-1" }),
        }),
        expect.objectContaining({
          kind: "email_event",
          email: expect.objectContaining({ id: "email-1" }),
          event: expect.objectContaining({ id: "event-1" }),
        }),
        expect.objectContaining({
          kind: "task_event",
          reason: expect.stringContaining("task due before event"),
          task: expect.objectContaining({ id: "task-1" }),
          event: expect.objectContaining({ id: "event-1" }),
        }),
      ]),
    );
  });

  it("skips completed tasks when building action links", () => {
    const signals = buildBriefingSignals(
      {
        tasks: {
          tasks: [
            {
              id: "done-task",
              title: "PartnerCo deck update",
              status: "DONE",
              priority: "URGENT",
              dueDate: "2026-04-28T12:00:00.000Z",
            },
          ],
        },
        events: { events: [{ id: "event-1", summary: "PartnerCo kickoff" }] },
        emails: { emails: [{ id: "email-1", subject: "PartnerCo agenda", snippet: "" }] },
      },
      { now: NOW },
    );

    expect(signals.urgentItems).toHaveLength(0);
    expect(signals.crossLinks.some((link) => link.kind === "email_task")).toBe(false);
    expect(signals.crossLinks.some((link) => link.kind === "task_event")).toBe(false);
  });

  it("builds a deterministic top 3 from scores instead of leaving ranking to the LLM", () => {
    const signals = buildBriefingSignals(dogfoodBriefingFixture, {
      now: DOGFOOD_BRIEFING_NOW,
    });

    expect(signals.topActions).toHaveLength(3);
    expect(signals.topActions.map((action) => action.rank)).toEqual([1, 2, 3]);
    expect(
      signals.topActions.map((action) => `${action.refs[0]?.source}:${action.refs[0]?.id}`),
    ).toEqual(expectedDogfoodTopActionRefs);
    expect(signals.topActions[0]).toMatchObject({
      action: "Finish task before event: Investor deck update",
      score: 96,
      reason: "shared terms: investor; task due before event",
    });
    expect(signals.topActions[1]?.refs.map((item) => item.id)).toEqual([
      "task-partnerco-deck",
      "event-partnerco",
    ]);
    expect(signals.crossLinks.some((link) => link.email?.id === "email-partnerco")).toBe(true);
  });

  it("strips <untrusted_content> wrappers from event titles so the rule-based view stays readable", () => {
    const signals = buildBriefingSignals(
      {
        tasks: { tasks: [] },
        emails: { emails: [] },
        events: {
          events: [
            {
              id: "evt-1",
              summary:
                '<untrusted_content source="calendar:summary">생일 축하합니다!</untrusted_content>',
              start: "2026-04-28T10:00:00.000Z",
            },
          ],
        },
      },
      { now: NOW },
    );

    const titles = [
      ...signals.deadlines.map((d) => d.title),
      ...signals.topActions.map((a) => a.action),
      ...signals.topActions.map((a) => a.reason),
      ...signals.crossLinks.map((l) => l.reason),
    ];
    for (const text of titles) {
      expect(text).not.toContain("<untrusted_content");
      expect(text).not.toContain("</untrusted_content>");
    }
    expect(signals.deadlines[0]?.title).toBe("생일 축하합니다!");
  });

  it("dedups repeated calendar items so Top 3 cannot be filled with the same action three times", () => {
    const signals = buildBriefingSignals(
      {
        tasks: { tasks: [] },
        emails: { emails: [] },
        events: {
          events: [
            { id: "b1", summary: "생일 축하합니다!", start: "2026-04-28T01:00:00.000Z" },
            { id: "b2", summary: "생일 축하합니다!", start: "2026-04-28T02:00:00.000Z" },
            { id: "b3", summary: "생일 축하합니다!", start: "2026-04-28T03:00:00.000Z" },
            { id: "b4", summary: "생일 축하합니다!", start: "2026-04-28T04:00:00.000Z" },
          ],
        },
      },
      { now: NOW },
    );

    const distinctActions = new Set(signals.topActions.map((a) => a.action));
    expect(distinctActions.size).toBe(signals.topActions.length);
  });
});
