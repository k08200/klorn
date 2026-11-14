/**
 * Klorn Vault download (VAULT_EXPORT_ENABLED, off by default; `cohort` opens
 * it to ROLLOUT_COHORT_USER_IDS only):
 *
 *   GET /api/user/me/vault/export[?bodies=1]
 *
 * Streams the user's own Klorn data as an Obsidian-compatible markdown zip
 * (vault/vault-export.ts). Mail text only with bodies=1. The archive is built
 * as it streams and stored nowhere: no file, no row, no cache.
 *
 * While the flag is off the route answers Fastify's default 404 before any
 * auth (darkRouteGate); in cohort mode a user outside it gets the same 404
 * after auth (cohortGate). Then, in order: one export per user at a time and
 * MAX_CONCURRENT_EXPORTS per process (429 / 503), one per user per
 * VAULT_EXPORT_COOLDOWN_MS (429 with retryAfterSeconds, from the audit table),
 * and an audit row settled when the stream ends however it ends.
 */

import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { VAULT_EXPORT_FLAG, vaultExportLive } from "../config.js";
import { readerLanguageFor } from "../notify/request-language.js";
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
 * The archive, audited: the slot is released and the audit row settled
 * exactly once, when the stream ends, fails, or the client goes away (the
 * response's close covers a stream that never started).
 */
function auditedStream(
  input: VaultExportInput,
  run: { auditId: string; slot: ExportSlot },
  reply: FastifyReply,
): Readable {
  const progress = newVaultProgress();
  let settled = false;
  const settle = (outcome: ExportEnd["outcome"]): Promise<void> => {
    if (settled) return Promise.resolve();
    settled = true;
    run.slot.release();
    return recordExportEnd(run.auditId, input.userId, {
      outcome,
      noteCount: progress.notes,
      byteCount: progress.bytes,
    });
  };
  reply.raw.once("close", () => void settle("aborted"));

  async function* chunks(): AsyncGenerator<Buffer> {
    let outcome: ExportEnd["outcome"] = "aborted";
    try {
      yield* vaultArchive(input, progress);
      outcome = progress.partial ? "partial" : "ok";
    } catch (err) {
      outcome = "error";
      console.error("[VAULT-EXPORT] export failed:", err instanceof Error ? err.name : "unknown");
      throw err;
    } finally {
      await settle(outcome);
    }
  }
  return Readable.from(chunks(), { objectMode: false });
}

async function exportHandler(request: FastifyRequest, reply: FastifyReply) {
  const userId = getUserId(request);
  const includeBodies = (request.query as { bodies?: string }).bodies === "1";
  const slot = acquireExportSlot(userId);
  if (slot === "user-busy") return reply.code(429).send(IN_PROGRESS);
  if (slot === "server-busy") return reply.code(503).send(SERVER_BUSY);

  let streaming = false;
  try {
    const now = new Date();
    const waitMs = await cooldownRemainingMs(userId, now);
    if (waitMs > 0) {
      const retryAfterSeconds = Math.ceil(waitMs / MS_PER_SECOND);
      reply.header("retry-after", String(retryAfterSeconds));
      return reply.code(429).send({
        error: COOLDOWN_MESSAGE,
        code: "rate-limited",
        retryable: true,
        retryAfterSeconds,
      });
    }
    const [language, timeZone] = await Promise.all([
      readerLanguageFor(request, reply, userId),
      getUserTimeZone(userId),
    ]);
    const auditId = await recordExportStart(userId, includeBodies);
    const input: VaultExportInput = {
      userId,
      includeBodies,
      language,
      timeZone,
      now,
      limits: VAULT_LIMITS,
    };
    const stream = auditedStream(input, { auditId, slot }, reply);
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
    if (!streaming) slot.release();
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
