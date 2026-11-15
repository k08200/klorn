/**
 * Who exported what, when, and the export's two guards (routes/vault-export.ts):
 *
 *   slot      at most one export per user and MAX_CONCURRENT_EXPORTS per
 *             process at a time, taken synchronously so two requests cannot
 *             both pass. In memory: the process that streams is the one that
 *             holds it, and it is released when the stream ends however it ends.
 *   cooldown  one export per user per VAULT_EXPORT_COOLDOWN_MS, read from the
 *             audit table, so it holds across restarts and deploys. A row
 *             that ended in `error` (the server's fault) does not count.
 *   audit     a DataExportAudit row per export: format, whether mail text was
 *             asked for, outcome and counts. Never the content; the archive
 *             is streamed and kept nowhere.
 */

import { prisma } from "../db.js";

export const VAULT_EXPORT_FORMAT = "vault-markdown";
export const VAULT_EXPORT_COOLDOWN_MS = 10 * 60 * 1000;
export const MAX_CONCURRENT_EXPORTS = 2;

export type ExportOutcome = "started" | "ok" | "partial" | "aborted" | "error";
export type SlotRefusal = "user-busy" | "server-busy";

export interface ExportSlot {
  release(): void;
}

const running = new Set<string>();

/** Takes the user's export slot, or says why not. Synchronous on purpose. */
export function acquireExportSlot(userId: string): ExportSlot | SlotRefusal {
  if (running.has(userId)) return "user-busy";
  if (running.size >= MAX_CONCURRENT_EXPORTS) return "server-busy";
  running.add(userId);
  let held = true;
  return {
    release() {
      if (!held) return;
      held = false;
      running.delete(userId);
    },
  };
}

/** Milliseconds until the user may export again (0: now). */
export async function cooldownRemainingMs(userId: string, now: Date): Promise<number> {
  const last = await prisma.dataExportAudit.findFirst({
    // A server-side failure does not cost the user their next try; an aborted
    // one does, or start-then-drop would sidestep the cooldown.
    where: {
      userId,
      createdAt: { gt: new Date(now.getTime() - VAULT_EXPORT_COOLDOWN_MS) },
      outcome: { not: "error" },
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (!last) return 0;
  return Math.max(0, last.createdAt.getTime() + VAULT_EXPORT_COOLDOWN_MS - now.getTime());
}

/** The audit row of an export about to stream; its id settles it later. */
export async function recordExportStart(userId: string, includeBodies: boolean): Promise<string> {
  const row = await prisma.dataExportAudit.create({
    data: { userId, format: VAULT_EXPORT_FORMAT, includeBodies, outcome: "started" },
    select: { id: true },
  });
  return row.id;
}

export interface ExportEnd {
  outcome: Exclude<ExportOutcome, "started">;
  noteCount: number;
  byteCount: number;
}

/**
 * Settles the audit row. Never throws: the user already has (or lost) the
 * stream, and a failed settle leaves the row `started`, which still counts
 * for the cooldown. The failure is logged without user content.
 */
export async function recordExportEnd(id: string, userId: string, end: ExportEnd): Promise<void> {
  try {
    await prisma.dataExportAudit.updateMany({
      where: { id, userId },
      data: { ...end, finishedAt: new Date() },
    });
  } catch (err) {
    console.error(
      "[VAULT-EXPORT] audit settle failed:",
      err instanceof Error ? err.name : "unknown",
    );
  }
}
