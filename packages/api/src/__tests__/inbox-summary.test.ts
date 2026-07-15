import { describe, expect, it } from "vitest";
import { buildTodaySection, type EventInput, type TaskInput } from "../pim/inbox-summary.js";

const NOW = new Date("2026-04-28T10:00:00Z").getTime();
// startOfToday uses local time, so derive TODAY_START the same way the
// production code does — otherwise tests are timezone-fragile.
const TODAY_START = (() => {
  const d = new Date(NOW);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
})();

function task(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    id: "t-1",
    title: "Sample task",
    status: "TODO",
    priority: "MEDIUM",
    dueDate: null,
    ...overrides,
  };
}

function event(overrides: Partial<EventInput> = {}): EventInput {
  return {
    id: "e-1",
    title: "Sample event",
    startTime: new Date(NOW + 30 * 60_000).toISOString(),
    location: null,
    ...overrides,
  };
}

describe("buildTodaySection", () => {
  it("separates overdue from today-due tasks", () => {
    const overdueDue = new Date(TODAY_START - 24 * 60 * 60 * 1000).toISOString();
    const todayDue = new Date(NOW + 60 * 60_000).toISOString();
    const section = buildTodaySection({
      tasks: [
        task({ id: "overdue", dueDate: overdueDue }),
        task({ id: "today", dueDate: todayDue }),
        task({ id: "no-due" }),
        task({ id: "done", status: "DONE", dueDate: todayDue }),
      ],
      events: [
        event({ id: "today-event", startTime: new Date(NOW + 60 * 60_000).toISOString() }),
        event({
          id: "tomorrow-event",
          startTime: new Date(NOW + 30 * 60 * 60 * 1000).toISOString(),
        }),
      ],
      now: NOW,
    });

    expect(section.overdueTasks.map((t) => t.id)).toEqual(["overdue"]);
    expect(section.todayTasks.map((t) => t.id)).toEqual(["today"]);
    expect(section.events.map((e) => e.id)).toEqual(["today-event"]);
  });
});
