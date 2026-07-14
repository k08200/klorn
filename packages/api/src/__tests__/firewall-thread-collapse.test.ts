import { describe, expect, it } from "vitest";
import { collapseEmailThreads } from "../firewall-thread-collapse.js";

type Row = { id: string; source: string; threadId?: string | null };
const threadOf = (r: Row) => r.threadId ?? null;

describe("collapseEmailThreads", () => {
  it("keeps only the first EMAIL row per threadId (highest-priority/newest wins)", () => {
    // Input is pre-ordered [priority desc, surfacedAt desc]; the first row of a
    // thread is the one to keep. A 3-message reschedule thread → one card.
    const rows: Row[] = [
      { id: "a1", source: "EMAIL", threadId: "t1" },
      { id: "a2", source: "EMAIL", threadId: "t1" },
      { id: "a3", source: "EMAIL", threadId: "t1" },
      { id: "b1", source: "EMAIL", threadId: "t2" },
    ];
    const out = collapseEmailThreads(rows, threadOf);
    expect(out.map((r) => r.id)).toEqual(["a1", "b1"]);
  });

  it("never merges rows with a null/absent threadId (legacy rows stay distinct)", () => {
    const rows: Row[] = [
      { id: "n1", source: "EMAIL", threadId: null },
      { id: "n2", source: "EMAIL", threadId: undefined },
      { id: "n3", source: "EMAIL" },
    ];
    const out = collapseEmailThreads(rows, threadOf);
    expect(out.map((r) => r.id)).toEqual(["n1", "n2", "n3"]);
  });

  it("never collapses non-EMAIL sources even if the key collides", () => {
    const rows: Row[] = [
      { id: "p1", source: "PENDING_ACTION", threadId: "t1" },
      { id: "p2", source: "PENDING_ACTION", threadId: "t1" },
      { id: "c1", source: "CALENDAR_EVENT", threadId: "t1" },
    ];
    const out = collapseEmailThreads(rows, threadOf);
    expect(out.map((r) => r.id)).toEqual(["p1", "p2", "c1"]);
  });

  it("preserves input order and dedups a thread interleaved with other items", () => {
    const rows: Row[] = [
      { id: "e1", source: "EMAIL", threadId: "t1" },
      { id: "pa", source: "PENDING_ACTION", threadId: null },
      { id: "e2", source: "EMAIL", threadId: "t1" },
      { id: "e3", source: "EMAIL", threadId: "t9" },
    ];
    const out = collapseEmailThreads(rows, threadOf);
    expect(out.map((r) => r.id)).toEqual(["e1", "pa", "e3"]);
  });
});
