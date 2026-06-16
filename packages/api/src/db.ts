import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

// `db` is a historical alias for the same client. It used to be cast to
// `Record<string, ...>` to bypass Prisma models that weren't in the generated
// types yet; the client is now fully generated, so this is a plain typed
// re-export and every `db.*` call site gets full compile-time types again.
// Prefer importing `prisma` directly in new code.
export const db = prisma;
