/**
 * The web Commitment Ledger (Approvals page): which rows are commitments and
 * which are suggestions to confirm, how they group by owner and by due, and
 * what collapses as noise. Pure rules in
 * packages/web/src/app/assistant/approvals/commitments-model.ts; run from the
 * api suite because the web package has no unit-test runner.
 */
import { describe, expect, it } from "vitest";
import {
  buildCommitmentLedger,
  dueBucketOf,
  evidenceQuote,
  isOlderSuggestion,
  sourceMailHref,
} from "../../../web/src/app/assistant/approvals/commitments-model";
import type { CommitmentItem } from "../../../web/src/components/commitment-card";

const NOW = new Date("2026-11-12T03:00:00Z"); // 12:00 in Seoul
const SEOUL = "Asia/Seoul";
const DAY = 24 * 60 * 60 * 1000;

function row(over: Partial<CommitmentItem> = {}): CommitmentItem {
  return {
    id: "c-1",
    title: "I'll send the deck",
    description: "Q4 plan",
    status: "OPEN",
    kind: "DELIVERABLE",
    owner: "USER",
    dueAt: null,
    dueText: null,
    sourceType: "EMAIL",
    sourceId: "e-1",
    evidenceText: "I'll send the deck",
    confidence: 0.45,
    confirmed: false,
    confirmedAt: null,
    completionSuggestedAt: null,
    createdAt: new Date(NOW.getTime() - DAY).toISOString(),
    ...over,
  };
}

describe("dueBucketOf", () => {
  const due = (ms: number) => row({ dueAt: new Date(NOW.getTime() + ms).toISOString() });

  it("buckets by the user's calendar day, not the browser's", () => {
    // 23:30 Seoul today is still "today" though it is tomorrow-ish in UTC terms.
    expect(dueBucketOf(row({ dueAt: "2026-11-12T14:30:00Z" }), NOW, SEOUL)).toBe("today");
    // 00:30 Seoul tomorrow is not today.
    expect(dueBucketOf(row({ dueAt: "2026-11-12T15:30:00Z" }), NOW, SEOUL)).toBe("nextWeek");
  });

  it("splits overdue, the next 7 days, later and no date", () => {
    expect(dueBucketOf(due(-2 * DAY), NOW, SEOUL)).toBe("overdue");
    expect(dueBucketOf(due(3 * DAY), NOW, SEOUL)).toBe("nextWeek");
    expect(dueBucketOf(due(10 * DAY), NOW, SEOUL)).toBe("later");
    expect(dueBucketOf(row(), NOW, SEOUL)).toBe("noDate");
    expect(dueBucketOf(row({ dueAt: "not a date" }), NOW, SEOUL)).toBe("noDate");
  });

  it("puts a likely-done row first, whatever its due date", () => {
    const likely = row({ dueAt: "2026-11-01T00:00:00Z", completionSuggestedAt: NOW.toISOString() });
    expect(dueBucketOf(likely, NOW, SEOUL)).toBe("likelyDone");
  });
});

describe("isOlderSuggestion", () => {
  it("collapses suggestions overdue for more than 30 days", () => {
    const overdue = (days: number) =>
      row({ dueAt: new Date(NOW.getTime() - days * DAY).toISOString() });
    expect(isOlderSuggestion(overdue(31), NOW)).toBe(true);
    expect(isOlderSuggestion(overdue(29), NOW)).toBe(false);
  });

  it("collapses undated suggestions found more than 30 days ago", () => {
    const found = (days: number) =>
      row({ createdAt: new Date(NOW.getTime() - days * DAY).toISOString() });
    expect(isOlderSuggestion(found(45), NOW)).toBe(true);
    expect(isOlderSuggestion(found(5), NOW)).toBe(false);
  });

  it("never collapses a confirmed commitment or a likely-done one", () => {
    const old = new Date(NOW.getTime() - 90 * DAY).toISOString();
    expect(isOlderSuggestion(row({ createdAt: old, confirmed: true }), NOW)).toBe(false);
    expect(
      isOlderSuggestion(row({ createdAt: old, completionSuggestedAt: NOW.toISOString() }), NOW),
    ).toBe(false);
  });
});

describe("buildCommitmentLedger", () => {
  it("separates confirmed commitments from suggestions to confirm", () => {
    const ledger = buildCommitmentLedger(
      [row({ id: "s" }), row({ id: "c", confirmed: true, confidence: 0.9 })],
      NOW,
      SEOUL,
    );
    expect(ledger.confirmed.owners.flatMap((o) => o.rows.map((r) => r.id))).toEqual(["c"]);
    expect(ledger.suggested.owners.flatMap((o) => o.rows.map((r) => r.id))).toEqual(["s"]);
  });

  it("groups by owner (I owe first, they owe second) then by due bucket", () => {
    const ledger = buildCommitmentLedger(
      [
        row({ id: "theirs-nodate", owner: "COUNTERPARTY" }),
        row({ id: "mine-nodate" }),
        row({ id: "mine-overdue", dueAt: new Date(NOW.getTime() - DAY).toISOString() }),
        row({ id: "mine-likely", completionSuggestedAt: NOW.toISOString() }),
      ],
      NOW,
      SEOUL,
    );
    const [mine, theirs] = ledger.suggested.owners;
    expect(mine?.owner).toBe("mine");
    expect(mine?.rows.map((r) => [r.id, r.bucket])).toEqual([
      ["mine-likely", "likelyDone"],
      ["mine-overdue", "overdue"],
      ["mine-nodate", "noDate"],
    ]);
    expect(theirs?.owner).toBe("theirs");
    expect(theirs?.rows.map((r) => r.id)).toEqual(["theirs-nodate"]);
  });

  it("moves old suggestions into one 'older' group shared by both owners", () => {
    const old = new Date(NOW.getTime() - 60 * DAY).toISOString();
    const ledger = buildCommitmentLedger(
      [
        row({ id: "fresh" }),
        row({ id: "old-mine", createdAt: old }),
        row({ id: "old-theirs", owner: "COUNTERPARTY", createdAt: old }),
        row({ id: "old-confirmed", confirmed: true, createdAt: old }),
      ],
      NOW,
      SEOUL,
    );
    expect(ledger.suggested.older.map((r) => r.id)).toEqual(["old-mine", "old-theirs"]);
    expect(ledger.suggested.owners.flatMap((o) => o.rows.map((r) => r.id))).toEqual(["fresh"]);
    expect(ledger.confirmed.owners.flatMap((o) => o.rows.map((r) => r.id))).toEqual([
      "old-confirmed",
    ]);
  });

  it("omits empty owner groups", () => {
    const ledger = buildCommitmentLedger([row({ owner: "COUNTERPARTY" })], NOW, SEOUL);
    expect(ledger.suggested.owners.map((o) => o.owner)).toEqual(["theirs"]);
    expect(ledger.confirmed.owners).toEqual([]);
  });
});

describe("evidenceQuote / sourceMailHref", () => {
  it("quotes the mail only when it adds something to the title", () => {
    expect(evidenceQuote(row())).toBeNull();
    expect(evidenceQuote(row({ evidenceText: "  " }))).toBeNull();
    expect(
      evidenceQuote(row({ title: "Send the deck", evidenceText: "I'll send the deck by Fri" })),
    ).toBe("I'll send the deck by Fri");
  });

  it("links to the source mail by its id, encoded, and only for mail", () => {
    expect(sourceMailHref(row({ sourceId: "e-1" }))).toBe("/email/e-1");
    expect(sourceMailHref(row({ sourceId: "../../x?y" }))).toBe("/email/..%2F..%2Fx%3Fy");
    expect(sourceMailHref(row({ sourceType: "CHAT" }))).toBeNull();
    expect(sourceMailHref(row({ sourceId: null }))).toBeNull();
  });
});
