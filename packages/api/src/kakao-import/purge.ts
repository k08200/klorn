/**
 * KakaoTalk import retention (docs/providers/kakaotalk-import.md §5): stored
 * message text is deleted when its import is processed, and in any case 7 days
 * after upload; an import still waiting by then is marked `expired`. Run from
 * the import scheduler whatever KAKAO_IMPORT_ENABLED or LOG_RETENTION_ENABLED
 * say, so turning the flag off never stops uploaded text from expiring.
 */

import { prisma } from "../db.js";

export const KAKAO_MESSAGE_RETENTION_DAYS = 7;
export const KAKAO_ERROR_EXPIRED = "expired";
const DAY_MS = 86_400_000;

export async function purgeExpiredKakaoImportText(
  now: Date = new Date(),
): Promise<{ messages: number; expired: number }> {
  const cutoff = new Date(now.getTime() - KAKAO_MESSAGE_RETENTION_DAYS * DAY_MS);
  const messages = await prisma.kakaoImportMessage.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  const expired = await prisma.kakaoImport.updateMany({
    where: { status: { in: ["PENDING", "PROCESSING"] }, createdAt: { lt: cutoff } },
    data: { status: "FAILED", errorCode: KAKAO_ERROR_EXPIRED, claimedAt: null },
  });
  return { messages: messages.count, expired: expired.count };
}
