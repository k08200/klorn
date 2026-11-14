/** Postgres unique_violation as Prisma surfaces it (P2002 from a model call). */
export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, meta } = err as { code?: unknown; meta?: { code?: unknown } };
  return code === "P2002" || (code === "P2010" && meta?.code === "23505");
}
