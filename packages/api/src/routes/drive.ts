/**
 * Drive routes — step D2 of docs/providers/unified-platform-plan.md. A read-only
 * view of the metadata index of the user's files across sources.
 *
 *   GET /files       — list, newest first; `q` searches names; paged
 *   GET /files/:id   — one file's metadata
 *
 * There is no upload, download or delete here: those arrive with the Klorn drive
 * (D3). Session-authenticated and user-scoped through drive/drive-read.ts, which
 * also applies the provider kill switch; with no connector implemented the list
 * is empty and every id is a 404.
 *
 * Each route is rate limited twice: per client address (route config, before
 * authentication) and per user (after it), so neither many users behind one
 * address nor one user behind many addresses can pass the limit.
 *
 * Every route sits behind DRIVE_ENABLED via darkRouteGate: while off they answer
 * Fastify's default 404, before authentication and before any query.
 */

import type { DriveFileResponse, DriveFilesListResponse } from "@klorn/contract";
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
  },
} as const;

interface ListQuery {
  q?: string;
  provider?: DriveProviderName;
  sourceKey?: string;
  limit?: number;
  cursor?: string;
}

interface IdParams {
  id: string;
}

export function driveRoutes(opts: {
  gate: () => boolean;
  /** The connector flags the reads honour; a connector's tests pass their own. */
  providerEnabled?: DriveProviderEnabledMap;
}): (app: FastifyInstance) => Promise<void> {
  const providerEnabled = opts.providerEnabled ?? DRIVE_PROVIDER_ENABLED;

  async function listHandler(
    request: FastifyRequest<{ Querystring: ListQuery }>,
    reply: FastifyReply,
  ): Promise<DriveFilesListResponse | FastifyReply> {
    const { q, provider, sourceKey, limit, cursor: rawCursor } = request.query;
    const cursor = rawCursor === undefined ? undefined : decodeDriveCursor(rawCursor);
    if (cursor === null) return reply.code(HTTP_BAD_REQUEST).send(INVALID_CURSOR);
    const options = { userId: getUserId(request), limit, cursor, provider, sourceKey };
    const text = normaliseDriveSearchText(q);
    return text === null
      ? await listFiles(options, providerEnabled)
      : await searchFiles({ ...options, text }, providerEnabled);
  }

  async function fileHandler(
    request: FastifyRequest<{ Params: IdParams }>,
    reply: FastifyReply,
  ): Promise<DriveFileResponse | FastifyReply> {
    const file = await getFile(getUserId(request), request.params.id, providerEnabled);
    if (file === null) return reply.code(HTTP_NOT_FOUND).send(FILE_NOT_FOUND);
    return { file };
  }

  return async function routes(app: FastifyInstance) {
    app.addHook("onRequest", darkRouteGate(opts.gate));
    // The per-user limits run after authentication: they need the user.
    const perUser = (
      name: string,
      limit: typeof DRIVE_LIST_RATE_LIMIT | typeof DRIVE_FILE_RATE_LIMIT,
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
  };
}
