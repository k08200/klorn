/**
 * The processing pass (docs/providers/kakaotalk-import.md §4): one PENDING
 * import per scheduler tick. Each stored message goes through the commitment
 * ledger's ingestion (rule extractor first; the LLM refiner only for a rule
 * candidate), newest first, then the import's message text is deleted.
 *
 * Budget: the refiner charges the user's own daily cap (createCompletion with
 * the userId, never the judge's reserved slice), runs on the user's BYOK keys
 * when they have them, and at most KAKAO_MAX_CANDIDATES_PER_IMPORT candidates
 * of one import are looked at, so one upload cannot spend a day's budget.
 */

import { cohortRestriction, KAKAO_IMPORT_FLAGS } from "../config.js";
import { INTERACTIVE_TX_OPTIONS, prisma } from "../db.js";
import { getUserLlmCredentials } from "../llm/llm-credentials.js";
import type { CommitmentIngestionResult } from "../pim/commitment-ingestion.js";
import { isBackgroundAgentsDisabled } from "../scheduler-heartbeat.js";
import { captureError } from "../sentry.js";
import { getUserTimeZone } from "../user-timezone.js";
import { deleteKakaoImportCommitments, extractKakaoCommitments } from "./commitments.js";

/** Commitment candidates (each one LLM call at most) one import may look at. */
export const KAKAO_MAX_CANDIDATES_PER_IMPORT = 40;
const KAKAO_MAX_CANDIDATES_PER_MESSAGE = 2;
/** A PROCESSING claim older than this belonged to a pass that died; it is taken over. */
export const KAKAO_STALE_CLAIM_MS = 30 * 60_000;
/** One pass stops after this long and settles what it did (`partial`). */
export const KAKAO_PROCESS_TIME_BUDGET_MS = 10 * 60_000;
/** Consecutive failed messages after which a pass stops (the cause is not one message). */
const MAX_CONSECUTIVE_FAILURES = 5;
/** How often a pass checks its import still exists, besides after every candidate. */
const EXISTENCE_CHECK_EVERY = 25;
/**
 * Messages between yields to the event loop. A message with no candidate
 * resolves with no I/O (only microtasks), so without a yield a pass over 2,000
 * long messages would hold the loop for seconds.
 */
const YIELD_EVERY = 20;

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export const KAKAO_ERROR_PARTIAL = "partial";
export const KAKAO_ERROR_FAILED = "processing-failed";

interface Totals {
  readonly candidatesFound: number;
  readonly commitmentsCreated: number;
  readonly duplicatesSkipped: number;
  readonly failures: number;
  readonly consecutiveFailures: number;
  readonly stopped: "limit" | "deleted" | null;
}

const NO_TOTALS: Totals = {
  candidatesFound: 0,
  commitmentsCreated: 0,
  duplicatesSkipped: 0,
  failures: 0,
  consecutiveFailures: 0,
  stopped: null,
};

/** One claim of one import: the pass settles only the claim it holds. */
export interface KakaoClaim {
  readonly importId: string;
  readonly userId: string;
  readonly claimedAt: Date;
}

/** Names only: the messages are other people's, and Sentry keeps an error's message. */
function report(scope: string, err: unknown): void {
  const name = err instanceof Error ? err.name : typeof err;
  captureError(new Error(`kakao-import: ${name}`), {
    tags: { scope },
    extra: { errorName: name },
  });
}

function claimableWhere(now: Date) {
  return {
    OR: [
      { status: "PENDING" },
      { status: "PROCESSING", claimedAt: { lt: new Date(now.getTime() - KAKAO_STALE_CLAIM_MS) } },
    ],
  };
}

async function stillExists(importId: string): Promise<boolean> {
  const row = await prisma.kakaoImport.findUnique({
    where: { id: importId },
    select: { id: true },
  });
  return row !== null;
}

function added(totals: Totals, result: CommitmentIngestionResult): Totals {
  return {
    ...totals,
    candidatesFound: totals.candidatesFound + result.candidatesFound,
    commitmentsCreated: totals.commitmentsCreated + result.commitmentsCreated,
    duplicatesSkipped: totals.duplicatesSkipped + result.duplicatesSkipped,
    consecutiveFailures: 0,
  };
}

/** Candidates that cost an LLM call: a duplicate is matched before the refiner runs. */
function spentCandidates(totals: Totals): number {
  return totals.candidatesFound - totals.duplicatesSkipped;
}

function failed(totals: Totals): Totals {
  return {
    ...totals,
    failures: totals.failures + 1,
    consecutiveFailures: totals.consecutiveFailures + 1,
  };
}

function loadInputs(claim: KakaoClaim) {
  return Promise.all([
    // Newest first: if a limit stops the pass, it is the oldest messages that go unread.
    prisma.kakaoImportMessage.findMany({
      where: { importId: claim.importId, userId: claim.userId },
      orderBy: { seq: "desc" },
      select: { seq: true, sentAt: true, speaker: true, fromMe: true, text: true },
    }),
    getUserTimeZone(claim.userId),
    getUserLlmCredentials(claim.userId),
  ]);
}

async function extractAll(claim: KakaoClaim, clock: () => number): Promise<Totals> {
  const startedAt = clock();
  const [messages, timeZone, credentials] = await loadInputs(claim);
  let totals = NO_TOTALS;
  let checkNext = false;
  for (const [index, message] of messages.entries()) {
    const remaining = KAKAO_MAX_CANDIDATES_PER_IMPORT - spentCandidates(totals);
    const overTime = clock() - startedAt > KAKAO_PROCESS_TIME_BUDGET_MS;
    if (remaining <= 0 || overTime || totals.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      return { ...totals, stopped: "limit" };
    }
    if (index > 0 && index % YIELD_EVERY === 0) await yieldToEventLoop();
    if (
      (checkNext || (index > 0 && index % EXISTENCE_CHECK_EVERY === 0)) &&
      !(await stillExists(claim.importId))
    ) {
      return { ...totals, stopped: "deleted" };
    }
    try {
      const result = await extractKakaoCommitments({
        userId: claim.userId,
        importId: claim.importId,
        ...message,
        timeZone,
        credentials,
        maxCandidates: Math.min(KAKAO_MAX_CANDIDATES_PER_MESSAGE, remaining),
      });
      totals = added(totals, result);
      checkNext = result.candidatesFound > 0;
    } catch (err) {
      report("kakao-import.message", err);
      totals = failed(totals);
    }
  }
  return totals;
}

function settledData(totals: Totals | null) {
  if (totals === null) return { status: "FAILED", errorCode: KAKAO_ERROR_FAILED, claimedAt: null };
  const partial = totals.stopped !== null || totals.failures > 0;
  return {
    status: "DONE",
    candidatesFound: totals.candidatesFound,
    commitmentsCreated: totals.commitmentsCreated,
    duplicatesSkipped: totals.duplicatesSkipped,
    errorCode: partial ? KAKAO_ERROR_PARTIAL : null,
    processedAt: new Date(),
    claimedAt: null,
  };
}

/**
 * Settle the claim this pass holds: counts and outcome on the row, the message
 * text deleted with it. A claim another pass took over (or the purge expired)
 * is left to them. If the row is gone, the user deleted the import: whatever
 * this pass made is deleted too.
 */
async function settle(claim: KakaoClaim, totals: Totals | null): Promise<void> {
  const settled = await prisma.$transaction(async (tx) => {
    const { count } = await tx.kakaoImport.updateMany({
      where: {
        id: claim.importId,
        userId: claim.userId,
        status: "PROCESSING",
        claimedAt: claim.claimedAt,
      },
      data: settledData(totals),
    });
    if (count > 0) {
      await tx.kakaoImportMessage.deleteMany({
        where: { importId: claim.importId, userId: claim.userId },
      });
    }
    return count > 0;
  }, INTERACTIVE_TX_OPTIONS);
  const deleted =
    totals?.stopped === "deleted" || (!settled && !(await stillExists(claim.importId)));
  if (deleted) await deleteKakaoImportCommitments(claim.userId, claim.importId);
}

/** Process one claimed import. Never throws: a failure is recorded on the row. */
export async function processKakaoImport(
  claim: KakaoClaim,
  clock: () => number = Date.now,
): Promise<void> {
  let totals: Totals | null = null;
  try {
    totals = await extractAll(claim, clock);
  } catch (err) {
    report("kakao-import.process", err);
  }
  try {
    await settle(claim, totals);
  } catch (err) {
    report("kakao-import.settle", err);
  }
}

/**
 * Claim and process the oldest waiting import of a user the flag reaches.
 * True when an import was processed. Stands down under
 * BACKGROUND_AGENTS_DISABLED; the purge does not (purge.ts).
 */
export async function processNextKakaoImport(now: Date = new Date()): Promise<boolean> {
  if (isBackgroundAgentsDisabled()) return false;
  const reach = cohortRestriction(KAKAO_IMPORT_FLAGS);
  if (reach.kind === "none") return false;
  if (reach.kind === "only" && reach.userIds.length === 0) return false;
  const userFilter = reach.kind === "only" ? { userId: { in: reach.userIds } } : {};
  const next = await prisma.kakaoImport.findFirst({
    where: { ...claimableWhere(now), ...userFilter },
    orderBy: { createdAt: "asc" },
    select: { id: true, userId: true },
  });
  if (next === null) return false;
  const claimed = await prisma.kakaoImport.updateMany({
    where: { id: next.id, ...claimableWhere(now) },
    data: { status: "PROCESSING", claimedAt: now },
  });
  if (claimed.count === 0) return false;
  await processKakaoImport({ importId: next.id, userId: next.userId, claimedAt: now });
  return true;
}
