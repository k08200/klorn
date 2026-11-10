/**
 * Mail the user cleared out of the Gmail INBOX outside Klorn, stamped on its
 * ledger row (DecisionLabel.providerArchivedAt).
 *
 * Source: the 30-minute INBOX reconcile (email-sync.ts reconcileInboxScope)
 * hands over the mirror rows that are no longer in the INBOX listing, before
 * it deletes them. Klorn's own archive and trash (gmail.ts archiveEmail /
 * trashEmail, the only Gmail INBOX removals in the codebase, also behind the
 * bulk and Subscriptions archives) delete the mirror row after the Gmail call,
 * so mail Klorn removed is normally not in that set. A reconcile that lands
 * between the two (milliseconds for one mail, up to the length of a bulk
 * archive's loop) can still see it; the report only counts a provider archive
 * when Klorn recorded none for that mail (lane-quality.ts), which covers the
 * archives Klorn stamps (not the Subscriptions sender-wide archive).
 *
 * Each candidate is read once from Gmail (format "minimal", labels only):
 *   - still or again in INBOX → not removed, skip;
 *   - SPAM → the user reported it as spam: not an archive, skip;
 *   - gone (404) → deleted for good, by whom is unknown: skip;
 *   - otherwise (archived, moved to a label, or in TRASH) → stamp. Trash
 *     counts as archived, as it does for Klorn's own stamps (DELETE
 *     /api/email/:id stamps ARCHIVED).
 * The stamp time is when the reconcile saw it (up to ~30 minutes late).
 *
 * Bounded per reconcile: the ledger lookup reads at most REMOVED_LOOKUP_CAP
 * removed rows (newest received first) and Gmail is asked about at most
 * PROVIDER_ARCHIVE_CHECK_CAP still-unstamped rows (newest judgement first). A
 * mass archive beyond that is left unstamped, an under-count, never a guess.
 *
 * Never throws: a ledger miss must not fail the reconcile.
 */

import type { gmail_v1 } from "googleapis";
import { prisma } from "../db.js";
import { stampProviderEngagement } from "../judge/decision-label.js";
import { Semaphore } from "../semaphore.js";
import { isGoogleNotFoundError } from "./gmail.js";
import { reportSentError } from "./sent-errors.js";

export const REMOVED_LOOKUP_CAP = 1000;
export const PROVIDER_ARCHIVE_CHECK_CAP = 100;
const CHECK_CONCURRENCY = 8;

export interface RemovedMail {
  /** EmailMessage.id — the ledger sourceId. */
  id: string;
  gmailId: string;
  receivedAt: Date;
}

export type InboxRemoval = "archived" | "spam" | "in-inbox";

/** What a message's current Gmail labels say about how it left the INBOX. Pure. */
export function classifyInboxRemoval(labelIds: readonly string[]): InboxRemoval {
  if (labelIds.includes("INBOX")) return "in-inbox";
  if (labelIds.includes("SPAM")) return "spam";
  return "archived";
}

type GmailMessages = Pick<gmail_v1.Gmail, "users">;
type CheckResult = { id: string } & (
  | { kind: "archived" | "skip" }
  | { kind: "failed"; error: unknown }
);

async function checkRemoval(
  gmail: GmailMessages,
  id: string,
  gmailId: string,
): Promise<CheckResult> {
  try {
    const res = await gmail.users.messages.get({ userId: "me", id: gmailId, format: "minimal" });
    const archived = classifyInboxRemoval(res.data.labelIds ?? []) === "archived";
    return { id, kind: archived ? "archived" : "skip" };
  } catch (err) {
    return isGoogleNotFoundError(err) ? { id, kind: "skip" } : { id, kind: "failed", error: err };
  }
}

/**
 * Stamp providerArchivedAt = `now` on the user's ledger rows for `removed`
 * mail that Gmail shows as archived or trashed. `gmail` is the client of the
 * account the rows belong to. Returns the rows stamped (0 on failure).
 */
export async function noteProviderArchives(
  userId: string,
  gmail: GmailMessages,
  removed: readonly RemovedMail[],
  now: Date = new Date(),
): Promise<number> {
  if (removed.length === 0) return 0;
  try {
    const recent = [...removed]
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
      .slice(0, REMOVED_LOOKUP_CAP);
    const gmailIdOf = new Map(recent.map((row) => [row.id, row.gmailId]));
    const pending = await prisma.decisionLabel.findMany({
      where: {
        userId,
        source: "EMAIL",
        sourceId: { in: recent.map((row) => row.id) },
        providerArchivedAt: null,
        // Klorn already recorded the archive: no Gmail call, nothing to add.
        archivedAt: null,
      },
      select: { sourceId: true },
      orderBy: { judgedAt: "desc" },
      take: PROVIDER_ARCHIVE_CHECK_CAP,
    });
    if (pending.length === 0) return 0;

    const sem = new Semaphore(CHECK_CONCURRENCY);
    const results = await sem.all<CheckResult>(
      pending.map(
        ({ sourceId }) =>
          () =>
            checkRemoval(gmail, sourceId, gmailIdOf.get(sourceId) ?? ""),
      ),
    );
    const failures = results.flatMap((r) => (r.kind === "failed" ? [r.error] : []));
    if (failures.length > 0) {
      // One report per reconcile, not one per message (a quota error hits
      // them all), carrying the first error's name and code.
      console.warn(`[provider-archives] ${failures.length} Gmail label read(s) failed`);
      reportSentError("provider-archives.check", failures[0], userId);
    }
    const archived = results.flatMap((r) => (r.kind === "archived" ? [r.id] : []));
    return await stampProviderEngagement(userId, "ARCHIVED", archived, now);
  } catch (err) {
    reportSentError("provider-archives.lookup", err, userId);
    return 0;
  }
}
