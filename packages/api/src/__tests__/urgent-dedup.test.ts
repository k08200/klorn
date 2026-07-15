import { describe, expect, it } from "vitest";
import { buildUrgentDedupMessage, parseNotifiedGmailIds } from "../notify/urgent-dedup.js";

describe("urgent-email dedup marker", () => {
  it("round-trips every gmailId in a multi-email notification", () => {
    const ids = ["18ab", "18cd", "18ef"];
    const message = buildUrgentDedupMessage("3 urgent emails. Latest: Acme", ids);
    expect(parseNotifiedGmailIds([message])).toEqual(new Set(ids));
  });

  it("records ALL ids so non-lead emails are not re-notified next tick", () => {
    // The bug: only the first id was stored, so emails 2..N re-fired every tick.
    const message = buildUrgentDedupMessage("2 urgent emails", ["lead", "second"]);
    const notified = parseNotifiedGmailIds([message]);
    expect(notified.has("lead")).toBe(true);
    expect(notified.has("second")).toBe(true);
  });

  it("reads back the legacy single-id format", () => {
    expect(parseNotifiedGmailIds(["Urgent email from Acme [18ab]"])).toEqual(new Set(["18ab"]));
  });

  it("only parses the trailing marker, ignoring brackets in the body", () => {
    const message = buildUrgentDedupMessage("[Newsletter] From Acme", ["realid"]);
    expect(parseNotifiedGmailIds([message])).toEqual(new Set(["realid"]));
  });

  it("merges ids across multiple prior notifications", () => {
    const a = buildUrgentDedupMessage("body a", ["a1", "a2"]);
    const b = buildUrgentDedupMessage("body b", ["b1"]);
    expect(parseNotifiedGmailIds([a, b])).toEqual(new Set(["a1", "a2", "b1"]));
  });

  it("returns an empty set for messages with no marker", () => {
    expect(parseNotifiedGmailIds(["no brackets here", ""])).toEqual(new Set());
  });

  it("exposes each id as a bare substring of a multi-id marker (firewall dedup relies on this)", () => {
    // The firewall dedups with a bare `contains: gmailId` (not `[gmailId]`),
    // because the sweep writes a batch as one `[id1,id2,…]` marker. A bracketed
    // `[id2]` search would miss the middle of a batch and fire a second push.
    const marker = buildUrgentDedupMessage("3 urgent emails", ["aaa", "bbb", "ccc"]);
    for (const id of ["aaa", "bbb", "ccc"]) {
      expect(marker.includes(id)).toBe(true); // bare match finds every id
    }
    expect(marker.includes("[bbb]")).toBe(false); // bracketed match would NOT
  });
});
