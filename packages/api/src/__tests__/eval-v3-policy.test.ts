import { describe, expect, it } from "vitest";
import type { FactsV1 } from "../eval-v3/facts-schema.js";
import { laneFromFacts } from "../eval-v3/policy.js";

const RECEIVED = new Date("2026-06-01T14:00:00Z");

function facts(over: Partial<FactsV1> = {}): FactsV1 {
  return {
    asks: [],
    addressedTo: "me_direct",
    threadTurn: "none",
    event: null,
    transaction: null,
    risk: [],
    kind: "notification",
    ambiguous: false,
    ...over,
  };
}

function ask(due: string | null, kind: FactsV1["asks"][number]["kind"] = "reply") {
  return { kind, object: "x", due, evidence: "x" };
}

const lane = (f: FactsV1, spam = false) => laneFromFacts(f, { receivedAt: RECEIVED, spam });

describe("laneFromFacts — doc §3(4) without budget or ranking", () => {
  it("PUSH: an ask due within 24h, addressed to me", () => {
    expect(lane(facts({ asks: [ask("2026-06-02T09:00:00Z")], kind: "work_thread" }))).toEqual({
      lane: "PUSH",
      rule: "push:deadline",
    });
  });

  it("PUSH: an overdue ask still interrupts", () => {
    expect(lane(facts({ asks: [ask("2026-05-31T09:00:00Z")] })).lane).toBe("PUSH");
  });

  it("QUEUE, not PUSH: the deadline is four days out", () => {
    expect(lane(facts({ asks: [ask("2026-06-05T23:59:00Z")], kind: "work_thread" }))).toEqual({
      lane: "QUEUE",
      rule: "queue:ask",
    });
  });

  it("QUEUE, not PUSH: an ask with no due date", () => {
    expect(lane(facts({ asks: [ask(null)] })).lane).toBe("QUEUE");
  });

  it("PUSH: a security alert or failed payment addressed to me", () => {
    expect(lane(facts({ risk: ["security_alert"] }))).toEqual({ lane: "PUSH", rule: "push:risk" });
    expect(lane(facts({ risk: ["payment_failed"] })).lane).toBe("PUSH");
  });

  it("no PUSH for a group or bulk recipient, even with a deadline", () => {
    expect(lane(facts({ addressedTo: "group", asks: [ask("2026-06-01T18:00:00Z")] })).lane).toBe(
      "QUEUE",
    );
    // Doc precedence: INFO (notification) sits above SILENT, so a bulk alert files, never hides.
    expect(lane(facts({ addressedTo: "bulk", risk: ["security_alert"] })).lane).toBe("INFO");
  });

  it("a routine account change is not a PUSH risk", () => {
    expect(lane(facts({ risk: ["account_change"], kind: "notification" })).lane).toBe("INFO");
  });

  it("MEETING: a scheduling event not sent in bulk", () => {
    const event = { proposedTimes: [], hasInvite: false, conflict: null };
    expect(lane(facts({ event, kind: "meeting" }))).toEqual({ lane: "MEETING", rule: "meeting" });
    expect(lane(facts({ event, addressedTo: "bulk", kind: "promotion" })).lane).toBe("SILENT");
  });

  it("PUSH outranks MEETING when attending is due today", () => {
    const event = { proposedTimes: ["2026-06-01T15:00:00Z"], hasInvite: false, conflict: null };
    expect(lane(facts({ event, asks: [ask("2026-06-01T14:30:00Z", "attend")] })).lane).toBe("PUSH");
  });

  it("QUEUE: a personal or work conversation, or my turn to reply", () => {
    expect(lane(facts({ kind: "personal" }))).toEqual({
      lane: "QUEUE",
      rule: "queue:conversation",
    });
    expect(lane(facts({ kind: "work_thread" })).lane).toBe("QUEUE");
    expect(lane(facts({ threadTurn: "mine_to_reply" })).lane).toBe("QUEUE");
  });

  it("INFO: a transaction with no action, or a notification without asks", () => {
    const transaction = { kind: "receipt" as const, actionRequired: false };
    expect(lane(facts({ transaction, kind: "receipt" }))).toEqual({ lane: "INFO", rule: "info" });
    expect(lane(facts({ kind: "notification" })).lane).toBe("INFO");
  });

  it("a transaction that needs action falls to the QUEUE default", () => {
    const transaction = { kind: "invoice" as const, actionRequired: true };
    expect(lane(facts({ transaction, kind: "receipt" }))).toEqual({
      lane: "QUEUE",
      rule: "default",
    });
  });

  it("SILENT: bulk, newsletter or promotion with no asks", () => {
    expect(lane(facts({ addressedTo: "bulk", kind: "notification" })).lane).toBe("INFO");
    expect(lane(facts({ addressedTo: "bulk", kind: "newsletter" }))).toEqual({
      lane: "SILENT",
      rule: "silent",
    });
    expect(lane(facts({ kind: "promotion" })).lane).toBe("SILENT");
  });

  it("an ask keeps bulk mail visible", () => {
    expect(lane(facts({ addressedTo: "bulk", kind: "newsletter", asks: [ask(null)] })).lane).toBe(
      "QUEUE",
    );
  });

  it("spam never interrupts or schedules", () => {
    const event = { proposedTimes: [], hasInvite: true, conflict: null };
    expect(lane(facts({ risk: ["security_alert"] }), true).lane).toBe("INFO");
    expect(lane(facts({ asks: [ask("2026-06-01T15:00:00Z")] }), true).lane).toBe("QUEUE");
    expect(lane(facts({ event, kind: "meeting" }), true).lane).toBe("QUEUE");
  });
});
