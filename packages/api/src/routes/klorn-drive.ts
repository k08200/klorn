/**
 * Klorn drive routes — step D3 of docs/providers/unified-platform-plan.md. The
 * user's own files, stored in object storage (D1), indexed in DriveFile (D2).
 * Listing and reading one file's metadata stay in routes/drive.ts (same prefix).
 *
 *   POST   /files                multipart upload            201 { file }
 *   POST   /folders              create a folder             201 { file }
 *   GET    /files/:id/download   a signed download link      { url, expiresInSeconds }
 *   PATCH  /files/:id            rename and/or move          { file }
 *   DELETE /files/:id            delete (a folder: with all) { deleted }
 *
 * Dark unless DRIVE_ENABLED, KLORN_DRIVE_ENABLED and OBJECT_STORAGE_ENABLED are
 * all on (`klornDriveRoutesEnabled`, read per request): Fastify's default 404,
 * before authentication. Session-authenticated; every operation finds the row
 * under the session's user id, and storage refuses a key outside that user's
 * prefix. A file of an external source is 409 `read-only` (decision V4).
 *
 * Download answers JSON with the link instead of a 302 to it. The web app calls
 * the API with an Authorization header, so it uses fetch, and fetch would follow
 * a 302 to the storage origin, which has no CORS rule (FA-7): the JSON lets the
 * page navigate to the link instead. A native client following a redirect could
 * carry Klorn's Authorization header to the storage vendor; with JSON it opens
 * the link in a fresh request. The answer is `Cache-Control: no-store`.
 *
 * Each route is rate limited twice: per client address (route config, before
 * authentication) and per user (after it), as the D2 routes are.
 */

import multipart, { type MultipartFile } from "@fastify/multipart";
import type {
  DriveDeleteResponse,
  DriveDownloadResponse,
  DriveErrorResponse,
  DriveUploadResponse,
} from "@klorn/contract";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { DRIVE_ID_MAX_CHARS } from "../drive/drive-rows.js";
import {
  DRIVE_PROVIDER_ENABLED,
  type DriveProviderEnabledMap,
  klornDriveRoutesEnabled,
} from "../drive/drive-scope.js";
import { KLORN_DRIVE_ERROR_STATUS, KlornDriveError } from "../drive/klorn-errors.js";
import { deleteKlornItem, klornDownloadLink } from "../drive/klorn-remove.js";
import { createKlornFolder, updateKlornItem } from "../drive/klorn-tree.js";
import {
  commitKlornUpload,
  discardKlornUpload,
  KLORN_DRIVE_MAX_FILE_BYTES,
  type StoredKlornUpload,
  storeKlornUpload,
} from "../drive/klorn-upload.js";
import { darkRouteGate } from "./dark-route-gate.js";
import { type RouteRateLimit, rateLimitHook } from "./rate-limit-hook.js";

/** Uploads: each one is a PUT of up to 25 MiB to the bucket. */
export const KLORN_UPLOAD_RATE_LIMIT = { max: 20, timeWindow: "1 minute" } as const;
/** Download links: one per click, like reading one row (routes/drive.ts). */
export const KLORN_DOWNLOAD_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const;
/** Deletes: a folder delete is up to DRIVE_FOLDER_WALK_MAX_ITEMS object deletes. */
export const KLORN_DELETE_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const;
/** Creating a folder, renaming and moving: metadata only. */
export const KLORN_EDIT_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const;

const RATE_LIMITED = "Too many drive requests. Try again later.";

/** Room in a request's Content-Length for the boundaries, part headers and fields. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
/** The fields an upload may carry, all before its one file part. */
const UPLOAD_FIELDS = new Set(["size", "parentExternalId"]);
const UPLOAD_FILE_FIELD = "file";
const NAME_MAX_INPUT_CHARS = 1000;
const HTTP_CREATED = 201;

/** Multipart failures the plugin reports by code: the request is malformed or too large. */
const MULTIPART_TOO_LARGE = new Set(["FST_REQ_FILE_TOO_LARGE"]);
const MULTIPART_MALFORMED = new Set([
  // The client closed the connection mid-upload.
  "ERR_STREAM_PREMATURE_CLOSE",
  "FST_MP_PREMATURE_CLOSE",
  "FST_FILES_LIMIT",
  "FST_FIELDS_LIMIT",
  "FST_PARTS_LIMIT",
  "FST_PROTO_VIOLATION",
  "FST_INVALID_MULTIPART_CONTENT_TYPE",
]);

const parentSchema = {
  anyOf: [{ type: "string", minLength: 1, maxLength: DRIVE_ID_MAX_CHARS }, { type: "null" }],
} as const;
const nameSchema = { type: "string", minLength: 1, maxLength: NAME_MAX_INPUT_CHARS } as const;

const createFolderSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: { name: nameSchema, parentExternalId: parentSchema },
} as const;

const updateSchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: { name: nameSchema, parentExternalId: parentSchema },
} as const;

interface IdParams {
  id: string;
}
interface FolderBody {
  name: string;
  parentExternalId?: string | null;
}
interface UpdateBody {
  name?: string;
  parentExternalId?: string | null;
}

function sendDriveError(reply: FastifyReply, err: KlornDriveError): FastifyReply {
  const body: DriveErrorResponse = { error: err.message, code: err.code, retryable: err.retryable };
  return reply.code(KLORN_DRIVE_ERROR_STATUS[err.code]).send(body);
}

/**
 * A failure while the request is read, as the drive's own error: the multipart
 * plugin's limits, a malformed body, and a client that went away mid-upload
 * (not a server fault, so not a 500). Anything else is unchanged.
 */
export function uploadRequestFailure(err: unknown): unknown {
  const code = err instanceof Error ? (err as Error & { code?: string }).code : undefined;
  if (code === undefined) return err;
  if (MULTIPART_TOO_LARGE.has(code)) return new KlornDriveError("too-large");
  if (MULTIPART_MALFORMED.has(code)) return new KlornDriveError("invalid-upload");
  return err;
}

/** Runs the operation; a KlornDriveError becomes its status and body, anything else a 500. */
async function answer<T>(reply: FastifyReply, run: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof KlornDriveError) return sendDriveError(reply, err);
    throw err;
  }
}

/**
 * Read the rest of a refused request's body and drop it. The multipart plugin
 * stops piping the request into its parser when a part is abandoned, and nothing
 * else reads it: the client's write would never complete and the socket would be
 * held until a server timeout.
 */
function drainRequest(request: FastifyRequest): void {
  request.raw.unpipe();
  request.raw.resume();
}

type UploadPart = MultipartFile;

/** Store the one file part with the fields read before it. */
async function storeFilePart(
  part: UploadPart,
  userId: string,
  fields: ReadonlyMap<string, string>,
  providerEnabled: DriveProviderEnabledMap,
): Promise<StoredKlornUpload> {
  const stored = await storeKlornUpload(
    {
      userId,
      fileName: part.filename,
      declaredSize: fields.get("size"),
      parentExternalId: fields.get("parentExternalId"),
      body: part.file,
    },
    providerEnabled,
  );
  // Defence in depth: unreachable while the plugin's file limit is the cap plus
  // one byte, because the byte counter refuses the body first.
  if (part.file.truncated) {
    await discardKlornUpload(stored);
    throw new KlornDriveError("too-large");
  }
  return stored;
}

/** Read the request: the fields, then the one file, which is stored on the way. */
async function readUpload(
  request: FastifyRequest,
  providerEnabled: DriveProviderEnabledMap,
): Promise<StoredKlornUpload> {
  const userId = getUserId(request);
  const fields = new Map<string, string>();
  let stored: StoredKlornUpload | null = null;
  try {
    for await (const part of request.parts()) {
      const allowed =
        stored === null &&
        (part.type === "field"
          ? UPLOAD_FIELDS.has(part.fieldname)
          : part.fieldname === UPLOAD_FILE_FIELD);
      if (!allowed) throw new KlornDriveError("invalid-upload");
      if (part.type === "field") fields.set(part.fieldname, String(part.value));
      else stored = await storeFilePart(part, userId, fields, providerEnabled);
    }
    if (stored === null) throw new KlornDriveError("invalid-upload");
    return stored;
  } catch (err) {
    drainRequest(request);
    // The object exists but the request did not end cleanly: no row, no object.
    if (stored !== null) await discardKlornUpload(stored);
    throw uploadRequestFailure(err);
  }
}

export function klornDriveRoutes(opts: {
  gate: () => boolean;
  /** The provider flags the operations honour; tests pass their own. */
  providerEnabled?: DriveProviderEnabledMap;
}): (app: FastifyInstance) => Promise<void> {
  const providerEnabled = opts.providerEnabled ?? DRIVE_PROVIDER_ENABLED;

  async function uploadHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<DriveUploadResponse | FastifyReply> {
    return await answer(reply, async () => {
      if (!request.isMultipart()) throw new KlornDriveError("invalid-upload");
      const length = Number(request.headers["content-length"]);
      if (length > KLORN_DRIVE_MAX_FILE_BYTES + MULTIPART_OVERHEAD_BYTES) {
        throw new KlornDriveError("too-large");
      }
      const stored = await readUpload(request, providerEnabled);
      const file = await commitKlornUpload(stored);
      return reply.code(HTTP_CREATED).send({ file } satisfies DriveUploadResponse);
    });
  }

  async function folderHandler(
    request: FastifyRequest<{ Body: FolderBody }>,
    reply: FastifyReply,
  ): Promise<DriveUploadResponse | FastifyReply> {
    return await answer(reply, async () => {
      const file = await createKlornFolder(getUserId(request), request.body, providerEnabled);
      return reply.code(HTTP_CREATED).send({ file } satisfies DriveUploadResponse);
    });
  }

  async function downloadHandler(
    request: FastifyRequest<{ Params: IdParams }>,
    reply: FastifyReply,
  ): Promise<DriveDownloadResponse | FastifyReply> {
    return await answer(reply, async () => {
      const link = await klornDownloadLink(getUserId(request), request.params.id, providerEnabled);
      reply.header("cache-control", "no-store");
      return link;
    });
  }

  async function updateHandler(
    request: FastifyRequest<{ Params: IdParams; Body: UpdateBody }>,
    reply: FastifyReply,
  ): Promise<DriveUploadResponse | FastifyReply> {
    return await answer(reply, async () => {
      const userId = getUserId(request);
      const file = await updateKlornItem(userId, request.params.id, request.body, providerEnabled);
      return { file };
    });
  }

  async function deleteHandler(
    request: FastifyRequest<{ Params: IdParams }>,
    reply: FastifyReply,
  ): Promise<DriveDeleteResponse | FastifyReply> {
    return await answer(reply, async () => {
      const deleted = await deleteKlornItem(getUserId(request), request.params.id, providerEnabled);
      return { deleted };
    });
  }

  return async function routes(app: FastifyInstance) {
    app.addHook("onRequest", darkRouteGate(opts.gate));
    // Scoped to this plugin. The file limit is one byte over the cap, so a file
    // over it reaches the byte counter (and fails) instead of being cut to size.
    await app.register(multipart, {
      limits: {
        fileSize: KLORN_DRIVE_MAX_FILE_BYTES + 1,
        files: 1,
        fields: UPLOAD_FIELDS.size,
        fieldSize: DRIVE_ID_MAX_CHARS * 2,
        parts: UPLOAD_FIELDS.size + 1,
      },
    });
    // The per-user limits run after authentication: they need the user.
    const perUser = (name: string, limit: RouteRateLimit) =>
      rateLimitHook(
        app,
        limit,
        (request) => `klorn-drive:${name}:user:${getUserId(request)}`,
        RATE_LIMITED,
      );
    const guarded = (name: string, limit: RouteRateLimit) => ({
      preHandler: [requireAuth, perUser(name, limit)],
      config: { rateLimit: limit },
    });

    app.post("/files", guarded("upload", KLORN_UPLOAD_RATE_LIMIT), uploadHandler);
    app.post<{ Body: FolderBody }>(
      "/folders",
      { ...guarded("folder", KLORN_EDIT_RATE_LIMIT), schema: { body: createFolderSchema } },
      folderHandler,
    );
    app.get<{ Params: IdParams }>(
      "/files/:id/download",
      guarded("download", KLORN_DOWNLOAD_RATE_LIMIT),
      downloadHandler,
    );
    app.patch<{ Params: IdParams; Body: UpdateBody }>(
      "/files/:id",
      { ...guarded("update", KLORN_EDIT_RATE_LIMIT), schema: { body: updateSchema } },
      updateHandler,
    );
    app.delete<{ Params: IdParams }>(
      "/files/:id",
      guarded("delete", KLORN_DELETE_RATE_LIMIT),
      deleteHandler,
    );
  };
}

/** The gate index.ts registers these routes behind (drive/drive-scope.ts). */
export { klornDriveRoutesEnabled };
