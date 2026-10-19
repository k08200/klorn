/**
 * The data-wipe fence: nothing written for an account by work that began
 * before its data was wiped survives the wipe.
 *
 * A wipe (`purgeAllUserData`, DELETE /api/user/me/data) races everything
 * already running for the user:
 *   - a sync holding the token in memory (Gmail calls have no timeout);
 *   - a judge call in the background LLM queue (no cap, no wait limit) that
 *     will upsert an AttentionItem for an email that is gone;
 *   - a timer from the last sign-in.
 * Rows those write after the purge's deletes would outlive the wipe. Two
 * layers close that:
 *
 *   1. In the database, a BEFORE INSERT trigger on every table in
 *      FENCED_MODELS (migration 20261019010000_data_wipe_fence) rejects an
 *      insert while the account's wipe is pending (`purgedAt` null) or until
 *      `fenceUntil`. It first takes FOR KEY SHARE on the account row. The wipe
 *      takes FOR UPDATE on that row before it records the wipe, so the two
 *      serialize: an insert that got there first commits before the wipe
 *      starts and is purged with the rest, and one that comes later waits and
 *      then sees the record.
 *   2. In the app, after `fenceUntil`, a Prisma query hook (db.ts) rejects a
 *      write from any work that began before `fenceUntil` (work-context.ts),
 *      however late it arrives. The window in (1) only needs to cover the gap
 *      between this check and its insert, plus another instance's cached
 *      state (FENCE_CACHE_MS).
 *
 * New work that begins after `fenceUntil` writes normally. Account deletion
 * needs none of this: deleting the account row is atomic against inserts that
 * reference it.
 */

import { workStartedAt } from "../work-context.js";

/** Fence window after the purge commits; far above FENCE_CACHE_MS plus a pool wait. */
export const DATA_WIPE_FENCE_MS = 5 * 60_000;

/** In the trigger's exception text, so a rejected insert is recognizable. */
export const DATA_WIPE_FENCE_MARKER = "klorn_data_wipe_fence";

const FENCE_CACHE_MS = 30_000;
const FENCE_CACHE_MAX_ENTRIES = 10_000;

/** Tables whose inserts the fence rejects: the account's data, and its grants. */
export const FENCED_MODELS = [
  // Grants: a re-link during the fence would start a sync whose writes fail.
  "UserToken",
  "LinkedInboxAccount",
  "LinkedCalendarAccount",
  "LinkedDriveAccount",
  // Mail and what is derived from it.
  "EmailMessage",
  "EmailAttachment",
  "EmailProcessingLog",
  "EmailLabelFeedback",
  "CandidateIntake",
  "ImapMovedMessage",
  "SentMessage",
  "SendReceipt",
  "AttentionItem",
  "DecisionLabel",
  "LearnedRule",
  "SenderTrait",
  "SenderLabel",
  "ScreenerDecision",
  "ContactDossier",
  "ThreadBrief",
  "Commitment",
  "FeedbackEvent",
  "FeedbackPolicyPreference",
  "CalibrationSnapshot",
  "WorkContextSnapshot",
  // Calendar and files.
  "CalendarEvent",
  "DriveFile",
  "DriveFileSummary",
  "DriveSummaryUsage",
  // The assistant's and the user's own records.
  "Conversation",
  "Task",
  "Note",
  "Reminder",
  "Contact",
  "ContactTrustScore",
  "ContactEngagementScore",
  "Team",
  "Memory",
  "Skill",
  "ActivatedPlaybook",
  "EmailRule",
  "PendingAction",
  "ActionOutbox",
  "AgentLog",
  "McpWriteAudit",
  // What the user was told.
  "Notification",
  "PushDeliveryLog",
  "PushRingEvent",
  "PhoneEscalation",
] as const;

/**
 * User-scoped tables the fence leaves alone, each for a reason. Sign-in writes
 * the first group, so fencing them would lock the user out right after a wipe.
 */
export const UNFENCED_MODELS: Record<string, string> = {
  Device: "the sign-in session",
  UserIdentity: "sign-in methods, kept by the wipe",
  AutomationConfig: "account settings; sign-in upserts them, with defaults and no mail data",
  DevicePushToken: "device registration at sign-in, no mail data",
  PushSubscription: "browser push registration, no mail data",
  ApiKey: "revoked by the wipe; a key created afterwards is an account action",
  TokenUsage: "cost accounting, which the daily cap must keep counting",
  LlmCostLedger: "the daily spend cap itself",
  LlmUsageLog: "cost accounting, which the daily cap must keep counting",
  AnalyticsEvent: "product analytics written inline by requests, no mail content",
  PmfResponse: "a survey answer the user typed, not derived from mail",
  StoragePurge: "the stored-object purge queue, written by the wipe itself",
  DataWipe: "the fence's own record",
};

export class DataWipeFenceError extends Error {
  readonly statusCode = 409;
  readonly code = "DATA_WIPE_IN_PROGRESS";

  constructor() {
    super("This account's data was wiped after this work began, so nothing was written.");
    this.name = "DataWipeFenceError";
  }
}

/** The trigger's SQLSTATE (migration 20261019010000_data_wipe_fence). */
export const DATA_WIPE_FENCE_SQLSTATE = "KW001";

const PRISMA_REQUEST_ERRORS = new Set([
  "PrismaClientKnownRequestError",
  "PrismaClientUnknownRequestError",
]);

/**
 * True for the app check's error and for the trigger's. Prisma reports the
 * trigger as a known request error with `meta.code` KW001 for raw SQL, and as
 * an unknown request error whose message carries the code for a model query.
 * Only those classes count: a validation error echoes the caller's input, which
 * could contain the marker.
 */
export function isDataWipeFenceError(err: unknown): boolean {
  if (err instanceof DataWipeFenceError) return true;
  if (!(err instanceof Error) || !PRISMA_REQUEST_ERRORS.has(err.constructor.name)) return false;
  const meta = (err as { meta?: { code?: unknown } }).meta;
  if (meta?.code === DATA_WIPE_FENCE_SQLSTATE) return true;
  return (
    err.message.includes(DATA_WIPE_FENCE_MARKER) && err.message.includes(DATA_WIPE_FENCE_SQLSTATE)
  );
}

export interface DataWipeState {
  purgedAt: Date | null;
  fenceUntil: Date | null;
}

type FenceReader = (userId: string) => Promise<DataWipeState | null>;

let readFenceRow: FenceReader | null = null;
const cache = new Map<string, { state: DataWipeState | null; fetchedAt: number }>();

/** db.ts wires the reader to the unextended client, so the check never recurses. */
export function setDataWipeReader(reader: FenceReader | null): void {
  readFenceRow = reader;
  cache.clear();
}

/** The wipe records its own state here at once, ahead of the cache's expiry. */
export function rememberDataWipe(userId: string, state: DataWipeState): void {
  if (cache.size >= FENCE_CACHE_MAX_ENTRIES) cache.clear();
  cache.set(userId, { state, fetchedAt: Date.now() });
}

async function fenceOf(userId: string): Promise<DataWipeState | null> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.fetchedAt < FENCE_CACHE_MS) return hit.state;
  if (!readFenceRow) return null;
  const state = await readFenceRow(userId);
  if (cache.size >= FENCE_CACHE_MAX_ENTRIES) cache.clear();
  cache.set(userId, { state, fetchedAt: Date.now() });
  return state;
}

/** Throws DataWipeFenceError when the current work may not write for `userId`. */
export async function assertWorkMayWrite(userId: string): Promise<void> {
  const state = await fenceOf(userId);
  if (!state) return;
  if (state.purgedAt === null) throw new DataWipeFenceError();
  if (state.fenceUntil && workStartedAt() < state.fenceUntil) throw new DataWipeFenceError();
}

const FENCED_OPERATIONS = new Set(["create", "createMany", "createManyAndReturn", "upsert"]);
const FENCED = new Set<string>(FENCED_MODELS);

function ownerOf(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const record = data as { userId?: unknown; user?: { connect?: { id?: unknown } } };
  if (typeof record.userId === "string") return record.userId;
  const connected = record.user?.connect?.id;
  return typeof connected === "string" ? connected : null;
}

/**
 * The accounts a top-level insert writes for, when its model is fenced. A
 * nested create (through another model's relation) is not seen here; the
 * trigger still covers it during the window.
 */
export function fencedWriteOwners(model: string, operation: string, args: unknown): string[] {
  if (!FENCED.has(model) || !FENCED_OPERATIONS.has(operation)) return [];
  const input = (args ?? {}) as { data?: unknown; create?: unknown };
  const rows =
    operation === "upsert" ? [input.create] : Array.isArray(input.data) ? input.data : [input.data];
  const owners = new Set<string>();
  for (const row of rows) {
    const owner = ownerOf(row);
    if (owner) owners.add(owner);
  }
  return [...owners];
}
