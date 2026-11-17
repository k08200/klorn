/**
 * KakaoImport rows (docs/providers/kakaotalk-import.md §5): one per uploaded
 * export, holding counts and timestamps only, plus the in-window messages
 * awaiting processing. Every query is scoped to the session user.
 */

import { kakaoImportOpenTo } from "../config.js";
import { INTERACTIVE_TX_OPTIONS, prisma } from "../db.js";
import { logDbFailure } from "../report-db-failure.js";
import { deleteKakaoImportCommitments } from "./commitments.js";
import type { KakaoFormat } from "./parse.js";
import type { KakaoTimedMessage, KakaoWindow } from "./window.js";

/** Imports a user keeps at once; deleting one frees a slot. */
export const KAKAO_MAX_IMPORTS_PER_USER = 20;
/**
 * Imports of one user waiting or being read at once: each holds up to 2,000
 * messages of stored text, and the processing queue is shared by everyone.
 */
export const KAKAO_MAX_ACTIVE_IMPORTS_PER_USER = 2;

export type KakaoImportStatus = "PENDING" | "PROCESSING" | "DONE" | "FAILED";

export interface KakaoImportSummary {
  readonly id: string;
  readonly status: KakaoImportStatus;
  readonly format: string;
  readonly totalMessages: number;
  readonly windowMessages: number;
  readonly speakerCount: number;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly candidatesFound: number;
  readonly commitmentsCreated: number;
  readonly duplicatesSkipped: number;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly processedAt: string | null;
}

const SUMMARY_SELECT = {
  id: true,
  status: true,
  format: true,
  totalMessages: true,
  windowMessages: true,
  speakerCount: true,
  windowStart: true,
  windowEnd: true,
  candidatesFound: true,
  commitmentsCreated: true,
  duplicatesSkipped: true,
  errorCode: true,
  createdAt: true,
  processedAt: true,
} as const;

interface SummaryRow {
  id: string;
  status: string;
  format: string;
  totalMessages: number;
  windowMessages: number;
  speakerCount: number;
  windowStart: Date;
  windowEnd: Date;
  candidatesFound: number;
  commitmentsCreated: number;
  duplicatesSkipped: number;
  errorCode: string | null;
  createdAt: Date;
  processedAt: Date | null;
}

function toSummary(row: SummaryRow): KakaoImportSummary {
  return {
    ...row,
    status: row.status as KakaoImportStatus,
    windowStart: row.windowStart.toISOString(),
    windowEnd: row.windowEnd.toISOString(),
    createdAt: row.createdAt.toISOString(),
    processedAt: row.processedAt?.toISOString() ?? null,
  };
}

export interface NewKakaoImport {
  readonly userId: string;
  readonly format: KakaoFormat;
  readonly totalMessages: number;
  readonly speakerCount: number;
  readonly window: KakaoWindow;
  /** The in-window text messages (window.ts selectWindowMessages). */
  readonly messages: readonly KakaoTimedMessage[];
  /** The speaker name the user picked as their own. */
  readonly me: string;
}

export type CreateKakaoImportResult =
  | { readonly ok: true; readonly summary: KakaoImportSummary }
  | { readonly ok: false; readonly reason: "too-many-imports" | "import-in-progress" };

/** Whether the user may add an import now (the caps above). */
async function refusal(userId: string): Promise<"too-many-imports" | "import-in-progress" | null> {
  const [kept, active] = await Promise.all([
    prisma.kakaoImport.count({ where: { userId } }),
    prisma.kakaoImport.count({ where: { userId, status: { in: ["PENDING", "PROCESSING"] } } }),
  ]);
  if (kept >= KAKAO_MAX_IMPORTS_PER_USER) return "too-many-imports";
  return active >= KAKAO_MAX_ACTIVE_IMPORTS_PER_USER ? "import-in-progress" : null;
}

/**
 * Store an import and its in-window messages for the processing pass, unless
 * a cap refuses it. An import with nothing in its window is done at once:
 * there is nothing to store or process. (The caps are read before the write,
 * so two concurrent uploads can each pass them; the per-user rate limit and
 * the upload slots bound that to a few rows over.)
 */
export async function createKakaoImport(input: NewKakaoImport): Promise<CreateKakaoImportResult> {
  const refused = await refusal(input.userId);
  if (refused !== null) return { ok: false, reason: refused };
  const empty = input.messages.length === 0;
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.kakaoImport.create({
      data: {
        userId: input.userId,
        status: empty ? "DONE" : "PENDING",
        format: input.format,
        totalMessages: input.totalMessages,
        windowMessages: input.messages.length,
        speakerCount: input.speakerCount,
        windowStart: input.window.start,
        windowEnd: input.window.end,
        processedAt: empty ? new Date() : null,
      },
      select: SUMMARY_SELECT,
    });
    if (!empty) {
      await tx.kakaoImportMessage.createMany({
        data: input.messages.map((message, seq) => ({
          userId: input.userId,
          importId: created.id,
          seq,
          sentAt: message.sentAt,
          speaker: message.speaker,
          fromMe: message.speaker === input.me,
          text: message.text,
        })),
      });
    }
    return created;
  }, INTERACTIVE_TX_OPTIONS);
  return { ok: true, summary: toSummary(row) };
}

export async function listKakaoImports(userId: string): Promise<KakaoImportSummary[]> {
  const rows = await prisma.kakaoImport.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: KAKAO_MAX_IMPORTS_PER_USER,
    select: SUMMARY_SELECT,
  });
  return rows.map(toSummary);
}

/**
 * Does the user have any import, in any status? Decides whether the list and
 * the delete stay open to them while the flag is closed (routes/kakao-import.ts).
 */
export async function hasKakaoImport(userId: string): Promise<boolean> {
  const row = await prisma.kakaoImport.findFirst({ where: { userId }, select: { id: true } });
  return row !== null;
}

/**
 * /me's `kakaoImportWayOut`: the import is closed to this user, but they own an
 * import, so Settings shows the list and delete only (the API's way out). No
 * lookup while the import is open to them. A database failure answers false,
 * logged: /me answers 401 to anything that throws, which signs the client out.
 */
export async function kakaoImportWayOut(userId: string): Promise<boolean> {
  if (kakaoImportOpenTo(userId)) return false;
  try {
    return await hasKakaoImport(userId);
  } catch (err) {
    logDbFailure("[KAKAO] /me way-out lookup failed", err, { ids: { userId } });
    return false;
  }
}

export async function getKakaoImport(
  userId: string,
  id: string,
): Promise<KakaoImportSummary | null> {
  const row = await prisma.kakaoImport.findFirst({
    where: { id, userId },
    select: SUMMARY_SELECT,
  });
  return row ? toSummary(row) : null;
}

/**
 * "Delete this import": every commitment it made first, then the row and its
 * stored messages (cascade). In that order a failure leaves the row, so the
 * user can retry; a retry after the row is gone would have nothing to find.
 * A processing pass that is mid-run finds the row gone and deletes what it
 * made after this (process.ts).
 */
export async function deleteKakaoImport(userId: string, id: string): Promise<boolean> {
  const row = await prisma.kakaoImport.findFirst({ where: { id, userId }, select: { id: true } });
  if (row === null) return false;
  await deleteKakaoImportCommitments(userId, id);
  await prisma.kakaoImport.deleteMany({ where: { id, userId } });
  return true;
}
