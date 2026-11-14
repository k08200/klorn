/**
 * Klorn Vault download (VAULT_EXPORT_ENABLED, off by default; `cohort` opens
 * it to ROLLOUT_COHORT_USER_IDS only):
 *
 *   GET /api/user/me/vault/export[?bodies=1]
 *
 * Streams the user's own Klorn data as an Obsidian-compatible markdown zip
 * (vault/vault-export.ts). Full mail text only with bodies=1; without it a
 * mail note still holds the subject, the preview line and Klorn's decision
 * (with any quote checked against the mail). The archive is built as it
 * streams and stored nowhere: no file, no content row, no cache.
 *
 * While the flag is off the route answers Fastify's default 404 before any
 * auth (darkRouteGate); in cohort mode a user outside it gets the same 404
 * after auth (cohortGate). Then, in order: one export per user at a time and
 * MAX_CONCURRENT_EXPORTS per process (429 / 503), one per user per
 * VAULT_EXPORT_COOLDOWN_MS (429 with retryAfterSeconds, from the audit table),
 * an audit row settled when the request ends however it ends, and a
 * wall-clock cap on the whole request (VAULT_LIMITS.streamMaxMs).
 */

import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { VAULT_EXPORT_FLAG, vaultExportLive } from "../config.js";
import { readerLanguageFor } from "../notify/request-language.js";
import { captureError } from "../sentry.js";
import { getUserTimeZone } from "../user-timezone.js";
import {
  acquireExportSlot,
  cooldownRemainingMs,
  type ExportEnd,
  type ExportSlot,
  recordExportEnd,
  recordExportStart,
} from "../vault/vault-audit.js";
import { newVaultProgress, type VaultExportInput, vaultArchive } from "../vault/vault-export.js";
import { VAULT_LIMITS } from "../vault/vault-limits.js";
import { localDate } from "../vault/vault-mail-rows.js";
import { cohortGate } from "./cohort-gate.js";
import { darkRouteGate } from "./dark-route-gate.js";

const VAULT_EXPORT_FLAGS = [VAULT_EXPORT_FLAG] as const;
const MS_PER_SECOND = 1000;
// nginx's "client closed request": nothing reads it, the socket is gone.
const CLIENT_CLOSED_REQUEST = 499;

const querySchema = {
  type: "object",
  additionalProperties: false,
  properties: { bodies: { type: "string", enum: ["0", "1"] } },
} as const;

const IN_PROGRESS = {
  error: "An export is already running. Wait for it to finish.",
  code: "export-in-progress",
  retryable: true,
} as const;
const SERVER_BUSY = {
  error: "Exports are busy right now. Try again in a minute.",
  code: "exports-busy",
  retryable: true,
} as const;
const COOLDOWN_MESSAGE = "You exported recently. Try again in a few minutes.";

/**
 * One export request's lifecycle. Watching starts right after the slot is
 * taken, before any await, so a client that leaves at any point (before the
 * stream, during it, or by stalling past streamMaxMs) frees the slot. The
 * slot is released and the audit row settled at most once.
 */
class ExportRun {
  readonly progress = newVaultProgress();
  closed = false;
  #auditId: string | null = null;
  #settled = false;
  #timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly userId: string,
    private readonly slot: ExportSlot,
  ) {}

  watch(reply: FastifyReply, maxMs: number): void {
    reply.raw.once("close", () => {
      this.closed = true;
      void this.finish("aborted");
    });
    this.#timer = setTimeout(() => reply.raw.destroy(), maxMs);
    this.#timer.unref();
  }

  started(auditId: string): void {
    this.#auditId = auditId;
  }

  finish(outcome: ExportEnd["outcome"]): Promise<void> {
    this.slot.release();
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#settled || !this.#auditId) return Promise.resolve();
    this.#settled = true;
    return recordExportEnd(this.#auditId, this.userId, {
      outcome,
      noteCount: this.progress.notes,
      byteCount: this.progress.bytes,
    });
  }
}

/** The archive as a byte stream that settles `run` when it ends or fails. */
function archiveStream(input: VaultExportInput, run: ExportRun): Readable {
  async function* chunks(): AsyncGenerator<Buffer> {
    let outcome: ExportEnd["outcome"] = "aborted";
    try {
      yield* vaultArchive(input, run.progress);
      outcome = run.progress.partial ? "partial" : "ok";
    } catch (err) {
      outcome = "error";
      // The name only: a message could quote a stored value.
      const name = err instanceof Error ? err.name : "unknown";
      console.error("[VAULT-EXPORT] export failed:", name);
      captureError(new Error(`vault export failed: ${name}`), { tags: { area: "vault-export" } });
      throw err;
    } finally {
      // Not awaited: the download must not wait on the audit write.
      void run.finish(outcome);
    }
  }
  return Readable.from(chunks(), { objectMode: false });
}

function replyCooldown(reply: FastifyReply, waitMs: number) {
  const retryAfterSeconds = Math.ceil(waitMs / MS_PER_SECOND);
  reply.header("retry-after", String(retryAfterSeconds));
  return reply
    .code(429)
    .send({ error: COOLDOWN_MESSAGE, code: "rate-limited", retryable: true, retryAfterSeconds });
}

async function exportHandler(request: FastifyRequest, reply: FastifyReply) {
  const userId = getUserId(request);
  const includeBodies = (request.query as { bodies?: string }).bodies === "1";
  const slot = acquireExportSlot(userId);
  if (slot === "user-busy") return reply.code(429).send(IN_PROGRESS);
  if (slot === "server-busy") return reply.code(503).send(SERVER_BUSY);
  const run = new ExportRun(userId, slot);
  run.watch(reply, VAULT_LIMITS.streamMaxMs);

  let streaming = false;
  try {
    const now = new Date();
    const waitMs = await cooldownRemainingMs(userId, now);
    if (waitMs > 0) return replyCooldown(reply, waitMs);
    const [language, timeZone] = await Promise.all([
      readerLanguageFor(request, reply, userId),
      getUserTimeZone(userId),
    ]);
    run.started(await recordExportStart(userId, includeBodies));
    if (run.closed) {
      // The client left while this request was starting: audited as aborted.
      await run.finish("aborted");
      return reply.code(CLIENT_CLOSED_REQUEST).send();
    }
    const input: VaultExportInput = {
      userId,
      includeBodies,
      language,
      timeZone,
      now,
      limits: VAULT_LIMITS,
    };
    const stream = archiveStream(input, run);
    streaming = true;
    return reply
      .header("content-type", "application/zip")
      .header(
        "content-disposition",
        `attachment; filename="klorn-vault-${localDate(now, timeZone)}.zip"`,
      )
      .header("cache-control", "no-store")
      .header("x-content-type-options", "nosniff")
      .send(stream);
  } finally {
    if (!streaming) void run.finish("error");
  }
}

export async function vaultExportRoutes(app: FastifyInstance) {
  app.addHook("onRequest", darkRouteGate(vaultExportLive));

  // GET /api/user/me/vault/export — the user's own data, never stored.
  app.get(
    "/export",
    {
      preHandler: [requireAuth, cohortGate(VAULT_EXPORT_FLAGS)],
      schema: { querystring: querySchema },
    },
    exportHandler,
  );
}
