/**
 * Re-judge a user's OPEN email firewall items with the CURRENT classifier.
 * Thin CLI over judge/rejudge-open-items.ts (see there for the rules: a human
 * override or an MCP agent's lane is counted as kept and never overwritten, no
 * notifications are sent, terminal decisions are preserved).
 *
 * Usage:
 *   DRY-RUN (default):  pnpm tsx src/scripts/rejudge-open-email-items.ts <userId | email>
 *   APPLY:              CONFIRM=1 pnpm tsx src/scripts/rejudge-open-email-items.ts <userId | email>
 *   Optional: LIMIT=50 to cap how many items are processed (default: all OPEN).
 *
 * Each unprotected item still costs one judge model call in BOTH dry-run and
 * apply (the preview computes the real new tier).
 */

import { prisma } from "../db.js";
import { rejudgeOpenEmailItems } from "../judge/rejudge-open-items.js";

async function resolveUserId(arg: string): Promise<string | null> {
  if (arg.includes("@")) {
    const user = await prisma.user.findUnique({ where: { email: arg }, select: { id: true } });
    return user?.id ?? null;
  }
  return arg;
}

async function main() {
  const arg = process.argv[2];
  const confirm = process.env.CONFIRM === "1";
  const limit = process.env.LIMIT ? Number.parseInt(process.env.LIMIT, 10) : undefined;
  if (!arg) {
    console.error(
      "Usage: rejudge-open-email-items.ts <userId | email>  (set CONFIRM=1 to apply, LIMIT=N to cap)",
    );
    process.exit(1);
  }

  const userId = await resolveUserId(arg);
  if (!userId) {
    console.error(`No user found for "${arg}".`);
    process.exit(1);
  }

  const { changed, kept, missing, transitions } = await rejudgeOpenEmailItems(userId, {
    confirm,
    limit,
    log: console.log,
  });

  console.log(
    `\nSummary: ${changed} tier change(s)${missing ? `, ${missing} item(s) with no EmailMessage (skipped)` : ""}${kept ? `, ${kept} item(s) kept (human override or agent lane)` : ""}.`,
  );
  for (const [key, count] of [...transitions.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key}: ${count}`);
  }
  if (!confirm) {
    console.log(
      "\nDRY RUN — re-run with CONFIRM=1 to write the refreshed tiers (no notifications are sent).",
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
