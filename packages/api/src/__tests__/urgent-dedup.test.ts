import { describe, expect, it } from "vitest";
import {
  buildUrgentDedupMessage,
  latestNotifiedAt,
  parseNotifiedGmailIds,
  unnotifiedEmails,
  urgentDedupeKey,
} from "../notify/urgent-dedup.js";

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

/**
 * Step B2b: an IMAP id names a message only under one UIDVALIDITY. After a repair
 * re-keys the old row, a NEW message can arrive under the very same id, and the old
 * row's marker must not silence it. For IMAP ids a marker counts only when it was
 * written at or after the row was created; Gmail ids behave exactly as before.
 */
describe("urgent-email dedup for IMAP ids (B2b)", () => {
  const T1 = new Date("2026-09-30T10:00:00Z");
  const T2 = new Date("2026-09-30T11:00:00Z");
  const IMAP_ID = "naver-imap:me@naver.com:101";
  const ICLOUD_ID = "icloud-imap:me@icloud.com:7";
  const marker = (ids: string[], createdAt: Date) => ({
    message: buildUrgentDedupMessage("body", ids),
    createdAt,
  });

  it("keeps the latest notification time per id", () => {
    const at = latestNotifiedAt([marker(["a", "b"], T1), marker(["b"], T2), marker(["a"], T1)]);
    expect(at).toEqual(
      new Map([
        ["a", T1],
        ["b", T2],
      ]),
    );
  });

  it("Gmail ids: any marker in the window counts, even one older than the row (unchanged)", () => {
    const emails = [{ gmailId: "18ab", createdAt: T2 }];
    expect(unnotifiedEmails(emails, latestNotifiedAt([marker(["18ab"], T1)]))).toEqual([]);
  });

  it("IMAP ids: a marker written before the row existed does not count", () => {
    const emails = [
      { gmailId: IMAP_ID, createdAt: T2 },
      { gmailId: ICLOUD_ID, createdAt: T2 },
    ];
    const notified = latestNotifiedAt([marker([IMAP_ID, ICLOUD_ID], T1)]);
    expect(unnotifiedEmails(emails, notified)).toEqual(emails);
  });

  it("IMAP ids: a marker written at or after the row's creation counts", () => {
    const emails = [
      { gmailId: IMAP_ID, createdAt: T1 },
      { gmailId: ICLOUD_ID, createdAt: T1 },
    ];
    expect(unnotifiedEmails(emails, latestNotifiedAt([marker([IMAP_ID], T1)]))).toEqual([
      emails[1],
    ]);
    expect(unnotifiedEmails(emails, latestNotifiedAt([marker([IMAP_ID, ICLOUD_ID], T2)]))).toEqual(
      [],
    );
  });

  it("an id without any marker is unnotified, for both kinds", () => {
    const emails = [
      { gmailId: "18ab", createdAt: T1 },
      { gmailId: IMAP_ID, createdAt: T1 },
    ];
    expect(unnotifiedEmails(emails, new Map())).toEqual(emails);
  });

  it("keys the at-most-once claim by row for IMAP ids, and exactly as before for Gmail", () => {
    expect(urgentDedupeKey({ id: "row-1", gmailId: "18ab" })).toBe("urgent:18ab");
    expect(urgentDedupeKey({ id: "row-1", gmailId: IMAP_ID })).toBe(`urgent:${IMAP_ID}@row-1`);
    expect(urgentDedupeKey({ id: "row-2", gmailId: IMAP_ID })).not.toBe(
      urgentDedupeKey({ id: "row-1", gmailId: IMAP_ID }),
    );
  });
});
