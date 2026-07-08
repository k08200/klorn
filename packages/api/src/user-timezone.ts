/**
 * The user's configured IANA timezone (defaults to the product default).
 * Third caller of this exact lookup — calendar.ts and proactive-actions.ts
 * each carried their own private copy with a comment saying "extract to a
 * shared util if a third caller appears." agent-context.ts and event-parse.ts
 * are that third+fourth caller (#755, #756).
 */

import { prisma } from "./db.js";
import { normalizeTimeZone } from "./time-zone.js";

export async function getUserTimeZone(userId: string): Promise<string> {
  const config = await prisma.automationConfig.findUnique({
    where: { userId },
    select: { timezone: true },
  });
  return normalizeTimeZone(config?.timezone);
}
