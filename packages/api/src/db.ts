import { PrismaClient } from "@prisma/client";
import { withUtcSessionTimeZone } from "./db-url.js";

// Pin the DB session to UTC so timezone-naive timestamp columns never drift
// under a non-UTC session (see db-url.ts).
const databaseUrl = withUtcSessionTimeZone(process.env.DATABASE_URL);

export const prisma = databaseUrl
  ? new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  : new PrismaClient();

/**
 * Options for every INTERACTIVE prisma.$transaction(callback) call site.
 *
 * An interactive transaction must acquire a DEDICATED pool connection within
 * `maxWait` — and Prisma's default (2s) is far stricter than the ~10s queue
 * plain queries get. On the small prod pool, concurrent firewall/sync reads
 * hold every connection for seconds, so interactive transactions died with
 * P2028 while ordinary queries survived (firewall override outage, #845).
 * Prefer the batch `$transaction([...])` form when the writes are independent;
 * when the callback genuinely needs intermediate results, pass these options
 * so the transaction queues for a connection like any other query.
 */
export const INTERACTIVE_TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 } as const;

// `db` is a historical alias for the same client. It used to be cast to
// `Record<string, ...>` to bypass Prisma models that weren't in the generated
// types yet; the client is now fully generated, so this is a plain typed
// re-export and every `db.*` call site gets full compile-time types again.
// Prefer importing `prisma` directly in new code.
export const db = prisma;
