import { describe, expect, it } from "vitest";
import { onInterrupt, runInterruptTasks } from "../lib/cleanup.js";

describe("interrupt cleanups", () => {
  it("runs registered tasks once and skips released ones", () => {
    const ran: string[] = [];
    onInterrupt(() => ran.push("a"));
    const release = onInterrupt(() => ran.push("b"));
    release();
    runInterruptTasks();
    runInterruptTasks();
    expect(ran).toEqual(["a"]);
  });

  it("keeps going when one task throws", () => {
    const ran: string[] = [];
    onInterrupt(() => {
      throw new Error("boom");
    });
    onInterrupt(() => ran.push("after"));
    runInterruptTasks();
    expect(ran).toEqual(["after"]);
  });
});
