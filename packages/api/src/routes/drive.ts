/**
 * Drive routes — step D2 of docs/providers/unified-platform-plan.md. A read-only
 * view of the metadata index of the user's files across sources.
 *
 *   GET /files       — list, newest first; `q` searches names; `folder` lists
 *                      one Klorn drive folder (D3); paged
 *   GET /files/:id   — one file's metadata (and its summary, D4)
 *   POST /files/:id/summarize — summarise one file now (D4)
 *
 * Summaries (D4) are behind DRIVE_SUMMARIES_ENABLED as well, read per request:
 * while off, the summarize route answers Fastify's default 404 (its own
 * darkRouteGate, after the drive's), the file response has no `summary`, and
 * the search matches names only, reading nothing else.
 *
 * Upload, folders, download, rename/move and delete of the Klorn drive (D3) are
 * routes/klorn-drive.ts, under the same prefix. Session-authenticated and
 * user-scoped through drive/drive-read.ts, which also applies the provider kill
 * switch.
 *
 * Each route is rate limited twice: per client address (route config, before
 * authentication) and per user (after it), so neither many users behind one
 * address nor one user behind many addresses can pass the limit.
 *
 * Every route sits behind DRIVE_ENABLED via darkRouteGate: while off they answer
 * Fastify's default 404, before authentication and before any query.
 */

import type {
  DriveFileResponse,
  DriveFilesListResponse,
  DriveSummarizeResponse,
} from "@klorn/contract";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { DRIVE_PROVIDER_NAMES, type DriveProviderName } from "../drive/drive-providers.js";
import {
  DRIVE_CURSOR_MAX_CHARS,
  decodeDriveCursor,
  getFile,
  listFiles,
  normaliseDriveSearchText,
  searchFiles,
} from "../drive/drive-read.js";
import { DRIVE_ID_MAX_CHARS } from "../drive/drive-rows.js";
import { DRIVE_PROVIDER_ENABLED, type DriveProviderEnabledMap } from "../drive/drive-scope.js";
import { driveSummariesLive } from "../drive/summary-policy.js";
import { requestDriveSummary, summaryForFile } from "../drive/summary-triggers.js";
import { captureError } from "../sentry.js";
import { darkRouteGate } from "./dark-route-gate.js";
import { rateLimitHook } from "./rate-limit-hook.js";

/**
 * The list and the search share one limit: a search reads one user's rows, so it
 * takes the lower of the sibling read routes' limits (30 a minute, routes/api-keys.ts).
 * Applied per client address and, separately, per user.
 */
export const DRIVE_LIST_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const;
/** One row by id: the higher sibling limit (60 a minute, routes/email-mailbox.ts). Likewise both. */
export const DRIVE_FILE_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const;
/**
 * On-demand summaries (D4): each may spend one model call, so the tightest of the
 * drive's limits. Likewise both; the daily caps (summary-policy.ts) still apply.
 */
export const DRIVE_SUMMARIZE_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const;

const RATE_LIMITED = "Too many drive requests. Try again later.";

/** Longer than any text the search uses; the reader takes the first 100 characters. */
const QUERY_TEXT_MAX_CHARS = 500;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const INVALID_CURSOR = { error: "Invalid cursor" } as const;
const FILE_NOT_FOUND = { error: "File not found" } as const;

const listQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    q: { type: "string", maxLength: QUERY_TEXT_MAX_CHARS },
    provider: { type: "string", enum: [...DRIVE_PROVIDER_NAMES] },
    sourceKey: { type: "string", minLength: 1, maxLength: DRIVE_ID_MAX_CHARS },
    // Only "at least one" is refused here: the reader clamps the ceiling, so a
    // large limit is served the largest page instead of an error.
    limit: { type: "integer", minimum: 1 },
    cursor: { type: "string", minLength: 1, maxLength: DRIVE_CURSOR_MAX_CHARS },
    // One folder of the Klorn drive (D3): a folder's externalId, or "root".
    folder: { type: "string", minLength: 1, maxLength: DRIVE_ID_MAX_CHARS },
  },
} as const;

/** The `folder` value that names the Klorn drive's root. */
export const DRIVE_ROOT_FOLDER = "root";

interface ListQuery {
  q?: string;
  provider?: DriveProviderName;
  sourceKey?: string;
  limit?: number;
  cursor?: string;
  folder?: string;
}

interface IdParams {
  id: string;
}

let summarySearchFailureReported = false;
let summaryReadFailureReported = false;

/** A summary search that failed falls back to names; said once per process. */
function reportSummarySearchFailure(err: unknown): void {
  if (summarySearchFailureReported) return;
  summarySearchFailureReported = true;
  console.error("[DRIVE] summary search failed; answering name matches only");
  captureError(err, { tags: { scope: "drive.summary.search" } });
}

/** A summary read that failed leaves the file without it; said once per process. */
function reportSummaryReadFailure(err: unknown): void {
  if (summaryReadFailureReported) return;
  summaryReadFailureReported = true;
  console.error("[DRIVE] summary read failed; answering the file without its summary");
  captureError(err, { tags: { scope: "drive.summary.read" } });
}

export function driveRoutes(opts: {
  gate: () => boolean;
  /** The connector flags the reads honour; a connector's tests pass their own. */
  providerEnabled?: DriveProviderEnabledMap;
  /** Whether summaries are on (D4); read per request. */
  summariesGate?: () => boolean;
}): (app: FastifyInstance) => Promise<void> {
  const providerEnabled = opts.providerEnabled ?? DRIVE_PROVIDER_ENABLED;
  const summariesGate = opts.summariesGate ?? driveSummariesLive;

  async function listHandler(
    request: FastifyRequest<{ Querystring: ListQuery }>,
    reply: FastifyReply,
  ): Promise<DriveFilesListResponse | FastifyReply> {
    const { q, provider, sourceKey, limit, cursor: rawCursor, folder: rawFolder } = request.query;
    const cursor = rawCursor === undefined ? undefined : decodeDriveCursor(rawCursor);
    if (cursor === null) return reply.code(HTTP_BAD_REQUEST).send(INVALID_CURSOR);
    const folder = rawFolder === DRIVE_ROOT_FOLDER ? null : rawFolder;
    const options = { userId: getUserId(request), limit, cursor, provider, sourceKey, folder };
    const text = normaliseDriveSearchText(q);
    if (text === null) return await listFiles(options, providerEnabled);
    if (!summariesGate()) return await searchFiles({ ...options, text }, providerEnabled);
    try {
      return await searchFiles({ ...options, text, matchSummaries: true }, providerEnabled);
    } catch (err) {
      reportSummarySearchFailure(err);
      return await searchFiles({ ...options, text }, providerEnabled);
    }
  }

  async function fileHandler(
    request: FastifyRequest<{ Params: IdParams }>,
    reply: FastifyReply,
  ): Promise<DriveFileResponse | FastifyReply> {
    const userId = getUserId(request);
    const file = await getFile(userId, request.params.id, providerEnabled);
    if (file === null) return reply.code(HTTP_NOT_FOUND).send(FILE_NOT_FOUND);
    if (!summariesGate()) return { file };
    try {
      return { file, summary: await summaryForFile(userId, file.id) };
    } catch (err) {
      // The file without its summary, as with the flag off: never a 500.
      reportSummaryReadFailure(err);
      return { file };
    }
  }

  async function summarizeHandler(
    request: FastifyRequest<{ Params: IdParams }>,
    reply: FastifyReply,
  ): Promise<DriveSummarizeResponse | FastifyReply> {
    const summary = await requestDriveSummary(getUserId(request), request.params.id, {
      providerEnabled,
    });
    if (summary === null) return reply.code(HTTP_NOT_FOUND).send(FILE_NOT_FOUND);
    return { summary };
  }

  return async function routes(app: FastifyInstance) {
    app.addHook("onRequest", darkRouteGate(opts.gate));
    // The per-user limits run after authentication: they need the user.
    const perUser = (
      name: string,
      limit:
        | typeof DRIVE_LIST_RATE_LIMIT
        | typeof DRIVE_FILE_RATE_LIMIT
        | typeof DRIVE_SUMMARIZE_RATE_LIMIT,
    ) =>
      rateLimitHook(
        app,
        limit,
        (request) => `drive:${name}:user:${getUserId(request)}`,
        RATE_LIMITED,
      );

    app.get<{ Querystring: ListQuery }>(
      "/files",
      {
        preHandler: [requireAuth, perUser("list", DRIVE_LIST_RATE_LIMIT)],
        config: { rateLimit: DRIVE_LIST_RATE_LIMIT },
        schema: { querystring: listQuerySchema },
      },
      listHandler,
    );
    app.get<{ Params: IdParams }>(
      "/files/:id",
      {
        preHandler: [requireAuth, perUser("file", DRIVE_FILE_RATE_LIMIT)],
        config: { rateLimit: DRIVE_FILE_RATE_LIMIT },
      },
      fileHandler,
    );
    app.post<{ Params: IdParams }>(
      "/files/:id/summarize",
      {
        // After the drive's own gate: dark unless summaries are on too.
        onRequest: darkRouteGate(summariesGate),
        preHandler: [requireAuth, perUser("summarize", DRIVE_SUMMARIZE_RATE_LIMIT)],
        config: { rateLimit: DRIVE_SUMMARIZE_RATE_LIMIT },
      },
      summarizeHandler,
    );
  };
}
