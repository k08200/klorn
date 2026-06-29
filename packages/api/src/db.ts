import { PrismaClient } from "@prisma/client";
import { withUtcSessionTimeZone } from "./db-url.js";

// Pin the DB session to UTC so timezone-naive timestamp columns never drift
// under a non-UTC session (see db-url.ts).
const databaseUrl = withUtcSessionTimeZone(process.env.DATABASE_URL);

export const prisma = databaseUrl
  ? new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  : new PrismaClient();

// `db` is a historical alias for the same client. It used to be cast to
// `Record<string, ...>` to bypass Prisma models that weren't in the generated
// types yet; the client is now fully generated, so this is a plain typed
// re-export and every `db.*` call site gets full compile-time types again.
// Prefer importing `prisma` directly in new code.
export const db = prisma;
