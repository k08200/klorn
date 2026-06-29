/**
 * Pin the Postgres session time zone to UTC via the connection URL.
 *
 * The Prisma schema has no `@db.Timestamptz` columns — every DateTime maps to a
 * timezone-naive `timestamp(3)`. Prisma client reads/writes are UTC-consistent,
 * but the raw-SQL `NOW()` / `CURRENT_TIMESTAMP` writes (email-candidate-intake,
 * email-attachments) cast a `timestamptz` into a naive timestamp using the DB
 * SESSION time zone — so a non-UTC session would silently store wall-clock-
 * shifted instants that Prisma later reads back as UTC. Pinning the session to
 * UTC removes that drift without a column-type migration.
 *
 * Implemented with the Postgres `options` connection parameter (supported by
 * Prisma for PostgreSQL). No-op when the URL is empty, not postgres, or already
 * sets `options=`/a timezone. NOTE: a transaction-mode pooler (PgBouncer) can
 * ignore startup options — verify `SHOW timezone` returns UTC in such a deploy.
 */
export function withUtcSessionTimeZone(url: string | undefined): string | undefined {
  if (!url) return url;
  if (!/^postgres(ql)?:\/\//i.test(url)) return url;
  if (/[?&]options=/i.test(url) || /[?&]timezone=/i.test(url)) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}options=${encodeURIComponent("-c timezone=UTC")}`;
}
