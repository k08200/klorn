/**
 * Auto-MODE reply sweep (ontology v2, guideline-driven unattended replies).
 *
 * Extracted from automation-scheduler's runUserCycle so the ORDERING
 * contracts the security review pinned (2026-08-16) are testable:
 *   1. dedupe lookup runs BEFORE any LLM spend,
 *   2. the recipient is validated BEFORE the LLM and the ledger,
 *   3. the ledger is written BEFORE the send (unique dedupeKey =
 *      at-most-once lock; a P2002 loser must never send),
 *   4. a send failure REWRITES the ledger to a failure record (never a
 *      false "Klorn replied for you") and leaves the item OPEN,
 *   5. empty drafts retry at most AUTO_MODE_MAX_DRAFT_ATTEMPTS times.
 *
 * Every side effect goes through `deps` so the tests inject fakes and assert
 * call order; automation-scheduler wires the real implementations. The
 * flag/mode/entitlement gate stays at the call site — this module assumes the
 * caller already decided the sweep should run.
 */

/// Sweep bounds: only items judged within the lookback are candidates (older
/// mail deserves a human, not a late robot reply), and each tick answers at
/// most a handful so a burst can't drain the LLM budget.
export const AUTO_MODE_LOOKBACK_MS = 6 * 60 * 60 * 1000;
export const AUTO_MODE_MAX_PER_TICK = 5;
/// A candidate whose draft keeps coming back empty is retried at most this
/// many times. In-memory by design — a restart resetting the count is harmless.
export const AUTO_MODE_MAX_DRAFT_ATTEMPTS = 3;

const autoModeDraftAttempts = new Map<string, number>();

/** Test hook: reset the in-memory attempt counter between cases. */
export function resetAutoModeDraftAttempts(): void {
  autoModeDraftAttempts.clear();
}

export interface AutoModeCandidate {
  id: string;
  sourceId: string;
}

export interface AutoModeEmail {
  id: string;
  gmailId: string;
  from: string;
  subject: string;
  body: string | null;
}

export interface AutoModeSweepDeps {
  findCandidates: (userId: string, since: Date, take: number) => Promise<AutoModeCandidate[]>;
  findEmail: (userId: string, emailRowId: string) => Promise<AutoModeEmail | null>;
  /** True when an auto-reply or auto-mode ledger already claims this gmailId. */
  alreadyReplied: (userId: string, gmailId: string) => Promise<boolean>;
  isSingleRecipient: (to: string) => boolean;
  draftReply: (
    email: { from: string; subject: string; body: string },
    userId: string,
    guideline: string,
  ) => Promise<string | null>;
  /** Post-LLM race guard: does the email row still exist? */
  emailStillExists: (emailRowId: string) => Promise<boolean>;
  /** Winner-only ledger create; null = a concurrent tick already claimed it. */
  writeLedger: (userId: string, gmailId: string, toAddr: string) => Promise<{ id: string } | null>;
  send: (
    userId: string,
    toAddr: string,
    subject: string,
    body: string,
    inReplyToEmailId: string,
  ) => Promise<void>;
  /**
   * Send failed after the ledger committed — rewrite it as a failure record.
   * `sendErr` lets the record say whether delivery is unknown or certainly not
   * happened.
   */
  markLedgerFailed: (
    ledgerId: string,
    toAddr: string,
    gmailId: string,
    sendErr: unknown,
  ) => Promise<void>;
  resolveItem: (itemId: string) => Promise<void>;
  warn: (message: string) => void;
  reportError: (err: unknown, itemId: string) => void;
  now: () => number;
}

/** Extract the reply-to address from a From header. Pure for the tests. */
export function recipientFromHeader(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from).trim();
}

export async function runAutoModeSweep(
  userId: string,
  guideline: string,
  deps: AutoModeSweepDeps,
): Promise<void> {
  const since = new Date(deps.now() - AUTO_MODE_LOOKBACK_MS);
  const candidates = await deps.findCandidates(userId, since, AUTO_MODE_MAX_PER_TICK);
  for (const item of candidates) {
    try {
      const email = await deps.findEmail(userId, item.sourceId);
      if (!email) continue;
      // Never double-answer one mail: an EmailRule reply or an earlier mode
      // reply already claimed it. MUST precede any LLM spend.
      if (await deps.alreadyReplied(userId, email.gmailId)) continue;
      // Refuse a malformed/crafted From BEFORE any LLM spend or ledger
      // write — the floor's single-recipient guard would only reject it
      // after the ledger already claimed "replied".
      const toAddr = recipientFromHeader(email.from);
      if (!deps.isSingleRecipient(toAddr)) {
        deps.warn(`[AUTOMATION] auto-mode skip: non-single recipient from ${item.id}`);
        continue;
      }
      const attempts = autoModeDraftAttempts.get(item.id) ?? 0;
      if (attempts >= AUTO_MODE_MAX_DRAFT_ATTEMPTS) continue;
      const draft = await deps.draftReply(
        { from: email.from, subject: email.subject, body: email.body || "" },
        userId,
        guideline,
      );
      if (!draft) {
        autoModeDraftAttempts.set(item.id, attempts + 1);
        continue;
      }
      autoModeDraftAttempts.delete(item.id);
      // Race guard mirroring the rule sweep: the LLM took seconds — skip if
      // the source row vanished (delete/reconcile).
      if (!(await deps.emailStillExists(email.id))) continue;
      // Ledger BEFORE send — deliberately. The unique dedupeKey is the
      // cross-tick concurrency lock: an unattended DOUBLE-send is worse
      // than a missed one.
      const ledger = await deps.writeLedger(userId, email.gmailId, toAddr);
      if (!ledger) continue;
      try {
        await deps.send(userId, toAddr, `Re: ${email.subject}`, draft, email.id);
      } catch (sendErr) {
        // The ledger must not lie: rewrite it as a failure record so the
        // user is never told a reply went out when it didn't. No retry
        // (at-most-once holds); the item stays OPEN for the human lane.
        await deps.markLedgerFailed(ledger.id, toAddr, email.gmailId, sendErr);
        throw sendErr;
      }
      // Klorn handled it — resolve the item so the queue stays clean.
      await deps.resolveItem(item.id);
    } catch (err) {
      deps.warn(`[AUTOMATION] auto-mode reply failed for item ${item.id} (user ${userId})`);
      deps.reportError(err, item.id);
    }
  }
}
