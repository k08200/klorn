/**
 * A `linkedInboxAccount.findFirst` stand-in that evaluates the filters
 * billing/mail-account-entitlement.ts builds (userId, provider / provider.not,
 * NOT, email.equals case-insensitive) against a list of rows, so route tests
 * can say "the user owns these rows" instead of scripting call order.
 */

export interface LinkedRowFixture {
  id: string;
  userId?: string;
  provider: string;
  email: string;
}

type Where = Record<string, unknown>;

function matches(row: LinkedRowFixture, where: Where): boolean {
  if (where.userId !== undefined && (row.userId ?? where.userId) !== where.userId) return false;
  if (where.NOT && matches(row, where.NOT as Where)) return false;
  const provider = where.provider as unknown;
  if (typeof provider === "string" && row.provider !== provider) return false;
  if (provider && typeof provider === "object" && "not" in provider) {
    if (row.provider === (provider as { not: string }).not) return false;
  }
  const email = where.email as unknown;
  if (typeof email === "string" && row.email !== email) return false;
  if (email && typeof email === "object" && "equals" in email) {
    const wanted = String((email as { equals: string }).equals).toLowerCase();
    if (row.email.toLowerCase() !== wanted) return false;
  }
  return true;
}

/** findFirst over `rows()` (read on every call, so a test can change them mid-request). */
export function linkedRowsFindFirst(rows: () => readonly LinkedRowFixture[]) {
  return async (args?: unknown) => {
    const where = ((args as { where?: Where } | undefined)?.where ?? {}) as Where;
    const row = rows().find((r) => matches(r, where));
    return row ? { id: row.id, email: row.email, imapHost: null } : null;
  };
}
