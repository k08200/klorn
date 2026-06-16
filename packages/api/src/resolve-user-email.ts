import { prisma } from "./db.js";

/**
 * Resolve a user's own email address (for self-email detection in sync/
 * summarize). Shared leaf so both email-sync.ts and email-summarize.ts can use
 * it without importing each other.
 */
export async function resolveUserEmail(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  return user?.email ?? null;
}
