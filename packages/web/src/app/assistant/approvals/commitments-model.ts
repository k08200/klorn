/**
 * The Commitment Ledger on Approvals: pure rules, no React.
 *
 * Two lists. "Confirmed" holds the rows the server calls confirmed (confidence
 * >= 0.7 or the user's Confirm); "To confirm" holds everything else — the
 * rule-mined suggestions, which until now the page hid entirely. Each list
 * groups by owner (I owe first, they owe second), then by due bucket, with a
 * row a later reply marked likely done at the top of its owner group.
 *
 * Noise control: a suggestion that has sat for more than 30 days (overdue by
 * that much, or found that long ago with no date) leaves its group for one
 * shared "older" group the page keeps collapsed. A confirmed commitment never
 * collapses — the user vouched for it.
 */

import { dayKeyForInZone } from "../../../components/calendar/month-utils";
import type { CommitmentItem } from "../../../components/commitment-card";

export type CommitmentBucket = "likelyDone" | "overdue" | "today" | "nextWeek" | "later" | "noDate";
export type CommitmentOwnerGroup = "mine" | "theirs";

export const OLDER_AFTER_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const NEXT_WEEK_MS = 7 * DAY_MS;

/** Display order inside an owner group. */
export const BUCKET_ORDER: readonly CommitmentBucket[] = [
  "likelyDone",
  "overdue",
  "today",
  "nextWeek",
  "later",
  "noDate",
];

export type LedgerRow = CommitmentItem & { bucket: CommitmentBucket };

export interface OwnerGroup {
  owner: CommitmentOwnerGroup;
  rows: LedgerRow[];
}

export interface CommitmentLedger {
  confirmed: { owners: OwnerGroup[] };
  suggested: { owners: OwnerGroup[]; older: CommitmentItem[] };
}

function timeOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Only the counterparty's promises are "theirs"; every other owner is the user's to act on. */
export function ownerGroupOf(row: CommitmentItem): CommitmentOwnerGroup {
  return row.owner === "COUNTERPARTY" ? "theirs" : "mine";
}

/** Which due group a row reads under, by the user's calendar day. */
export function dueBucketOf(row: CommitmentItem, now: Date, timeZone: string): CommitmentBucket {
  if (row.completionSuggestedAt) return "likelyDone";
  const due = timeOf(row.dueAt);
  if (due === null) return "noDate";
  if (dayKeyForInZone(new Date(due), timeZone) === dayKeyForInZone(now, timeZone)) return "today";
  if (due < now.getTime()) return "overdue";
  return due - now.getTime() <= NEXT_WEEK_MS ? "nextWeek" : "later";
}

/** A suggestion left untouched long enough to stop competing for attention. */
export function isOlderSuggestion(row: CommitmentItem, now: Date): boolean {
  if (row.confirmed || row.completionSuggestedAt) return false;
  const since = timeOf(row.dueAt) ?? timeOf(row.createdAt);
  return since !== null && now.getTime() - since > OLDER_AFTER_DAYS * DAY_MS;
}

function groupByOwner(rows: readonly CommitmentItem[], now: Date, timeZone: string): OwnerGroup[] {
  const owners: CommitmentOwnerGroup[] = ["mine", "theirs"];
  return owners.flatMap((owner) => {
    const mine = rows
      .filter((row) => ownerGroupOf(row) === owner)
      .map((row) => ({ ...row, bucket: dueBucketOf(row, now, timeZone) }));
    // Stable: rows keep the server's order (due soonest, then newest) per bucket.
    const sorted = BUCKET_ORDER.flatMap((bucket) => mine.filter((row) => row.bucket === bucket));
    return sorted.length > 0 ? [{ owner, rows: sorted }] : [];
  });
}

export function buildCommitmentLedger(
  rows: readonly CommitmentItem[],
  now: Date,
  timeZone: string,
): CommitmentLedger {
  const confirmed = rows.filter((row) => row.confirmed === true);
  const suggested = rows.filter((row) => row.confirmed !== true);
  const older = suggested.filter((row) => isOlderSuggestion(row, now));
  const current = suggested.filter((row) => !isOlderSuggestion(row, now));
  return {
    confirmed: { owners: groupByOwner(confirmed, now, timeZone) },
    suggested: { owners: groupByOwner(current, now, timeZone), older },
  };
}

/** The mail text behind the row, when it says more than the title does. */
export function evidenceQuote(row: CommitmentItem): string | null {
  const text = row.evidenceText?.trim();
  if (!text || text === row.title.trim()) return null;
  return text;
}

/** The in-app mail the promise was found in (EMAIL rows only). */
export function sourceMailHref(row: CommitmentItem): string | null {
  if (row.sourceType !== "EMAIL" || !row.sourceId) return null;
  return `/email/${encodeURIComponent(row.sourceId)}`;
}
