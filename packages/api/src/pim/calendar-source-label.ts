/**
 * Which account a linked calendar row comes from (step C7), as the wire says it:
 * `sourceLabel`, the linked account's email, on a linked row only. A client shows
 * it next to a read-only event, or "Linked" when a row has none.
 *
 * One lookup for all rows of a response, scoped to the user and to the ids the
 * rows name, and none at all when no row is linked: while the linked sync is off
 * no linked row is returned, so the primary calendar's JSON is byte-identical to
 * before. The label is cosmetic, so a failed lookup drops the labels and never the list.
 */

import { prisma } from "../db.js";

interface LinkedRowShape {
  readonly sourceAccountId?: string | null;
}

function linkedAccountIds(rows: readonly LinkedRowShape[]): string[] {
  const ids = rows.flatMap((row) => (row.sourceAccountId ? [row.sourceAccountId] : []));
  return [...new Set(ids)];
}

async function emailsById(userId: string, ids: readonly string[]): Promise<Map<string, string>> {
  try {
    const accounts = await prisma.linkedCalendarAccount.findMany({
      where: { userId, id: { in: [...ids] } },
      select: { id: true, email: true },
    });
    return new Map(accounts.map((account) => [account.id, account.email]));
  } catch (err) {
    console.warn("[CALENDAR] source label lookup failed:", err);
    return new Map();
  }
}

export async function withSourceLabels<T extends LinkedRowShape>(
  userId: string,
  rows: readonly T[],
): Promise<Array<T | (T & { sourceLabel: string })>> {
  const ids = linkedAccountIds(rows);
  if (ids.length === 0) return [...rows];
  const emails = await emailsById(userId, ids);
  return rows.map((row) => {
    const label = row.sourceAccountId ? emails.get(row.sourceAccountId) : undefined;
    return label === undefined ? row : { ...row, sourceLabel: label };
  });
}
