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
 *      however late it arrives. The hook reads an in-memory snapshot of the
 *      recent wipes, refreshed in the background (FENCE_REFRESH_MS), never the
 *      database: a read on the write path would need a second pool connection
 *      while the caller may hold the only one in an interactive transaction.
 *      The window in (1) only needs to cover the gap between this check and
 *      its insert plus the snapshot's age.
 *
 * Rows of Message, ConversationSummary and CommitmentPath carry no userId; the
 * owner is their parent's (PARENT_SCOPED_MODELS), for the trigger and the hook
 * alike. Raw INSERTs (email-attachments.ts, email-candidate-intake.ts) bypass
 * the hook; the trigger covers them during the window, and their foreign key
 * to EmailMessage, whose inserts are fenced, after it.
 *
 * New work that begins after `fenceUntil` writes normally. Account deletion
 * needs none of this: deleting the account row is atomic against inserts that
 * reference it.
 */

import { newWork, workStartedAt } from "../work-context.js";

/** Fence window after the purge commits; far above the snapshot's refresh plus a pool wait. */
export const DATA_WIPE_FENCE_MS = 5 * 60_000;

/** In the trigger's exception text, so a rejected insert is recognizable. */
export const DATA_WIPE_FENCE_MARKER = "klorn_data_wipe_fence";

/** Background refresh of the snapshot of recent wipes. */
export const FENCE_REFRESH_MS = 30_000;
/** A snapshot older than this is refreshed on the write path, as a fallback. */
const FENCE_STALE_MS = 4 * 60_000;

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
  TokenUsage: "usage counts, no content; the wipe deletes them, new usage must still be recorded",
  LlmCostLedger: "the daily spend cap itself",
  LlmUsageLog: "usage counts, no content; the wipe deletes them, new usage must still be recorded",
  AnalyticsEvent: "product analytics written inline by requests, no mail content",
  PmfResponse: "a survey answer the user typed, not derived from mail",
  StoragePurge: "the stored-object purge queue, written by the wipe itself",
  DataWipe: "the fence's own record",
};

/** Fenced tables without a userId: the owner is the parent row's. */
export const PARENT_SCOPED_MODELS: Record<string, { parent: string; key: string }> = {
  Message: { parent: "Conversation", key: "conversationId" },
  ConversationSummary: { parent: "Conversation", key: "conversationId" },
  CommitmentPath: { parent: "Commitment", key: "commitmentId" },
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

type FenceLoader = () => Promise<Array<DataWipeState & { userId: string }>>;
type ParentOwnerResolver = (parent: string, id: string) => Promise<string | null>;

let loadFences: FenceLoader | null = null;
let resolveParentOwner: ParentOwnerResolver | null = null;
let snapshot = new Map<string, DataWipeState>();
let loadedAt = 0;
let loading: Promise<void> | null = null;

/** db.ts wires these to the unextended client, so the check never recurses. */
export function setDataWipeSources(sources: {
  load: FenceLoader | null;
  parentOwner: ParentOwnerResolver | null;
}): void {
  loadFences = sources.load;
  resolveParentOwner = sources.parentOwner;
  snapshot = new Map();
  loadedAt = 0;
  loading = null;
}

/** Reload the snapshot of recent wipes now; single-flight. */
export function refreshDataWipes(): Promise<void> {
  if (!loadFences) return Promise.resolve();
  const load = loadFences;
  loading ??= load()
    .then((rows) => {
      snapshot = new Map(
        rows.map((row) => [row.userId, { purgedAt: row.purgedAt, fenceUntil: row.fenceUntil }]),
      );
      loadedAt = Date.now();
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;

/** Keep the snapshot fresh in the background (index.ts starts it at boot). */
export function startDataWipeRefresh(): void {
  if (refreshTimer) return;
  const refresh = () =>
    refreshDataWipes().catch((err: unknown) => {
      console.error("[DATA-WIPE] Could not refresh the wipe snapshot:", err);
    });
  void refresh();
  refreshTimer = setInterval(newWork(refresh), FENCE_REFRESH_MS);
  refreshTimer.unref?.();
}

export function stopDataWipeRefresh(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

/** The wipe records its own state here at once, ahead of the next refresh. */
export function rememberDataWipe(userId: string, state: DataWipeState): void {
  snapshot = new Map(snapshot).set(userId, state);
}

function blocks(state: DataWipeState, startedAt: Date): boolean {
  if (state.purgedAt === null) return true;
  return state.fenceUntil !== null && startedAt < state.fenceUntil;
}

/** Throws DataWipeFenceError when the current work may not write for `userId`. */
export async function assertWorkMayWrite(userId: string): Promise<void> {
  if (loadFences && Date.now() - loadedAt > FENCE_STALE_MS) await refreshDataWipes();
  const state = snapshot.get(userId);
  if (state && blocks(state, workStartedAt())) throw new DataWipeFenceError();
}

/** True when some recorded wipe could reject a write from the current work. */
function anyWipeBlocksThisWork(): boolean {
  const startedAt = workStartedAt();
  for (const state of snapshot.values()) if (blocks(state, startedAt)) return true;
  return false;
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

function rowsOf(operation: string, args: unknown): unknown[] {
  const input = (args ?? {}) as { data?: unknown; create?: unknown };
  if (operation === "upsert") return [input.create];
  return Array.isArray(input.data) ? input.data : [input.data];
}

/**
 * The accounts a top-level insert writes for, when its model is fenced. A
 * nested create (through another model's relation) is not seen here; the
 * trigger still covers it during the window.
 */
export function fencedWriteOwners(model: string, operation: string, args: unknown): string[] {
  if (!FENCED.has(model) || !FENCED_OPERATIONS.has(operation)) return [];
  const owners = new Set<string>();
  for (const row of rowsOf(operation, args)) {
    const owner = ownerOf(row);
    if (owner) owners.add(owner);
  }
  return [...owners];
}

/**
 * The write check the query hook runs. Cheap when no recorded wipe could
 * reject this work, which is nearly always: then no owner is resolved at all.
 */
export async function assertFencedWriteAllowed(
  model: string,
  operation: string,
  args: unknown,
): Promise<void> {
  if (!FENCED_OPERATIONS.has(operation)) return;
  const scoped = PARENT_SCOPED_MODELS[model];
  if (!FENCED.has(model) && !scoped) return;
  if (loadFences && Date.now() - loadedAt > FENCE_STALE_MS) await refreshDataWipes();
  if (!anyWipeBlocksThisWork()) return;
  if (!scoped) {
    for (const owner of fencedWriteOwners(model, operation, args)) await assertWorkMayWrite(owner);
    return;
  }
  for (const row of rowsOf(operation, args)) {
    const parentId =
      row && typeof row === "object" ? (row as Record<string, unknown>)[scoped.key] : null;
    if (typeof parentId !== "string" || !resolveParentOwner) continue;
    const owner = await resolveParentOwner(scoped.parent, parentId);
    if (owner) await assertWorkMayWrite(owner);
  }
}
