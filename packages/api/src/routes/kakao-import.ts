/**
 * /api/kakao-import — upload one exported KakaoTalk chat
 * (docs/providers/kakaotalk-import.md §7).
 *
 * Dark until KAKAO_IMPORT_ENABLED (Fastify's default 404, even
 * unauthenticated); every route is requireAuth + cohortGate and acts on the
 * session user's own rows only. Two steps: POST /preview parses the file and
 * returns its speakers and counts, storing nothing; POST / re-sends the file
 * with the speaker the user picked as themselves and the consent that it holds
 * other people's messages, and stores the in-window messages for processing.
 * No response or error ever echoes the uploaded text or a speaker name it was
 * not asked for.
 */

import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { KAKAO_IMPORT_FLAGS, kakaoImportLive } from "../config.js";
import {
  KAKAO_MAX_FILE_BYTES,
  KAKAO_MAX_SPEAKER_CHARS,
  type KakaoFormat,
  type KakaoMessage,
  type KakaoParseErrorCode,
  parseKakaoExport,
} from "../kakao-import/parse.js";
import {
  createKakaoImport,
  deleteKakaoImport,
  getKakaoImport,
  listKakaoImports,
} from "../kakao-import/store.js";
import { kakaoWindow, previewKakaoExport, selectWindowMessages } from "../kakao-import/window.js";
import { getUserTimeZone } from "../user-timezone.js";
import { cohortGate } from "./cohort-gate.js";
import { darkRouteGate } from "./dark-route-gate.js";
import { type RouteRateLimit, rateLimitHook } from "./rate-limit-hook.js";

const PREVIEW_LIMIT: RouteRateLimit = { max: 30, timeWindow: "1 hour" };
const IMPORT_LIMIT: RouteRateLimit = { max: 10, timeWindow: "24 hours" };
const READ_LIMIT: RouteRateLimit = { max: 120, timeWindow: "1 minute" };
const DELETE_LIMIT: RouteRateLimit = { max: 30, timeWindow: "1 minute" };
const RATE_LIMITED = "Too many KakaoTalk import requests. Try again later.";
/** Multipart framing around the file: boundaries, part headers, the two small fields. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const UPLOAD_FILE_FIELD = "file";
const UPLOAD_FIELDS = new Set(["me", "consent"]);
const FIELD_MAX_BYTES = KAKAO_MAX_SPEAKER_CHARS * 4;
const MAX_ID_CHARS = 64;
/** Uploads parsed at once on one instance; each holds up to ~100 MB while it runs. */
const MAX_CONCURRENT_UPLOADS = 2;
const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;

type RouteErrorCode =
  | KakaoParseErrorCode
  | "invalid-upload"
  | "consent-required"
  | "speaker-not-found"
  | "too-many-imports"
  | "import-in-progress"
  | "busy"
  | "not-found";

const ERRORS: Record<RouteErrorCode, { status: number; message: string }> = {
  "empty-file": { status: 400, message: "The file is empty." },
  "file-too-large": { status: 413, message: "The file is larger than 10 MB." },
  "unsupported-encoding": { status: 415, message: "The file is not UTF-8 text." },
  "zip-not-supported": {
    status: 415,
    message: "Unzip the export and upload the .txt or .csv file.",
  },
  "unknown-format": { status: 422, message: "This does not look like a KakaoTalk chat export." },
  "no-messages": { status: 422, message: "The export holds no messages." },
  "too-many-lines": { status: 413, message: "The file has too many lines." },
  "too-many-messages": { status: 413, message: "The file has too many messages." },
  "too-many-speakers": { status: 422, message: "The chat has too many participants." },
  "invalid-upload": { status: 400, message: "Send one file as multipart/form-data." },
  "consent-required": {
    status: 400,
    message: "Confirm that you may import this chat, which holds other people's messages.",
  },
  "speaker-not-found": {
    status: 400,
    message: "Pick your own name from the speakers in the file.",
  },
  "too-many-imports": { status: 409, message: "Delete an older import before adding another." },
  "import-in-progress": {
    status: 409,
    message: "Wait for your imports in progress to finish before adding another.",
  },
  busy: { status: 503, message: "Imports are busy. Try again in a minute." },
  "not-found": { status: 404, message: "Import not found." },
};

class KakaoRouteError extends Error {
  constructor(readonly code: RouteErrorCode) {
    super(code);
    this.name = "KakaoRouteError";
  }
}

function sendError(reply: FastifyReply, code: RouteErrorCode): FastifyReply {
  const { status, message } = ERRORS[code];
  return reply.code(status).send({ error: message, code });
}

/** Read the rest of a refused body and drop it, so the client's write completes. */
function drainRequest(request: FastifyRequest): void {
  request.raw.unpipe();
  request.raw.resume();
}

/** Every failure while reading the form is the parser's: its size limit, or a malformed body. */
function readFailure(err: unknown): KakaoRouteError {
  if (err instanceof KakaoRouteError) return err;
  const code = err instanceof Error ? (err as Error & { code?: string }).code : undefined;
  return new KakaoRouteError(
    code === "FST_REQ_FILE_TOO_LARGE" ? "file-too-large" : "invalid-upload",
  );
}

interface Upload {
  readonly bytes: Buffer;
  readonly fields: ReadonlyMap<string, string>;
}

/** The one file part and the small fields, each at most once. */
async function readUpload(request: FastifyRequest): Promise<Upload> {
  if (!request.isMultipart()) throw new KakaoRouteError("invalid-upload");
  if (Number(request.headers["content-length"]) > KAKAO_MAX_FILE_BYTES + MULTIPART_OVERHEAD_BYTES) {
    throw new KakaoRouteError("file-too-large");
  }
  let upload: Upload;
  try {
    upload = await readParts(request);
  } catch (err) {
    drainRequest(request);
    throw readFailure(err);
  }
  if (upload.bytes.length > KAKAO_MAX_FILE_BYTES) throw new KakaoRouteError("file-too-large");
  return upload;
}

async function readParts(request: FastifyRequest): Promise<Upload> {
  const fields = new Map<string, string>();
  let bytes: Buffer | null = null;
  for await (const part of request.parts()) {
    if (part.type === "field") {
      const known = UPLOAD_FIELDS.has(part.fieldname) && !fields.has(part.fieldname);
      if (!known || part.valueTruncated) throw new KakaoRouteError("invalid-upload");
      fields.set(part.fieldname, String(part.value));
      continue;
    }
    if (part.fieldname !== UPLOAD_FILE_FIELD || bytes !== null) {
      throw new KakaoRouteError("invalid-upload");
    }
    bytes = await part.toBuffer();
  }
  if (bytes === null) throw new KakaoRouteError("invalid-upload");
  return { bytes, fields };
}

interface ParsedUpload {
  readonly upload: Upload;
  readonly format: KakaoFormat;
  readonly messages: readonly KakaoMessage[];
  readonly timeZone: string;
}

async function parseUpload(request: FastifyRequest, userId: string): Promise<ParsedUpload> {
  const upload = await readUpload(request);
  const parsed = parseKakaoExport(upload.bytes);
  if (!parsed.ok) throw new KakaoRouteError(parsed.code);
  const timeZone = await getUserTimeZone(userId);
  return { upload, format: parsed.format, messages: parsed.messages, timeZone };
}

let uploadsInFlight = 0;

/**
 * Runs an upload's handler holding one of the few upload slots: each buffers
 * up to 10 MiB and its parse, so concurrent uploads are bounded, not just
 * rate-limited. A request over the limit is refused before its body is read.
 */
async function withUploadSlot<T>(request: FastifyRequest, run: () => Promise<T>): Promise<T> {
  if (uploadsInFlight >= MAX_CONCURRENT_UPLOADS) {
    drainRequest(request);
    throw new KakaoRouteError("busy");
  }
  uploadsInFlight++;
  try {
    return await run();
  } finally {
    uploadsInFlight--;
  }
}

/** Runs the handler; a KakaoRouteError becomes its status and code, anything else a 500. */
async function answer<T>(reply: FastifyReply, run: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof KakaoRouteError) return sendError(reply, err.code);
    throw err;
  }
}

function previewHandler(request: FastifyRequest, reply: FastifyReply) {
  return answer(reply, () =>
    withUploadSlot(request, async () => {
      const { format, messages, timeZone } = await parseUpload(request, getUserId(request));
      return { preview: previewKakaoExport(format, messages, timeZone, kakaoWindow(new Date())) };
    }),
  );
}

async function storeImport(userId: string, parsed: ParsedUpload) {
  const { upload, format, messages, timeZone } = parsed;
  if (upload.fields.get("consent") !== "true") throw new KakaoRouteError("consent-required");
  const me = upload.fields.get("me") ?? "";
  const speakers = new Set(messages.map((message) => message.speaker));
  if (!speakers.has(me)) throw new KakaoRouteError("speaker-not-found");
  const window = kakaoWindow(new Date());
  const created = await createKakaoImport({
    userId,
    format,
    totalMessages: messages.length,
    speakerCount: speakers.size,
    window,
    messages: selectWindowMessages(messages, timeZone, window),
    me,
  });
  if (!created.ok) throw new KakaoRouteError(created.reason);
  return created.summary;
}

function importHandler(request: FastifyRequest, reply: FastifyReply) {
  return answer(reply, () =>
    withUploadSlot(request, async () => {
      const userId = getUserId(request);
      const summary = await storeImport(userId, await parseUpload(request, userId));
      return reply.code(HTTP_CREATED).send({ import: summary });
    }),
  );
}

type IdRequest = FastifyRequest<{ Params: { id: string } }>;

function validId(id: string): boolean {
  return id.length > 0 && id.length <= MAX_ID_CHARS;
}

async function getHandler(request: IdRequest, reply: FastifyReply) {
  if (!validId(request.params.id)) return sendError(reply, "not-found");
  const found = await getKakaoImport(getUserId(request), request.params.id);
  return found === null ? sendError(reply, "not-found") : { import: found };
}

async function deleteHandler(request: IdRequest, reply: FastifyReply) {
  if (!validId(request.params.id)) return sendError(reply, "not-found");
  const deleted = await deleteKakaoImport(getUserId(request), request.params.id);
  return deleted ? reply.code(HTTP_NO_CONTENT).send() : sendError(reply, "not-found");
}

export async function kakaoImportRoutes(app: FastifyInstance) {
  app.addHook("onRequest", darkRouteGate(kakaoImportLive));
  // Scoped to this plugin. The file limit is one byte over the cap, so a file
  // over it is refused rather than silently cut to size.
  await app.register(multipart, {
    limits: {
      fileSize: KAKAO_MAX_FILE_BYTES + 1,
      files: 1,
      fields: UPLOAD_FIELDS.size,
      fieldSize: FIELD_MAX_BYTES,
      parts: UPLOAD_FIELDS.size + 1,
    },
  });
  const perUser = (name: string, limit: RouteRateLimit) =>
    rateLimitHook(
      app,
      limit,
      (request) => `kakao-import:${name}:user:${getUserId(request)}`,
      RATE_LIMITED,
    );
  const previewLimit = perUser("preview", PREVIEW_LIMIT);
  const importLimit = perUser("import", IMPORT_LIMIT);
  const readLimit = perUser("read", READ_LIMIT);
  const deleteLimit = perUser("delete", DELETE_LIMIT);

  app.post(
    "/preview",
    {
      preHandler: [requireAuth, cohortGate(KAKAO_IMPORT_FLAGS), previewLimit],
      config: { rateLimit: PREVIEW_LIMIT },
    },
    previewHandler,
  );
  app.post(
    "/",
    {
      preHandler: [requireAuth, cohortGate(KAKAO_IMPORT_FLAGS), importLimit],
      config: { rateLimit: IMPORT_LIMIT },
    },
    importHandler,
  );
  app.get(
    "/",
    {
      preHandler: [requireAuth, cohortGate(KAKAO_IMPORT_FLAGS), readLimit],
      config: { rateLimit: READ_LIMIT },
    },
    async (request) => ({ imports: await listKakaoImports(getUserId(request)) }),
  );
  app.get<{ Params: { id: string } }>(
    "/:id",
    {
      preHandler: [requireAuth, cohortGate(KAKAO_IMPORT_FLAGS), readLimit],
      config: { rateLimit: READ_LIMIT },
    },
    getHandler,
  );
  app.delete<{ Params: { id: string } }>(
    "/:id",
    {
      preHandler: [requireAuth, cohortGate(KAKAO_IMPORT_FLAGS), deleteLimit],
      config: { rateLimit: DELETE_LIMIT },
    },
    deleteHandler,
  );
}
