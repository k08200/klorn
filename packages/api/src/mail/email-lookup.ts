/**
 * The one way a tool turns an `email_id` argument into the caller's OWN email row
 * (mark_read, set_tier and create_draft). The id may be Klorn's row id or the
 * provider's message id (`EmailMessage.gmailId`), and the lookup is always scoped to
 * the user, so an id that belongs to someone else can never resolve.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

/**
 * Longest email id accepted as an argument. The same bound as the MCP audit's
 * `targetId` (mcp/write-audit.ts), so an id that is accepted can also be recorded;
 * a test keeps the two equal.
 */
export const MAX_EMAIL_ID_LENGTH = 256;

/** The trimmed id, or null when `raw` is not a non-empty string of at most MAX_EMAIL_ID_LENGTH. */
export function parseEmailIdArg(raw: unknown): string | null {
  const id = typeof raw === "string" ? raw.trim() : "";
  return id.length === 0 || id.length > MAX_EMAIL_ID_LENGTH ? null : id;
}

/** `where` for the caller's own row, by Klorn id OR provider id. */
export function userEmailWhere(userId: string, emailId: string) {
  return { userId, OR: [{ id: emailId }, { gmailId: emailId }] };
}

/** The caller's own email row for `emailId`, with only the `select`ed columns; null when there is none. */
export function findUserEmail<S extends Prisma.EmailMessageSelect>(
  userId: string,
  emailId: string,
  select: S,
) {
  return prisma.emailMessage.findFirst({ where: userEmailWhere(userId, emailId), select });
}
